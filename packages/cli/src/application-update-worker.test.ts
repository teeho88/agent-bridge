import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runApplicationUpdateWorker,
} from "./application-update-worker.js";
import {
  updatePaths,
  type CommandRunner,
  type UpdateWorkerPayload,
} from "./application-update.js";

const roots: string[] = [];

function makePayload(overrides: Partial<UpdateWorkerPayload> = {}): UpdateWorkerPayload {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-update-worker-"));
  roots.push(root);
  const payload: UpdateWorkerPayload = {
    id: "update-test",
    root,
    workspace: join(root, "workspace"),
    port: 4783,
    oldCommit: "old-commit",
    oldVersion: "0.1.0",
    targetCommit: "target-commit",
    targetTag: "v0.2.0",
    targetVersion: "0.2.0",
    remote: "origin",
    remoteBranch: "main",
    ...overrides,
  };
  const paths = updatePaths(root);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.lock, JSON.stringify({ id: payload.id }), "utf8");
  return payload;
}

function successRunner(calls: Array<{ file: string; args: readonly string[] }>): CommandRunner {
  return async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === "git" && args[0] === "rev-parse") {
      return { code: 0, stdout: "target-commit\n", stderr: "" };
    }
    if (file === process.execPath && args.at(-1) === "--version") {
      return { code: 0, stdout: "0.2.0\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("application update worker", () => {
  it("runs the checked target sequence, records a relative log path, and restarts the same workspace and port", async () => {
    const payload = makePayload();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const spawnDetached = vi.fn();

    const progress = await runApplicationUpdateWorker(payload, {
      runner: successRunner(calls),
      spawnDetached,
    });

    expect(progress.state).toBe("complete");
    expect(progress.logFile).toBe(".agent-memory/update/update-update-test.log");
    expect(existsSync(updatePaths(payload.root).lock)).toBe(false);
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ["git", "fetch", "origin", "main"],
      ["git", "fetch", "origin", "tag", "v0.2.0"],
      ["git", "rev-parse", "v0.2.0^{commit}"],
      ["git", "merge", "--ff-only", "target-commit"],
      ["corepack", "pnpm", "install", "--frozen-lockfile"],
      ["corepack", "pnpm", "-r", "build"],
      [process.execPath, join(payload.root, "packages", "cli", "dist", "index.js"), "--version"],
    ]);
    expect(spawnDetached).toHaveBeenCalledOnce();
    expect(spawnDetached.mock.calls[0]).toEqual([
      process.execPath,
      [
        join(payload.root, "packages", "cli", "dist", "index.js"),
        "ui",
        "--project",
        payload.workspace,
        "--port",
        "4783",
      ],
      payload.root,
    ]);
  });

  it("rolls back to the exact old commit when the updated build fails", async () => {
    const payload = makePayload();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    let buildCount = 0;
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "target-commit\n", stderr: "" };
      }
      if (file === "corepack" && args[0] === "pnpm" && args[1] === "-r" && args[2] === "build") {
        buildCount += 1;
        if (buildCount === 1) return { code: 1, stdout: "", stderr: "simulated build failure" };
      }
      if (file === process.execPath && args.at(-1) === "--version") {
        return { code: 0, stdout: "0.1.0\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const progress = await runApplicationUpdateWorker(payload, {
      runner,
      spawnDetached: vi.fn(),
    });

    expect(progress.state).toBe("failed");
    expect(calls.some((call) =>
      call.file === "git" &&
      call.args[0] === "reset" &&
      call.args[1] === "--hard" &&
      call.args[2] === payload.oldCommit
    )).toBe(true);
    expect(buildCount).toBe(2);
    expect(existsSync(updatePaths(payload.root).lock)).toBe(false);
    const logPath = join(payload.root, progress.logFile!);
    expect(readFileSync(logPath, "utf8")).toContain("simulated build failure");
  });

  it("never removes a lock owned by another update", async () => {
    const payload = makePayload();
    const paths = updatePaths(payload.root);
    writeFileSync(paths.lock, JSON.stringify({ id: "other-update" }), "utf8");
    const runner = vi.fn<Parameters<CommandRunner>, ReturnType<CommandRunner>>();

    const progress = await runApplicationUpdateWorker(payload, { runner });

    expect(progress.state).toBe("failed");
    expect(progress.error).toContain("another update");
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(paths.lock, "utf8"))).toEqual({ id: "other-update" });
  });
});
