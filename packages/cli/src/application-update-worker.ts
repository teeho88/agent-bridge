import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type ApplicationUpdateProgress,
  type CommandRunner,
  type UpdateWorkerPayload,
  runBoundedCommand,
  updatePaths,
} from "./application-update.js";

export interface UpdateWorkerDependencies {
  runner?: CommandRunner;
  spawnDetached?: (file: string, args: string[], cwd: string) => void;
}

function appendLog(path: string, message: string): void {
  appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function progressWriter(payload: UpdateWorkerPayload, logFile: string) {
  const paths = updatePaths(payload.root);
  const initial = existsSync(paths.progress)
    ? (JSON.parse(readFileSync(paths.progress, "utf8")) as ApplicationUpdateProgress)
    : undefined;
  const startedAt = initial?.startedAt ?? new Date().toISOString();
  return (state: ApplicationUpdateProgress["state"], step: string, error?: string): ApplicationUpdateProgress => {
    const value: ApplicationUpdateProgress = {
      id: payload.id,
      state,
      step,
      startedAt,
      updatedAt: new Date().toISOString(),
      fromVersion: payload.oldVersion,
      targetVersion: payload.targetVersion,
      targetTag: payload.targetTag,
      ...(error ? { error } : {}),
      logFile: relative(payload.root, logFile).replace(/\\/g, "/"),
    };
    writeFileSync(paths.progress, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return value;
  };
}

async function runChecked(
  runner: CommandRunner,
  file: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  logFile: string,
): Promise<string> {
  appendLog(logFile, `${file} ${args.join(" ")}`);
  const result = await runner(file, args, { cwd, timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.trim()) appendLog(logFile, result.stdout.trim());
  if (result.stderr.trim()) appendLog(logFile, result.stderr.trim());
  if (result.code !== 0) {
    throw new Error(`${file} ${args[0] ?? ""} failed with exit code ${result.code}.`);
  }
  return result.stdout.trim();
}

function defaultSpawnDetached(file: string, args: string[], cwd: string): void {
  const child = spawn(file, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopUiProcess(pid: number | undefined): Promise<void> {
  if (!pid || pid === process.pid || !processExists(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

async function restartUi(
  payload: UpdateWorkerPayload,
  root: string,
  spawnDetached: (file: string, args: string[], cwd: string) => void,
): Promise<void> {
  if (!payload.workspace || !payload.port) return;
  await stopUiProcess(payload.uiPid);
  spawnDetached(
    process.execPath,
    [
      join(root, "packages", "cli", "dist", "index.js"),
      "ui",
      "--project",
      payload.workspace,
      "--port",
      String(payload.port),
    ],
    root,
  );
}

export async function runApplicationUpdateWorker(
  payload: UpdateWorkerPayload,
  dependencies: UpdateWorkerDependencies = {},
): Promise<ApplicationUpdateProgress> {
  const root = resolve(payload.root);
  const paths = updatePaths(root);
  const logFile = join(paths.directory, `update-${payload.id}.log`);
  const writeProgress = progressWriter(payload, logFile);
  const runner = dependencies.runner ?? runBoundedCommand;
  const spawnDetached = dependencies.spawnDetached ?? defaultSpawnDetached;
  let moved = false;
  let ownsLock = false;

  try {
    const lock = JSON.parse(readFileSync(paths.lock, "utf8")) as { id?: unknown };
    if (lock.id !== payload.id) throw new Error("Update lock belongs to another update.");
    ownsLock = true;
    writeProgress("fetching", `Fetching ${payload.targetTag}`);
    await runChecked(runner, "git", ["fetch", payload.remote, payload.remoteBranch], root, 60_000, logFile);
    await runChecked(runner, "git", ["fetch", payload.remote, "tag", payload.targetTag], root, 60_000, logFile);
    const fetchedCommit = await runChecked(
      runner,
      "git",
      ["rev-parse", `${payload.targetTag}^{commit}`],
      root,
      20_000,
      logFile,
    );
    if (fetchedCommit !== payload.targetCommit) {
      throw new Error(`Fetched tag ${payload.targetTag} no longer resolves to the checked target commit.`);
    }

    writeProgress("fast-forwarding", `Fast-forwarding to ${payload.targetTag}`);
    await runChecked(runner, "git", ["merge", "--ff-only", payload.targetCommit], root, 60_000, logFile);
    moved = true;

    writeProgress("installing", "Installing dependencies");
    await runChecked(runner, "corepack", ["pnpm", "install", "--frozen-lockfile"], root, 15 * 60_000, logFile);
    writeProgress("building", "Building Agent Bridge");
    await runChecked(runner, "corepack", ["pnpm", "-r", "build"], root, 15 * 60_000, logFile);
    writeProgress("smoke-testing", "Verifying updated CLI version");
    const version = await runChecked(
      runner,
      process.execPath,
      [join(root, "packages", "cli", "dist", "index.js"), "--version"],
      root,
      60_000,
      logFile,
    );
    if (version !== payload.targetVersion) {
      throw new Error(`Updated CLI reported ${version || "(empty)"}; expected ${payload.targetVersion}.`);
    }

    writeProgress("restart-required", "Updated successfully; restarting Work Board if requested");
    await restartUi(payload, root, spawnDetached);
    return writeProgress("complete", `Updated to ${payload.targetVersion}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(logFile, `ERROR: ${message}`);
    if (moved) {
      try {
        writeProgress("rolling-back", `Update failed; restoring ${payload.oldVersion}`, message);
        await runChecked(runner, "git", ["reset", "--hard", payload.oldCommit], root, 60_000, logFile);
        await runChecked(runner, "corepack", ["pnpm", "install", "--frozen-lockfile"], root, 15 * 60_000, logFile);
        await runChecked(runner, "corepack", ["pnpm", "-r", "build"], root, 15 * 60_000, logFile);
        const restored = await runChecked(
          runner,
          process.execPath,
          [join(root, "packages", "cli", "dist", "index.js"), "--version"],
          root,
          60_000,
          logFile,
        );
        if (restored !== payload.oldVersion) {
          throw new Error(`Rollback CLI reported ${restored || "(empty)"}; expected ${payload.oldVersion}.`);
        }
        await restartUi(payload, root, spawnDetached);
      } catch (rollbackError) {
        appendLog(
          logFile,
          `ROLLBACK ERROR: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    return writeProgress("failed", "Update failed; see update log for details", message);
  } finally {
    if (ownsLock) rmSync(paths.lock, { force: true });
  }
}

function parsePayload(raw: string | undefined): UpdateWorkerPayload {
  if (!raw) throw new Error("Missing update worker payload.");
  const parsed = JSON.parse(raw) as UpdateWorkerPayload;
  if (
    !parsed.id ||
    !parsed.root ||
    !parsed.oldCommit ||
    !parsed.oldVersion ||
    !parsed.targetCommit ||
    !parsed.targetTag ||
    !parsed.targetVersion ||
    !parsed.remote ||
    !parsed.remoteBranch
  ) {
    throw new Error("Invalid update worker payload.");
  }
  return parsed;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isEntryPoint) {
  runApplicationUpdateWorker(parsePayload(process.argv[2])).then((result) => {
    if (result.state === "failed") process.exitCode = 1;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
