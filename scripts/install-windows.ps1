param(
  [switch]$AddToUserPath
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BinDir = Join-Path $RepoRoot "bin"
$CliEntry = Join-Path $RepoRoot "packages\cli\dist\index.js"

Write-Host "agent-bridge installer"
Write-Host "Repo: $RepoRoot"

Set-Location $RepoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20+ is required. Install Node.js, then run this script again."
}

Write-Host "Enabling pnpm through Corepack..."
corepack prepare pnpm@11.6.0 --activate

Write-Host "Installing dependencies..."
corepack pnpm install

Write-Host "Building packages..."
corepack pnpm -r build

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$CmdPath = Join-Path $BinDir "agent-bridge.cmd"
$PsPath = Join-Path $BinDir "agent-bridge.ps1"

@"
@echo off
node "$CliEntry" %*
"@ | Set-Content -Encoding ASCII $CmdPath

# No param() block on purpose: with one, PowerShell tries to bind piped input to
# a parameter and fails with "The input object cannot be bound to any parameters
# for the command", so `echo "..." | agent-bridge memory add --stdin` lost the
# text and the CLI reported "No memory content". PowerShell prefers the .ps1 over
# the .cmd when both are on PATH, so this is the shim agents actually hit.
@"
`$entry = "$CliEntry"
if (`$MyInvocation.ExpectingInput) {
  `$input | & node `$entry @args
} else {
  & node `$entry @args
}
exit `$LASTEXITCODE
"@ | Set-Content -Encoding ASCII $PsPath

if ($AddToUserPath) {
  $CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $PathParts = @()
  if ($CurrentPath) {
    $PathParts = $CurrentPath -split ";"
  }
  if ($PathParts -notcontains $BinDir) {
    $NextPath = if ($CurrentPath) { "$CurrentPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $NextPath, "User")
    Write-Host "Added to user PATH: $BinDir"
    Write-Host "Open a new terminal before using agent-bridge globally."
  }
}

Write-Host ""
Write-Host "Installed agent-bridge wrapper:"
Write-Host "  $CmdPath"
Write-Host ""
Write-Host "Try now:"
Write-Host "  & `"$PsPath`" --help"
Write-Host ""
Write-Host "Start UI inside any project:"
Write-Host "  cd C:\path\to\your-project"
Write-Host "  & `"$PsPath`" init"
Write-Host "  & `"$PsPath`" ui"

