import { claudeManagedSection, codexManagedSection, patchManagedSection } from "@agent-bridge/adapters";
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { installAntigravityHooks } from "./antigravity.js";
import { installClaudeHooks } from "./claude.js";

export function registerUpgrade(program: Command): void {
  program
    .command("upgrade")
    .description("Refresh agent-bridge integration in an existing repository")
    .option("--project <path>", "repository path to upgrade")
    .action((options: { project?: string }) => {
      const projectPath = resolve(options.project ?? process.cwd());
      console.log(upgradeWorkspace(projectPath).join("\n"));
    });
}

export function upgradeWorkspace(projectPath = process.cwd()): string[] {
  const workspacePath = join(projectPath, ".agent-memory");
  if (!existsSync(workspacePath)) {
    throw new Error(
      `Agent Bridge is not initialized in ${projectPath}. Run \`agent-bridge init\` there first.`,
    );
  }

  const agentsStatus = patchManagedSection(
    join(projectPath, "AGENTS.md"),
    codexManagedSection(),
  );
  const claudeStatus = patchManagedSection(
    join(projectPath, "CLAUDE.md"),
    claudeManagedSection(),
  );

  return [
    "Upgraded agent-bridge integration.",
    `Project: ${projectPath}`,
    `${agentsStatus === "created" ? "Created" : "Updated"} AGENTS.md managed section`,
    `${claudeStatus === "created" ? "Created" : "Updated"} CLAUDE.md managed section`,
    "",
    ...installClaudeHooks(projectPath),
    "",
    ...installAntigravityHooks(projectPath),
  ];
}
