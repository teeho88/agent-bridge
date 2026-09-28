import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkApplicationUpdateStatus,
  clearApplicationUpdateCache,
  compareStableVersions,
  getApplicationUpdateStatus,
  preflightApplicationUpdate,
  runBoundedCommand,
  sortStableTags,
  startApplicationUpdate,
  updatePaths,
  type CommandRunner,
  type UpdateWorkerPayload,
} from "./application-update.js";
import { runApplicationUpdateWorker } from "./application-update-worker.js";

interface GitFixture {
  root: string;
  remote: string;
  publisher: string;
  install: string;
  oldCommit: string;
  targetCommit: string;
}

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeVersionTree(root: string, version: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "agent-bridge-test", version }, null, 2)}\n`,
    "utf8",
  );
  const dist = join(root, "packages", "cli", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, "index.js"),
    `if (process.argv.includes("--version")) console.log("${version}");\n`,
    "utf8",
  );
}

function commitAll(root: string, message: string): string {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function createGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-self-update-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const publisher = join(root, "publisher");
  const install = join(root, "install");
  mkdirSync(publisher, { recursive: true });

  git(root, "init", "--bare", remote);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(publisher, "init", "-b", "main");
  git(publisher, "config", "user.email", "agent-bridge@example.invalid");
  git(publisher, "config", "user.name", "Agent Bridge Tests");

  writeVersionTree(publisher, "0.1.0");
  writeFileSync(join(publisher, "release.txt"), "release 0.1.0\n", "utf8");
  const oldCommit = commitAll(publisher, "release 0.1.0");
  git(publisher, "tag", "v0.1.0");
  git(publisher, "remote", "add", "origin", remote);
  git(publisher, "push", "-u", "origin", "main");

  writeVersionTree(publisher, "0.2.0");
  writeFileSync(join(publisher, "release.txt"), "release 0.2.0\n", "utf8");
  const targetCommit = commitAll(publisher, "release 0.2.0");
  git(publisher, "tag", "v0.2.0");
  git(publisher, "tag", "v0.2.1-beta.1");
  git(publisher, "tag", "v9.9.9");
  git(publisher, "push", "origin", "main");

  git(publisher, "checkout", "-b", "side-release");
  writeVersionTree(publisher, "0.3.0");
  writeFileSync(join(publisher, "release.txt"), "side release 0.3.0\n", "utf8");
  commitAll(publisher, "side release 0.3.0");
  git(publisher, "tag", "v0.3.0");
  git(publisher, "checkout", "main");
  git(publisher, "push", "origin", "--tags");

  git(root, "clone", remote, install);
  git(install, "config", "user.email", "agent-bridge@example.invalid");
  git(install, "config", "user.name", "Agent Bridge Tests");
  git(install, "reset", "--hard", oldCommit);

  return { root, remote, publisher, install, oldCommit, targetCommit };
}

function updateRunner(buildFailure = false): {
  runner: CommandRunner;
  buildCalls: () => number;
} {
  let builds = 0;
  const runner: CommandRunner = async (file, args, options) => {
    if (file === "corepack") {
      if (args[0] === "pnpm" && args[1] === "-r" && args[2] === "build") {
        builds += 1;
        if (buildFailure && builds === 1) {
          return { code: 1, stdout: "", stderr: "simulated build failure" };
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return runBoundedCommand(file, args, options);
  };
  return { runner, buildCalls: () => builds };
}

beforeEach(() => clearApplicationUpdateCache());

afterEach(() => {
  clearApplicationUpdateCache();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("application update release selection", () => {
  it("sorts only stable SemVer tags", () => {
    expect(sortStableTags([
      "v0.2.0-beta.1",
      "v2.0.0",
      "v1.10.0",
      "v1.2.0",
      "v1.2",
      "release-3.0.0",
    ])).toEqual(["v2.0.0", "v1.10.0", "v1.2.0"]);
    expect(compareStableVersions("1.10.0", "1.2.9")).toBeGreaterThan(0);
  });

  it("detects the highest valid release on the tracked remote branch from the installation root", async () => {
    const fixture = createGitFixture();
    const unrelatedWorkspace = mkdtempSync(join(tmpdir(), "agent-bridge-workspace-"));
    roots.push(unrelatedWorkspace);
    writeFileSync(join(unrelatedWorkspace, "package.json"), '{"version":"7.7.7"}\n', "utf8");

    const status = await checkApplicationUpdateStatus({ root: fixture.install });

    expect(status.state).toBe("available");
    expect(status.currentVersion).toBe("0.1.0");
    expect(status.latestVersion).toBe("0.2.0");
    expect(status.latestTag).toBe("v0.2.0");
    expect(status.latestCommit).toBe(fixture.targetCommit);
    expect(status.canApply).toBe(true);
    expect(status.releaseNotes).toContain("release 0.2.0");
  });

  it("reports current when the checkout already matches the latest valid release", async () => {
    const fixture = createGitFixture();
    git(fixture.install, "reset", "--hard", "origin/main");

    const status = await checkApplicationUpdateStatus({ root: fixture.install });

    expect(status.state).toBe("current");
    expect(status.currentVersion).toBe("0.2.0");
    expect(status.canApply).toBe(false);
  });

  it("reports unsupported outside a Git source checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-no-git-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), '{"version":"0.1.0"}\n', "utf8");

    const status = await checkApplicationUpdateStatus({ root });

    expect(status.state).toBe("unsupported");
    expect(status.reason).toContain("Git source checkout");
  });
});

describe("application update safety", () => {
  it("blocks a dirty checkout and leaves the user's file unchanged", async () => {
    const fixture = createGitFixture();
    const userFile = join(fixture.install, "user-note.txt");
    writeFileSync(userFile, "keep me\n", "utf8");

    const status = await checkApplicationUpdateStatus({ root: fixture.install });

    expect(status.state).toBe("dirty");
    expect(status.canApply).toBe(false);
    expect(readFileSync(userFile, "utf8")).toBe("keep me\n");
    await expect(startApplicationUpdate({
      root: fixture.install,
      spawnWorker: () => {
        throw new Error("worker must not start");
      },
    })).rejects.toMatchObject({ status: { state: "dirty", canApply: false } });
    expect(readFileSync(userFile, "utf8")).toBe("keep me\n");
  });

  it("blocks detached HEAD and local divergence without moving HEAD", async () => {
    const detached = createGitFixture();
    git(detached.install, "checkout", "--detach", detached.oldCommit);
    const detachedHead = git(detached.install, "rev-parse", "HEAD");

    const detachedStatus = await checkApplicationUpdateStatus({ root: detached.install });

    expect(detachedStatus.state).toBe("diverged");
    expect(detachedStatus.reason).toContain("detached HEAD");
    expect(git(detached.install, "rev-parse", "HEAD")).toBe(detachedHead);

    const diverged = createGitFixture();
    writeFileSync(join(diverged.install, "local.txt"), "local commit\n", "utf8");
    commitAll(diverged.install, "local-only commit");
    const localHead = git(diverged.install, "rev-parse", "HEAD");

    const divergedStatus = await checkApplicationUpdateStatus({ root: diverged.install });

    expect(divergedStatus.state).toBe("diverged");
    expect(divergedStatus.reason).toContain("cannot fast-forward");
    expect(git(diverged.install, "rev-parse", "HEAD")).toBe(localHead);
  }, 40_000);

  it("reports offline and preserves HEAD when the remote cannot be fetched", async () => {
    const fixture = createGitFixture();
    const head = git(fixture.install, "rev-parse", "HEAD");
    git(fixture.install, "remote", "set-url", "origin", join(fixture.root, "missing-remote.git"));

    const status = await checkApplicationUpdateStatus({ root: fixture.install });

    expect(status.state).toBe("offline");
    expect(status.canApply).toBe(false);
    expect(git(fixture.install, "rev-parse", "HEAD")).toBe(head);
  });

  it("uses the status cache and de-duplicates concurrent checks", async () => {
    const fixture = createGitFixture();

    const [first, second] = await Promise.all([
      getApplicationUpdateStatus({ root: fixture.install, force: true }),
      getApplicationUpdateStatus({ root: fixture.install, force: true }),
    ]);

    expect(first).toBe(second);
    expect(first.state).toBe("available");
    git(fixture.install, "reset", "--hard", "origin/main");
    const cached = await getApplicationUpdateStatus({ root: fixture.install });
    expect(cached).toBe(first);
    clearApplicationUpdateCache();
    const refreshed = await getApplicationUpdateStatus({ root: fixture.install });
    expect(refreshed.state).toBe("current");
  });

  it("treats command arguments literally and bounds command execution time", async () => {
    const literal = "value && echo injected";
    const literalResult = await runBoundedCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", literal],
      { cwd: tmpdir(), timeoutMs: 5_000 },
    );
    expect(literalResult.code).toBe(0);
    expect(literalResult.stdout).toBe(literal);

    const timedOut = await runBoundedCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 1000)"],
      { cwd: tmpdir(), timeoutMs: 20 },
    );
    expect(timedOut.code).not.toBe(0);
  });

  it("blocks preflight while another update lock exists", async () => {
    const fixture = createGitFixture();
    const paths = updatePaths(fixture.install);
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.lock, '{"id":"existing-update"}\n', "utf8");

    const status = await preflightApplicationUpdate({ root: fixture.install });

    expect(status.state).toBe("updating");
    expect(status.canApply).toBe(false);
    expect(status.reason).toContain("already running");
  });
});

describe("application update integration", () => {
  it("fast-forwards to the checked release and the updated CLI reports the target version", async () => {
    const fixture = createGitFixture();
    const { runner } = updateRunner();
    let payload: UpdateWorkerPayload | undefined;

    const started = await startApplicationUpdate({
      root: fixture.install,
      runner,
      spawnWorker: (value) => {
        payload = value;
      },
    });
    expect(started.status.state).toBe("updating");
    expect(payload?.targetCommit).toBe(fixture.targetCommit);

    const progress = await runApplicationUpdateWorker(payload!, {
      runner,
      spawnDetached: () => undefined,
    });

    expect(progress.state).toBe("complete");
    expect(git(fixture.install, "rev-parse", "HEAD")).toBe(fixture.targetCommit);
    expect(execFileSync(
      process.execPath,
      [join(fixture.install, "packages", "cli", "dist", "index.js"), "--version"],
      { encoding: "utf8" },
    ).trim()).toBe("0.2.0");
  }, 30_000);

  it("rolls an actual checkout back to the exact old commit after a simulated build failure", async () => {
    const fixture = createGitFixture();
    const { runner, buildCalls } = updateRunner(true);
    let payload: UpdateWorkerPayload | undefined;
    await startApplicationUpdate({
      root: fixture.install,
      runner,
      spawnWorker: (value) => {
        payload = value;
      },
    });

    const progress = await runApplicationUpdateWorker(payload!, {
      runner,
      spawnDetached: () => undefined,
    });

    expect(progress.state).toBe("failed");
    expect(buildCalls()).toBe(2);
    expect(git(fixture.install, "rev-parse", "HEAD")).toBe(fixture.oldCommit);
    expect(execFileSync(
      process.execPath,
      [join(fixture.install, "packages", "cli", "dist", "index.js"), "--version"],
      { encoding: "utf8" },
    ).trim()).toBe("0.1.0");
  }, 30_000);
});
