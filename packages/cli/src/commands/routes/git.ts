import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskChange } from "@agent-bridge/memory";
import { safeRead } from "./files.js";

// Git inspection behind the Work Board: what a task changed, and the diff the
// dashboard renders for it.

export function gitPathStatus(
  root: string,
  path: string,
): { changeType: TaskChange["changeType"]; summary: string } | undefined {
  const raw = runGit(root, ["status", "--porcelain", "--", path]);
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trimEnd())
    .find(Boolean);
  if (!line) return undefined;
  const status = line.slice(0, 2);
  const rest = line.slice(3).trim();
  const changedPath = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
  const changeType = status.includes("D")
    ? "deleted"
    : status.includes("R")
      ? "renamed"
      : status.includes("A") || status.includes("?")
        ? "added"
        : "modified";
  return {
    changeType,
    summary: `${status.trim() || "changed"} ${changedPath || path}`,
  };
}

export function gitDiffStat(
  root: string,
  path: string,
): { insertions: number; deletions: number; raw?: string } {
  const raw =
    runGit(root, ["diff", "--no-ext-diff", "--numstat", "HEAD", "--", path]) ||
    runGit(root, ["diff", "--no-ext-diff", "--numstat", "--", path]);
  if (!raw.trim()) return { insertions: 0, deletions: 0 };
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce(
      (total, line) => {
        const [added, deleted] = line.split(/\t/);
        return {
          insertions: total.insertions + parseNumstat(added),
          deletions: total.deletions + parseNumstat(deleted),
          raw,
        };
      },
      { insertions: 0, deletions: 0, raw },
    );
}

export function gitDiff(root: string, path: string): string | undefined {
  const diff =
    runGit(root, ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", path]) ||
    runGit(root, ["diff", "--no-ext-diff", "--unified=80", "--", path]);
  return diff.trim() ? diff : undefined;
}

export function runGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024 * 5,
    });
  } catch {
    return "";
  }
}

export function parseNumstat(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function addedFileDiff(
  root: string,
  path: string,
): { insertions: number; raw: string; diff: string } | undefined {
  const full = resolve(root, path);
  const workspaceRoot = resolve(root);
  if (!full.startsWith(workspaceRoot) || !existsSync(full)) return undefined;
  const content = safeRead(full);
  const lines = content ? content.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return {
    insertions: lines.length,
    raw: `${lines.length}\t0\t${path}`,
    diff: [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      ...lines.map((line) => `+${line}`),
    ].join("\n"),
  };
}

export function truncateDiff(diff: string | undefined): string | undefined {
  if (!diff) return undefined;
  const limit = 60000;
  return diff.length > limit
    ? `${diff.slice(0, limit)}\n... diff truncated ...`
    : diff;
}
