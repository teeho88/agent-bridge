param(
  [switch]$InstallGlobal,
  [switch]$CloneRepos,
  [string]$ToolsDir = "external-tools"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TargetToolsDir = Join-Path $RepoRoot $ToolsDir

$NpmTools = @(
  @{ Name = "repomix"; Purpose = "Pack/summarize repository context for agents" },
  @{ Name = "ccusage"; Purpose = "Inspect Claude Code token/cost usage" }
)

$Repos = @(
  @{ Name = "repomix"; Url = "https://github.com/yamadashy/repomix.git" },
  @{ Name = "ccusage"; Url = "https://github.com/ryoppippi/ccusage.git" }
)

Write-Host "agent-bridge optional token/context tools"
Write-Host "Repo: $RepoRoot"
Write-Host ""

if (-not $InstallGlobal -and -not $CloneRepos) {
  Write-Host "Nothing was installed. Choose one or both:"
  Write-Host "  -InstallGlobal  Install npm CLIs globally"
  Write-Host "  -CloneRepos     Clone source repositories into $ToolsDir"
  Write-Host ""
  Write-Host "Example:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\install-token-tools.ps1 -InstallGlobal -CloneRepos"
  exit 0
}

if ($InstallGlobal) {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required to install optional token tools."
  }

  foreach ($Tool in $NpmTools) {
    Write-Host "Installing $($Tool.Name): $($Tool.Purpose)"
    npm install -g $Tool.Name
  }
}

if ($CloneRepos) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is required to clone optional tool repositories."
  }

  New-Item -ItemType Directory -Force -Path $TargetToolsDir | Out-Null

  foreach ($Repo in $Repos) {
    $Destination = Join-Path $TargetToolsDir $Repo.Name
    if (Test-Path $Destination) {
      Write-Host "Skipping existing repo: $Destination"
      continue
    }
    Write-Host "Cloning $($Repo.Url)"
    git clone $Repo.Url $Destination
  }
}

Write-Host ""
Write-Host "Done."
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  repomix --help"
Write-Host "  ccusage --help"

