import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
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
  if (!logPath || !existsSync(logPath)) return "";
  try {
    const { size } = statSync(logPath);
    const handle = openSync(logPath, "r");
    try {
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      // A mid-character/mid-line start is unavoidable when slicing bytes; drop
      // the first partial line rather than showing mojibake.
      const usable = size > maxBytes ? text.slice(text.indexOf("\n") + 1) : text;
      return usable.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n");
    } finally {
      closeSync(handle);
    }
  } catch {
    return "";
  }
}
