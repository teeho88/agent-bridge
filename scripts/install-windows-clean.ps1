param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PackagesDir = Join-Path $RepoRoot "packages"
$BinDir = Join-Path $RepoRoot "bin"
$CliEntry = Join-Path $RepoRoot "packages\cli\dist\index.js"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE."
  }
}

function Remove-PathIfPresent {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (Test-Path -LiteralPath $Path) {
    Write-Host "Removing: $Path"
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

Write-Host "Agent Bridge clean Windows installer"
Write-Host "Repo: $RepoRoot"
Write-Host ""

Set-Location $RepoRoot

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "package.json"))) {
  throw "package.json was not found at the repository root."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20+ is required. Install Node.js, reopen the terminal, then run this script again."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required and should be installed with Node.js."
}

if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw "Corepack is required. Run 'npm install --global corepack', reopen the terminal, then run this script again."
}

$NodeVersion = (node -p "process.versions.node").Trim()
$NodeMajor = [int]($NodeVersion.Split('.')[0])
if ($NodeMajor -lt 20) {
  throw "Node.js 20+ is required. Current version: $NodeVersion"
}

Write-Host "Node.js: v$NodeVersion"

Write-Host ""
Write-Host "Removing stale global npm Agent Bridge install..."
& npm uninstall --global "@agent-bridge/cli" "agent-bridge" --silent 2>$null

$NpmPrefix = (& npm prefix --global).Trim()
if ($LASTEXITCODE -eq 0 -and $NpmPrefix) {
  foreach ($Name in @("agent-bridge", "agent-bridge.cmd", "agent-bridge.ps1")) {
    $ShimPath = Join-Path $NpmPrefix $Name
    if (Test-Path -LiteralPath $ShimPath) {
      Remove-Item -LiteralPath $ShimPath -Force
      Write-Host "Removed stale npm shim: $ShimPath"
    }
  }
}

Write-Host ""
Write-Host "Removing local dependencies and build output..."
Remove-PathIfPresent (Join-Path $RepoRoot "node_modules")

if (Test-Path -LiteralPath $PackagesDir) {
  foreach ($PackageDir in Get-ChildItem -LiteralPath $PackagesDir -Directory) {
    Remove-PathIfPresent (Join-Path $PackageDir.FullName "node_modules")
    Remove-PathIfPresent (Join-Path $PackageDir.FullName "dist")
  }
}

Remove-PathIfPresent (Join-Path $BinDir "agent-bridge.cmd")
Remove-PathIfPresent (Join-Path $BinDir "agent-bridge.ps1")

Write-Host ""
Write-Host "Activating pnpm 11.6.0 through Corepack..."
Invoke-Checked corepack prepare pnpm@11.6.0 --activate

Write-Host "Installing dependencies from pnpm-lock.yaml..."
Invoke-Checked corepack pnpm install --frozen-lockfile

Write-Host "Building all packages..."
Invoke-Checked corepack pnpm -r build

if (-not (Test-Path -LiteralPath $CliEntry)) {
  throw "Build completed but CLI entry was not created: $CliEntry"
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$CmdPath = Join-Path $BinDir "agent-bridge.cmd"
$PsPath = Join-Path $BinDir "agent-bridge.ps1"

@'
@echo off
node "%~dp0..\packages\cli\dist\index.js" %*
'@ | Set-Content -Encoding ASCII $CmdPath

@'
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) "packages\cli\dist\index.js"
if ($MyInvocation.ExpectingInput) {
  $input | & node $entry @args
} else {
  & node $entry @args
}
exit $LASTEXITCODE
'@ | Set-Content -Encoding ASCII $PsPath

Write-Host ""
Write-Host "Updating User PATH..."
$CurrentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$KeptParts = New-Object System.Collections.Generic.List[string]

if ($CurrentUserPath) {
  foreach ($Part in ($CurrentUserPath -split ";")) {
    if ([string]::IsNullOrWhiteSpace($Part)) {
      continue
    }

    $ExpandedPart = [Environment]::ExpandEnvironmentVariables($Part.Trim().Trim('"'))
    if ($ExpandedPart.TrimEnd('\') -ieq $BinDir.TrimEnd('\')) {
      continue
    }

    $OldShim = Join-Path $ExpandedPart "agent-bridge.cmd"
    if (Test-Path -LiteralPath $OldShim) {
      try {
        $OldShimContent = Get-Content -LiteralPath $OldShim -Raw -ErrorAction Stop
        if ($OldShimContent -match 'packages[\\/]+cli[\\/]+dist[\\/]+index\.js') {
          Write-Host "Removing old Agent Bridge PATH entry: $Part"
          continue
        }
      } catch {
      }
    }

    $KeptParts.Add($Part)
  }
}

$NextUserPath = (@($BinDir) + $KeptParts.ToArray()) -join ";"
[Environment]::SetEnvironmentVariable("Path", $NextUserPath, "User")

if (($env:Path -split ";") -notcontains $BinDir) {
  $env:Path = "$BinDir;$env:Path"
}

Write-Host ""
Write-Host "Verifying installed CLI..."
& $PsPath --help | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "agent-bridge --help failed with exit code $LASTEXITCODE."
}

$Resolved = (Get-Command agent-bridge -ErrorAction Stop).Source
Write-Host "agent-bridge resolves to: $Resolved"
Write-Host ""
Write-Host "Clean installation completed."
Write-Host "Open a new terminal, then verify with:"
Write-Host "  where.exe agent-bridge"
Write-Host "  agent-bridge --help"
Write-Host ""
Write-Host "Inside a project you want Agent Bridge to manage:"
Write-Host "  agent-bridge init"
