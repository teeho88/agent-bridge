import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliPermissionArgs, type CliInvocationSettings } from "@agent-bridge/adapters";
import type { BridgeConfig } from "./workspace-config.js";

type Policies = NonNullable<BridgeConfig["cliApprovalPolicies"]>;

export function repositoryCliPermissions(provider: string, cwd: string, args: string[] = []): string[] {
  if (args.some(arg => ["--help", "-h", "--version", "-V"].includes(arg))) return [];
  if (["help", "login", "logout", "auth", "mcp", "plugin", "plugins", "update", "install", "completion", "features", "debug"].includes(args[0])) return [];
  let directory = resolve(cwd);
  if (provider === "codex") {
    for (let index = 0; index < args.length; index++) {
      if (["-C", "--cd"].includes(args[index]) && args[index + 1]) directory = resolve(cwd, args[++index]);
      else if (args[index].startsWith("--cd=")) directory = resolve(cwd, args[index].slice(5));
    }
  }
  for (;;) {
    const path = join(directory, ".agent-memory", "config.json");
    if (existsSync(path)) {
      const config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as BridgeConfig;
      if (config.enabled === false || !config.cliApprovalPolicies) return [];
      const policies = config.cliApprovalPolicies;
      const settings: CliInvocationSettings = {
        policy: provider === "codex" ? policies.codex : provider === "claude" ? policies.claude : policies.antigravity,
        codexSandbox: policies.codexSandbox,
        antigravityMode: policies.antigravityMode,
      };
      const permissionFlags = provider === "codex"
        ? ["--sandbox", "-s", "--ask-for-approval", "-a", "--full-auto", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]
        : provider === "claude" ? ["--permission-mode", "--dangerously-skip-permissions"]
        : ["--mode", "--dangerously-skip-permissions", "--settings"];
      if (args.some(arg => permissionFlags.includes(arg.split("=")[0]) || /^(?:-c=|--config=)?(approval_policy|sandbox_mode|approvals_reviewer|default_permissions)=/.test(arg))) return [];
      return cliPermissionArgs(provider, settings);
    }
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git"))) return [];
    directory = parent;
  }
}

export function syncCodexPermissions(cwd: string, policies: Policies): string {
  const args = cliPermissionArgs("codex", { policy: policies.codex, codexSandbox: policies.codexSandbox });
  const bypass = policies.codex === "bypass";
  const values: Record<string, string> = {
    approval_policy: bypass ? "never" : policies.codex === "never" || !policies.codex ? "never" : "on-request",
    sandbox_mode: bypass ? "danger-full-access" : policies.codexSandbox ?? "workspace-write",
    approvals_reviewer: args.includes('approvals_reviewer="auto_review"') ? "auto_review" : "user",
  };
  const path = join(cwd, ".codex", "config.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const firstTable = existing.search(/^\s*\[/m);
  let root = firstTable < 0 ? existing : existing.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : existing.slice(firstTable);
  for (const key of Object.keys(values)) root = root.replace(new RegExp(`^[ \\t]*${key}[ \\t]*=.*(?:\\r?\\n|$)`, "gm"), "");
  const text = `${Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n${root}${tables}`;
  mkdirSync(dirname(path), { recursive: true });
  if (text !== existing) writeFileSync(path, text, "utf8");
  return path;
}

function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function powershellPermissionIntegration(entry = fileURLToPath(import.meta.url)): string {
  return `function global:Invoke-AgentBridgeCli {
  param([string]$Provider, [string]$Command, [object[]]$CliArgs, [bool]$Piped, [object[]]$PipelineData)
  $native = Get-Command $Command -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
  $serialized = ConvertTo-Json -InputObject @($CliArgs) -Compress -Depth 10
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($serialized))
  $resolved = & ${ps(process.execPath)} ${ps(entry)} $Provider $PWD.ProviderPath $encoded
  if ($LASTEXITCODE -ne 0) { throw 'Agent Bridge could not resolve CLI permissions; agent launch cancelled.' }
  $permissionArgs = $resolved | ConvertFrom-Json
  if ($Piped) { $PipelineData | & $native.Source @permissionArgs @CliArgs }
  else { & $native.Source @permissionArgs @CliArgs }
}
function global:codex { Invoke-AgentBridgeCli 'codex' 'codex' $args $MyInvocation.ExpectingInput @($input) }
function global:claude { Invoke-AgentBridgeCli 'claude' 'claude' $args $MyInvocation.ExpectingInput @($input) }
function global:agy { Invoke-AgentBridgeCli 'antigravity' 'agy' $args $MyInvocation.ExpectingInput @($input) }
`;
}

export function installPermissionProfile(path: string, entry = fileURLToPath(import.meta.url)): void {
  const start = "# agent-bridge:cli-permissions:start";
  const end = "# agent-bridge:cli-permissions:end";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = `${start}\n${powershellPermissionIntegration(entry)}${end}`;
  const first = existing.indexOf(start);
  const last = existing.indexOf(end);
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first)) throw new Error(`Incomplete Agent Bridge profile block: ${path}`);
  const next = first < 0 ? `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${block}\n`
    : `${existing.slice(0, first)}${block}${existing.slice(last + end.length)}`;
  mkdirSync(dirname(path), { recursive: true });
  if (next !== existing) writeFileSync(path, next, "utf8");
}

