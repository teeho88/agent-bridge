import { readRunLogTail } from "@agent-bridge/adapters";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

// Forgiving file reads: the dashboard shows whatever is on disk and treats a
// missing or unreadable file as empty rather than failing the request.

export function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

// `planPath` and `reportPath` are workspace-relative once an orchestration uses
// the context store — that is what makes them usable in a prompt, since the
// agents run with the workspace as their cwd. The UI server does not: it is
// launched from wherever the user happened to be and serves `--project <path>`,
// so a relative path has to be resolved against the project, not process.cwd().
export function readTextIfExists(path: string | undefined, cwd?: string): string | undefined {
  if (!path) return undefined;
  const resolved = cwd && !isAbsolute(path) ? join(cwd, path) : path;
  if (!existsSync(resolved)) return undefined;
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
}

// Last few lines of a run's log, for the Runs board cards. Reads only the tail
// of the file — an implementer log can reach hundreds of KB and this is polled
// for every run on the board.
export function readLogTail(logPath: string | undefined, lines = 14, maxBytes = 24_000): string {
  return readRunLogTail(logPath, lines, maxBytes);
}
