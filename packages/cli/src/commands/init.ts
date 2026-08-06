import type { Command } from "commander";
import { installClaudeHooks } from "./claude.js";
import { initializeWorkspace } from "../workspace.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize local agent-bridge memory workspace")
    .option("--no-claude-hooks", "skip installing Claude Code hooks")
    .action((options: { claudeHooks?: boolean }) => {
      const output = initializeWorkspace();
      if (options.claudeHooks !== false) {
        output.push("", ...installClaudeHooks(process.cwd()));
      } else {
        output.push("", "Skipped Claude Code hooks.", "To install later:", "  agent-bridge claude install-hooks");
      }
      console.log(output.join("\n"));
    });
}