export function installPermissionShells(): string[] {
  if (process.platform !== "win32") throw new Error("CLI shell integration currently supports Windows PowerShell and PowerShell 7.");
  const shells = ["powershell.exe"];
  try { execFileSync("where.exe", ["pwsh.exe"], { stdio: "ignore", windowsHide: true }); shells.push("pwsh.exe"); } catch {}
  return shells.map(shell => {
    const path = execFileSync(shell, ["-NoProfile", "-Command", "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $PROFILE.CurrentUserAllHosts"], { encoding: "utf8", windowsHide: true }).trim();
    installPermissionProfile(path);
    return path;
  });
}

export function installCmdLaunchers(directory: string, entry = fileURLToPath(import.meta.url)): string {
  mkdirSync(directory, { recursive: true });
  const marker = "@rem agent-bridge:cli-permissions";
  const batchPath = (value: string) => value.replace(/%/g, "%%");
  const files = new Map<string, string>();
  for (const [command, provider] of [["codex", "codex"], ["claude", "claude"], ["agy", "antigravity"]]) {
    files.set(`${command}.cmd`, `${marker}\r\n@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${batchPath(process.execPath)}" "${batchPath(entry)}" --launch ${provider} "%~dp0." %*\r\nexit /b %errorlevel%\r\n`);
  }
  files.set("init.cmd", `${marker}\r\n@if /i "%AGENT_BRIDGE_CMD_BIN%"=="%~dp0." exit /b\r\n@set "AGENT_BRIDGE_CMD_BIN=%~dp0."\r\n@set "PATH=%~dp0.;%PATH%"\r\n`);
  for (const name of files.keys()) {
    const path = join(directory, name);
    if (existsSync(path) && !readFileSync(path, "utf8").startsWith(marker)) throw new Error(`Refusing to replace an unmanaged CMD launcher: ${path}`);
  }
  for (const [name, content] of files) writeFileSync(join(directory, name), content, "utf8");
  return join(directory, "init.cmd");
}

export function cmdPermissionAutoRun(existing: string, script: string): string {
  const command = `call "${script}"`;
  if (existing.toLowerCase().includes(command.toLowerCase())) return existing;
  return existing.trim() ? `${existing} & ${command}` : command;
}

export function installCmdPermissions(): string {
  if (process.platform !== "win32") throw new Error("CMD integration requires Windows.");
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required to install CMD integration.");
  const script = installCmdLaunchers(join(process.env.LOCALAPPDATA, "AgentBridge", "cmd"));
  const registryScript = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\Command Processor')
try {
  $existing = [string]$key.GetValue('AutoRun', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $command = ${ps(cmdPermissionAutoRun("", script))}
  if ($existing.IndexOf($command, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    $next = if ($existing.Trim()) { $existing + ' & ' + $command } else { $command }
    $kind = if ($key.GetValueNames() -contains 'AutoRun') { $key.GetValueKind('AutoRun') } else { [Microsoft.Win32.RegistryValueKind]::String }
    $key.SetValue('AutoRun', $next, $kind)
  }
} finally { $key.Close() }
`;
  execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(registryScript, "utf16le").toString("base64")], { stdio: "pipe", windowsHide: true });
  return script;
}

export function launchCmdAgent(provider: string, shimDirectory: string, args: string[]): number {
  const command = provider === "antigravity" ? "agy" : provider;
  if (!["codex", "claude", "agy"].includes(command)) throw new Error(`Unsupported agent CLI: ${provider}`);
  const paths = execFileSync("where.exe", [command], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
  const executable = paths.find(path => [".exe", ".com"].includes(extname(path).toLowerCase()) && dirname(resolve(path)).toLowerCase() !== resolve(shimDirectory).toLowerCase());
  if (!executable) throw new Error(`Native ${command} executable not found on PATH. Install the provider's Windows CLI executable.`);
  const permissionArgs = repositoryCliPermissions(provider, process.cwd(), args);
  const result = spawnSync(executable, [...permissionArgs, ...args], { stdio: "inherit", windowsHide: false });
  if (result.error) throw result.error;
  return result.status ?? (result.signal === "SIGINT" ? 130 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [provider, cwd, encoded, ...rest] = process.argv.slice(2);
    if (provider === "--launch") {
      process.exitCode = launchCmdAgent(cwd, encoded, rest);
    } else {
      const args = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as string[] : [];
      process.stdout.write(JSON.stringify(repositoryCliPermissions(provider, cwd, args)));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
