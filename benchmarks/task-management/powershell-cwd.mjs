export const powershellCwdBootstrap = "$bridgeNativeCwd = [Environment]::CurrentDirectory; New-PSDrive -Name BridgeWorkspace -PSProvider FileSystem -Root $bridgeNativeCwd -Scope Global -ErrorAction Stop | Out-Null; Set-Location -LiteralPath 'BridgeWorkspace:\\' -ErrorAction Stop;";

export function powershellWorkspaceCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('PowerShell command required');
  return powershellCwdBootstrap + '\n' + command;
}

export function powershellWorkspaceInstruction() {
  return `Native PowerShell compatibility: the AppContainer cannot resolve ancestor paths through its default filesystem drives. For EVERY PowerShell exec_command call, set workdir to the absolute project directory and begin the command with this exact bootstrap before any file IO:\n${powershellCwdBootstrap}\nUse relative PowerShell paths after this bootstrap. For a physical path use (Get-Location).ProviderPath; the PowerShell drive name is only a session alias. To change the working directory, set the next tool call's workdir instead of cd/Set-Location to a physical path. Apply this to each fresh shell, including login=false. Node process.cwd() already has the physical workspace path. Do not change ACLs, read outside the project, or request extra privileges.`;
}

export function missingPowerShellBootstrap(calls) {
  return calls.filter(call => call.type === 'commandExecution' && /(?:pwsh|powershell)\.exe\b/i.test(call.command ?? '') &&
    !['New-PSDrive', 'BridgeWorkspace', '[Environment]::CurrentDirectory', 'Set-Location'].every(token => call.command.includes(token))).map(call => call.id);
}
