import type { Command } from "commander";
import { readConfig, writeConfig } from "./workspace-config.js";
import { restoreRepositoryIntegrations, suspendRepositoryIntegrations } from "./repository-integrations.js";

export function repositoryEnabled(cwd = process.cwd()): boolean {
  return readConfig(cwd).enabled !== false;
}

export function setRepositoryEnabled(cwd: string, enabled: boolean): { enabled: boolean; workspace: string } {
  const config = readConfig(cwd);
  if (!enabled) writeConfig({ ...config, enabled: false }, cwd);
  if (enabled) {
    if (config.enabled === false) restoreRepositoryIntegrations(cwd);
  } else suspendRepositoryIntegrations(cwd);
  writeConfig({ ...config, enabled }, cwd);
  return { enabled, workspace: cwd };
}

export function installRepositoryGuard(program: Command): void {
  program.hook("preAction", (_root, command) => {
    const path: string[] = [];
    for (let current: Command | null = command; current?.parent; current = current.parent) path.unshift(current.name());
    if (["tui", "ui", "repo", "update"].includes(path[0])) return;
    if (["claude", "codex", "antigravity"].includes(path[0]) && path[1] === "hook") return;
    if (!repositoryEnabled()) throw new Error("Agent Bridge is disabled for this repository. Run `agent-bridge repo enable` to enable it.");
  });
}
