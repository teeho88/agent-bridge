import type { Command } from "commander";
import { installClaudeHooks } from "./claude.js";
import { installAntigravityHooks } from "./antigravity.js";
import { initializeWorkspace, readConfig } from "../workspace.js";
import { setRepositoryEnabled } from "../repository.js";

export function initializeProject(
  project: string,
  options: { claudeHooks?: boolean; antigravityHooks?: boolean } = {},
): string[] {
  const output = initializeWorkspace(project);
  if (options.claudeHooks !== false) {
    output.push("", ...installClaudeHooks(project));
  } else {
    output.push("", "Skipped Claude Code hooks.", "To install later:", "  agent-bridge claude install-hooks");
  }
  if (options.antigravityHooks !== false) {
    output.push("", ...installAntigravityHooks(project));
  } else {
    output.push("", "Skipped Antigravity hooks.", "To install later:", "  agent-bridge antigravity install-hooks");
  }
  if (readConfig(project).enabled === false) setRepositoryEnabled(project, false);
  return output;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize local agent-bridge memory workspace")
    .option("--no-claude-hooks", "skip installing Claude Code hooks")
    .option("--no-antigravity-hooks", "skip installing Antigravity (agy) hooks")
    .action((options: { claudeHooks?: boolean; antigravityHooks?: boolean }) => {
      console.log(initializeProject(process.cwd(), options).join("\n"));
    });
}
