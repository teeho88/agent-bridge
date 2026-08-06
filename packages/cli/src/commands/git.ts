import type { Command } from "commander";

export function registerGit(program: Command): void {
  program.command("git").description("Git helpers are planned after the local MVP").action(() => {
    console.log("Git snapshot is not part of this MVP priority pass.");
  });
}
