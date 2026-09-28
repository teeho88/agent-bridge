import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openStore } from "./workspace.js";
import { applicationVersion, installationRoot, readApplicationVersion } from "./version.js";

export type ApplicationUpdateState =
  | "checking"
  | "current"
  | "available"
  | "updating"
  | "restart-required"
  | "dirty"
  | "diverged"
  | "offline"
  | "failed"
  | "unsupported";

export interface ApplicationUpdateStatus {
  installationMode: "git-source" | "unsupported";
  state: ApplicationUpdateState;
  currentVersion: string;
  currentCommit?: string;
  latestVersion?: string;
  latestTag?: string;
  latestCommit?: string;
  releaseNotes?: string[];
  checkedAt?: string;
  canApply: boolean;
  reason?: string;
}

export type UpdateProgressState =
  | "starting"
  | "fetching"
  | "fast-forwarding"
  | "installing"
  | "building"
  | "smoke-testing"
  | "restart-required"
  | "rolling-back"
  | "complete"
  | "failed";

export interface ApplicationUpdateProgress {
  id: string;
  state: UpdateProgressState;
  step: string;
  startedAt: string;
  updatedAt: string;
  fromVersion: string;
  targetVersion: string;
  targetTag: string;
  error?: string;
  logFile?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

const stableSemver = /^(\d+)\.(\d+)\.(\d+)$/;
const stableTag = /^v(\d+\.\d+\.\d+)$/;
export const UPDATE_CACHE_MS = 15 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const activeRunStatuses = new Set(["starting", "running", "waiting", "stopping"]);
const activeOrchestrationStatuses = new Set(["planning", "executing", "adjudicating", "reporting"]);

type CacheEntry = { at: number; status: ApplicationUpdateStatus };
const statusCache = new Map<string, CacheEntry>();
const pendingChecks = new Map<string, Promise<ApplicationUpdateStatus>>();

export function parseStableVersion(value: string): [number, number, number] | undefined {
  const match = stableSemver.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function stableVersionFromTag(tag: string): string | undefined {
  return stableTag.exec(tag)?.[1];
}

export function compareStableVersions(a: string, b: string): number {
  const left = parseStableVersion(a);
  const right = parseStableVersion(b);
  if (!left || !right) throw new Error(`Invalid stable SemVer comparison: ${a}, ${b}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function sortStableTags(tags: string[]): string[] {
  return tags
    .filter((tag) => stableVersionFromTag(tag))
    .sort((a, b) => compareStableVersions(stableVersionFromTag(b)!, stableVersionFromTag(a)!));
}

export async function runBoundedCommand(
  file: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code =
          typeof (error as NodeJS.ErrnoException & { code?: number | string } | null)?.code === "number"
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolveResult({
          code,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function git(
  root: string,
  args: readonly string[],
  runner: CommandRunner,
  allowFailure = false,
): Promise<CommandResult> {
  const result = await runner("git", args, { cwd: root });
  if (!allowFailure && result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited with ${result.code}`;
    throw new Error(detail);
  }
  return result;
}

function checkedAt(now = Date.now()): string {
  return new Date(now).toISOString();
}

function unsupported(currentVersion: string, reason: string, now?: number): ApplicationUpdateStatus {
  return {
    installationMode: "unsupported",
    state: "unsupported",
    currentVersion,
    checkedAt: checkedAt(now),
    canApply: false,
    reason,
  };
}

interface GitContext {
  currentCommit: string;
  branch?: string;
  remote: string;
  remoteBranch: string;
  upstreamRef: string;
  detached: boolean;
}

async function resolveGitContext(root: string, runner: CommandRunner): Promise<GitContext> {
  const currentCommit = (await git(root, ["rev-parse", "HEAD"], runner)).stdout.trim();
  const branchResult = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], runner, true);
  const detached = branchResult.code !== 0 || !branchResult.stdout.trim();
  const branch = detached ? undefined : branchResult.stdout.trim();
  const upstreamResult = await git(
    root,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    runner,
    true,
  );
  let upstreamRef = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : "";
  if (!upstreamRef) upstreamRef = "origin/main";
  const slash = upstreamRef.indexOf("/");
  if (slash <= 0 || slash === upstreamRef.length - 1) {
    throw new Error(`Unsupported upstream ref: ${upstreamRef}`);
  }
  return {
    currentCommit,
    branch,
    detached,
    remote: upstreamRef.slice(0, slash),
    remoteBranch: upstreamRef.slice(slash + 1),
    upstreamRef,
  };
}

