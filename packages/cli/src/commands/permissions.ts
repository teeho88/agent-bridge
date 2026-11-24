import type { Command } from "commander";
import { installCmdPermissions, installPermissionShells, syncCodexPermissions } from "../cli-permissions.js";
import { readConfig } from "../workspace-config.js";

export function registerPermissions(program: Command): void {
  const permissions = program.command("permissions").description("Apply repository CLI permission settings");
  permissions.command("sync").description("Sync native Codex project permissions").action(() => {
    console.log(syncCodexPermissions(process.cwd(), readConfig().cliApprovalPolicies ?? {}));
  });
  permissions.command("install-cmd").description("Apply repository permissions when launching codex, claude or agy from CMD").action(() => {
    console.log(installCmdPermissions());
    console.log("Open a new CMD terminal to load CLI permission integration.");
  });
  permissions.command("install-shell").description("Apply repository permissions when launching codex, claude or agy from PowerShell or CMD").action(() => {
    const profiles = installPermissionShells();
    console.log(profiles.join("\n"));
    console.log(installCmdPermissions());
    console.log(syncCodexPermissions(process.cwd(), readConfig().cliApprovalPolicies ?? {}));
    console.log("Open a new PowerShell or CMD terminal to load CLI permission integration.");
  });
}
