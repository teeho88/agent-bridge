import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { TaskContract } from "@agent-bridge/memory";

export type CheckRule = { scope: string; commands: string[] };

export function selectTaskChecks(cwd: string, contract: TaskContract, files: string[], rules: CheckRule[], expansionReason?: string) {
  if (!files.length || !rules.length) throw new Error("Changed files and check rules are required");
  const normalize = (path: string) => {
    const normalized = relative(cwd, resolve(cwd, path)).replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("../") || isAbsolute(normalized)) throw new Error("Check scope must stay inside repository");
    return normalized;
  };
  const changes = [...new Set(files.map(normalize))].sort();
  const selected = new Set<string>();
  const reasons: Record<string, string[]> = {};
  for (const file of changes) {
    const matches = rules.filter(rule => {
      const scope = normalize(rule.scope);
      return file === scope || file.startsWith(`${scope}/`);
    });
    if (!matches.length) throw new Error(`No check rule covers ${file}`);
    for (const rule of matches) for (const command of rule.commands) {
      if (!contract.checks.includes(command)) throw new Error(`Check is outside contract: ${command}`);
      selected.add(command);
      (reasons[command] ??= []).push(file);
    }
  }
  if (!selected.size) throw new Error("No checks selected");
  if (expansionReason !== undefined) {
    if (!expansionReason.trim()) throw new Error("Expansion requires a reason");
    for (const command of contract.checks) {
      selected.add(command);
      (reasons[command] ??= []).push(expansionReason);
    }
  }
  const sources = changes.map(path => {
    try { return { path, hash: createHash("sha256").update(readFileSync(resolve(cwd, path))).digest("hex") }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path, hash: null };
    }
  });
  const revision = createHash("sha256").update(JSON.stringify({ contract, sources })).digest("hex");
  return { taskId: contract.taskId, contractVersion: contract.version, revision, sources,
    commands: [...selected], reasons, remainingRequired: contract.checks.filter(command => !selected.has(command)) };
}
