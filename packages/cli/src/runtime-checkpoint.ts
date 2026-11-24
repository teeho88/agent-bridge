import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "@agent-bridge/core";
import type { CheckpointInput } from "@agent-bridge/memory";
import { paths } from "./workspace.js";
import { repositoryIdentity } from "./runtime-identity.js";

export function collectTestResult(cwd: string, command: string): CheckpointInput["tests"] {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const directory = join(paths(cwd).memoryDir, "evidence");
  mkdirSync(directory, { recursive: true });
  const evidencePath = join(directory, `test-${randomUUID()}.json`);
  const recordedCommand = redactSecrets(command);
  const record = { command: recordedCommand, exitCode: result.status, signal: result.signal, error: result.error?.message, stdout: redactSecrets(result.stdout ?? ""), stderr: redactSecrets(result.stderr ?? ""), timestamp: new Date().toISOString(), commit: repositoryIdentity(cwd).baseCommit };
  const temporary = `${evidencePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temporary, evidencePath);
  return { command: recordedCommand, exitCode: result.status ?? undefined, evidencePath: relative(cwd, evidencePath).replace(/\\/g, "/"), commit: record.commit, status: result.status === 0 ? "passed" : result.status === null ? "unknown" : "failed", summary: `${recordedCommand}: ${result.status === null ? "unknown (command did not complete)" : `exit ${result.status}`}` };
}
