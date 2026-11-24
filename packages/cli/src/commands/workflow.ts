import type { Command } from "commander";
import { readConfig, writeConfig } from "../workspace.js";

export function registerWorkflow(program: Command): void {
  const workflow = program.command("workflow").description("Configure protected token-efficient workflows");
  workflow.command("set").requiredOption("--mode <mode>", "full | single")
    .action((options: { mode: string }) => {
      if (!["full", "single"].includes(options.mode)) throw new Error("Mode must be full or single");
      const config = readConfig();
      writeConfig({ ...config, workflow: { ...config.workflow, mode: options.mode as "full" | "single" } });
      console.log(JSON.stringify({ mode: options.mode }));
    });
  workflow.command("show").action(() => console.log(JSON.stringify({ mode: readConfig().workflow?.mode ?? "full" })));
}
