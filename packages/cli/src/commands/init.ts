import type { Command } from "commander";
import { installClaudeHooks } from "./claude.js";
import { installAntigravityHooks } from "./antigravity.js";
import { initializeWorkspace } from "../workspace.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize local agent-bridge memory workspace")
    .option("--no-claude-hooks", "skip installing Claude Code hooks")
    .option("--no-antigravity-hooks", "skip installing Antigravity (agy) hooks")
    .action((options: { claudeHooks?: boolean; antigravityHooks?: boolean }) => {
      const output = initializeWorkspace();
      if (options.claudeHooks !== false) {
        output.push("", ...installClaudeHooks(process.cwd()));
      } else {
        output.push("", "Skipped Claude Code hooks.", "To install later:", "  agent-bridge claude install-hooks");
      }
      if (options.antigravityHooks !== false) {
        output.push("", ...installAntigravityHooks(process.cwd()));
      } else {
        output.push("", "Skipped Antigravity hooks.", "To install later:", "  agent-bridge antigravity install-hooks");
      }
      console.log(output.join("\n"));
    });
}