async function latestReleasedTag(
  root: string,
  upstreamRef: string,
  runner: CommandRunner,
): Promise<{ version: string; tag: string; commit: string } | undefined> {
  const tags = sortStableTags(
    (await git(root, ["tag", "--list", "v*"], runner)).stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const tag of tags) {
    const version = stableVersionFromTag(tag)!;
    const commit = (await git(root, ["rev-list", "-n", "1", tag], runner)).stdout.trim();
    if (!commit) continue;
    const onReleaseBranch = await git(
      root,
      ["merge-base", "--is-ancestor", commit, upstreamRef],
      runner,
      true,
    );
    if (onReleaseBranch.code !== 0) continue;
    const packageResult = await git(root, ["show", `${tag}:package.json`], runner, true);
    if (packageResult.code !== 0) continue;
    try {
      const packageVersion = (JSON.parse(packageResult.stdout) as { version?: unknown }).version;
      if (packageVersion !== version) continue;
    } catch {
      continue;
    }
    return { version, tag, commit };
  }
  return undefined;
}

export async function checkApplicationUpdateStatus(options: {
  root?: string;
  runner?: CommandRunner;
  now?: number;
} = {}): Promise<ApplicationUpdateStatus> {
  const root = resolve(options.root ?? installationRoot());
  const runner = options.runner ?? runBoundedCommand;
  const now = options.now ?? Date.now();
  let currentVersion = applicationVersion;
  try {
    currentVersion = readApplicationVersion(root);
  } catch (error) {
    return unsupported(
      currentVersion,
      error instanceof Error ? error.message : String(error),
      now,
    );
  }
  if (!existsSync(join(root, ".git"))) {
    return unsupported(currentVersion, "Agent Bridge is not running from a Git source checkout.", now);
  }

  let context: GitContext;
  try {
    context = await resolveGitContext(root, runner);
  } catch (error) {
    return unsupported(
      currentVersion,
      `Cannot inspect installation Git checkout: ${error instanceof Error ? error.message : String(error)}`,
      now,
    );
  }

  const base: ApplicationUpdateStatus = {
    installationMode: "git-source",
    state: "checking",
    currentVersion,
    currentCommit: context.currentCommit,
    checkedAt: checkedAt(now),
    canApply: false,
  };

  const fetched = await git(root, ["fetch", "--tags", "--prune", context.remote], runner, true);
  if (fetched.code !== 0) {
    return {
      ...base,
      state: "offline",
      reason: fetched.stderr.trim() || fetched.stdout.trim() || "Remote Git fetch failed.",
    };
  }

  try {
    const latest = await latestReleasedTag(root, context.upstreamRef, runner);
    if (!latest || compareStableVersions(latest.version, currentVersion) <= 0) {
      return { ...base, state: "current" };
    }

    const common = {
      ...base,
      latestVersion: latest.version,
      latestTag: latest.tag,
      latestCommit: latest.commit,
    };
    const notesResult = await git(
      root,
      ["log", "--format=%s", "-n", "5", `${context.currentCommit}..${latest.commit}`],
      runner,
      true,
    );
    const releaseNotes =
      notesResult.code === 0
        ? notesResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        : [];

    const dirtyResult = await git(root, ["status", "--porcelain", "--untracked-files=normal"], runner);
    if (dirtyResult.stdout.trim()) {
      return {
        ...common,
        releaseNotes,
        state: "dirty",
        reason: "Installation checkout has tracked or untracked changes. Commit, stash, or remove them before updating.",
      };
    }

    if (context.detached || !context.branch || context.branch !== context.remoteBranch) {
      return {
        ...common,
        releaseNotes,
        state: "diverged",
        reason: context.detached
          ? "Installation checkout is on a detached HEAD."
          : `Local branch ${context.branch ?? "(unknown)"} does not match tracked release branch ${context.remoteBranch}.`,
      };
    }

    const fastForward = await git(
      root,
      ["merge-base", "--is-ancestor", context.currentCommit, latest.commit],
      runner,
      true,
    );
    if (fastForward.code !== 0) {
      return {
        ...common,
        releaseNotes,
        state: "diverged",
        reason: "Installation checkout has local commits or cannot fast-forward to the release.",
      };
    }

    return {
      ...common,
      releaseNotes,
      state: "available",
      canApply: true,
    };
  } catch (error) {
    return {
      ...base,
      state: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getApplicationUpdateStatus(options: {
  root?: string;
  force?: boolean;
  cacheMs?: number;
} = {}): Promise<ApplicationUpdateStatus> {
  const root = resolve(options.root ?? installationRoot());
  const cacheMs = options.cacheMs ?? UPDATE_CACHE_MS;
  const cached = statusCache.get(root);
  if (!options.force && cached && Date.now() - cached.at < cacheMs) return cached.status;
  const pending = pendingChecks.get(root);
  if (pending) return pending;
  const check = checkApplicationUpdateStatus({ root })
    .then((status) => {
      statusCache.set(root, { at: Date.now(), status });
      return status;
    })
    .finally(() => pendingChecks.delete(root));
  pendingChecks.set(root, check);
  return check;
}

export function peekApplicationUpdateStatus(root = installationRoot()): ApplicationUpdateStatus | undefined {
  return statusCache.get(resolve(root))?.status;
}

export function clearApplicationUpdateCache(): void {
  statusCache.clear();
  pendingChecks.clear();
}

export function updatePaths(root = installationRoot()): {
  directory: string;
  lock: string;
  progress: string;
} {
  const directory = join(root, ".agent-memory", "update");
  return {
    directory,
    lock: join(directory, "update.lock"),
    progress: join(directory, "progress.json"),
  };
}

export function readApplicationUpdateProgress(root = installationRoot()): ApplicationUpdateProgress | undefined {
  const { progress } = updatePaths(root);
  if (!existsSync(progress)) return undefined;
  try {
    return JSON.parse(readFileSync(progress, "utf8")) as ApplicationUpdateProgress;
  } catch {
    return undefined;
  }
}

export function workspaceUpdateBlockReason(workspace?: string): string | undefined {
  if (!workspace || !existsSync(join(workspace, ".agent-memory"))) return undefined;
  const store = openStore(workspace);
  try {
    const activeOrchestration = store
      .listOrchestrations({ limit: 500 })
      .find((item) => activeOrchestrationStatuses.has(item.status));
    if (activeOrchestration) {
      return `Orchestration ${activeOrchestration.id} is ${activeOrchestration.status}. Finish or pause it before restarting Agent Bridge.`;
    }
    const activeRun = store
      .listAgentRuns({ limit: 1000 })
      .find((item) => activeRunStatuses.has(item.status));
    if (activeRun) {
      return `Agent run ${activeRun.id} is ${activeRun.status}. Stop or finish it before restarting Agent Bridge.`;
    }
    return undefined;
  } finally {
    store.close();
  }
}

async function commandAvailable(
  file: string,
  args: readonly string[],
  root: string,
  runner: CommandRunner,
): Promise<boolean> {
  return (await runner(file, args, { cwd: root, timeoutMs: 10_000 })).code === 0;
}

export async function preflightApplicationUpdate(options: {
  root?: string;
  workspace?: string;
  refresh?: boolean;
  runner?: CommandRunner;
} = {}): Promise<ApplicationUpdateStatus> {
  const root = resolve(options.root ?? installationRoot());
  const runner = options.runner ?? runBoundedCommand;
  const paths = updatePaths(root);
  if (existsSync(paths.lock)) {
    return {
      installationMode: "git-source",
      state: "updating",
      currentVersion: readApplicationVersion(root),
      canApply: false,
      reason: "Another Agent Bridge update is already running.",
    };
  }
  const status = options.runner
    ? await checkApplicationUpdateStatus({ root, runner })
    : await getApplicationUpdateStatus({ root, force: options.refresh ?? true });
  if (status.state !== "available" || !status.canApply) return status;
  const workReason = workspaceUpdateBlockReason(options.workspace);
  if (workReason) return { ...status, canApply: false, reason: workReason };
  if (!(await commandAvailable(process.execPath, ["--version"], root, runner))) {
    return { ...status, canApply: false, reason: "Node.js is unavailable for the update worker." };
  }
  if (!(await commandAvailable("corepack", ["--version"], root, runner))) {
    return { ...status, canApply: false, reason: "Corepack is unavailable." };
  }
  if (!(await commandAvailable("corepack", ["pnpm", "--version"], root, runner))) {
    return { ...status, canApply: false, reason: "pnpm is unavailable through Corepack." };
  }
  return status;
}

export interface UpdateWorkerPayload {
  id: string;
  root: string;
  workspace?: string;
  port?: number;
  uiPid?: number;
  oldCommit: string;
  oldVersion: string;
  targetCommit: string;
  targetTag: string;
  targetVersion: string;
  remote: string;
  remoteBranch: string;
}

export interface StartedApplicationUpdate {
  id: string;
  status: ApplicationUpdateStatus;
  progress: ApplicationUpdateProgress;
}

export type WorkerSpawner = (payload: UpdateWorkerPayload) => void;

function defaultWorkerSpawner(payload: UpdateWorkerPayload): void {
  const workerPath = fileURLToPath(new URL("./application-update-worker.js", import.meta.url));
  const child = spawn(process.execPath, [workerPath, JSON.stringify(payload)], {
    cwd: payload.root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function writeInitialProgress(payload: UpdateWorkerPayload): ApplicationUpdateProgress {
  const paths = updatePaths(payload.root);
  mkdirSync(paths.directory, { recursive: true });
  const now = new Date().toISOString();
  const progress: ApplicationUpdateProgress = {
    id: payload.id,
    state: "starting",
    step: "Starting update worker",
    startedAt: now,
    updatedAt: now,
    fromVersion: payload.oldVersion,
    targetVersion: payload.targetVersion,
    targetTag: payload.targetTag,
  };
  writeFileSync(paths.progress, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  return progress;
}

export async function startApplicationUpdate(options: {
  root?: string;
  workspace?: string;
  port?: number;
  uiPid?: number;
  runner?: CommandRunner;
  spawnWorker?: WorkerSpawner;
} = {}): Promise<StartedApplicationUpdate> {
  const root = resolve(options.root ?? installationRoot());
  const runner = options.runner ?? runBoundedCommand;
  const status = await preflightApplicationUpdate({
    root,
    workspace: options.workspace,
    refresh: true,
    runner: options.runner,
  });
  if (status.state !== "available" || !status.canApply || !status.latestCommit || !status.latestTag || !status.latestVersion || !status.currentCommit) {
    throw Object.assign(new Error(status.reason ?? `Update cannot start while state is ${status.state}.`), { status });
  }
  const context = await resolveGitContext(root, runner);
  const id = randomUUID();
  const payload: UpdateWorkerPayload = {
    id,
    root,
    workspace: options.workspace ? resolve(options.workspace) : undefined,
    port: options.port,
    uiPid: options.uiPid,
    oldCommit: status.currentCommit,
    oldVersion: status.currentVersion,
    targetCommit: status.latestCommit,
    targetTag: status.latestTag,
    targetVersion: status.latestVersion,
    remote: context.remote,
    remoteBranch: context.remoteBranch,
  };
  const paths = updatePaths(root);
  mkdirSync(paths.directory, { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(paths.lock, "wx");
    writeFileSync(fd, `${JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
  } catch (error) {
    throw Object.assign(new Error("Another Agent Bridge update is already running."), {
      status: { ...status, state: "updating", canApply: false } satisfies ApplicationUpdateStatus,
      cause: error,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const progress = writeInitialProgress(payload);
  try {
    (options.spawnWorker ?? defaultWorkerSpawner)(payload);
  } catch (error) {
    rmSync(paths.lock, { force: true });
    throw error;
  }
  statusCache.set(root, {
    at: Date.now(),
    status: { ...status, state: "updating", canApply: false, reason: "Update worker started." },
  });
  return {
    id,
    status: statusCache.get(root)!.status,
    progress,
  };
}
