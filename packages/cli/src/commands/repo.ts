import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureWorkspace } from "../workspace.js";
import { repositoryEnabled, setRepositoryEnabled } from "../repository.js";

export function registerRepo(program: Command): void {
  const repo = program.command("repo").description("Enable or disable Agent Bridge for a repository");
  for (const name of ["status", "enable", "disable"] as const) {
    repo.command(name).option("--project <path>", "repository path", process.cwd())
      .action((options: { project: string }) => {
        const workspace = resolve(options.project);
        if (name === "status") console.log(JSON.stringify({ workspace, enabled: repositoryEnabled(workspace) }));
        else { ensureWorkspace(workspace); console.log(JSON.stringify(setRepositoryEnabled(workspace, name === "enable"))); }
      });
  }
}
