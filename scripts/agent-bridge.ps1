param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CliEntry = Join-Path $RepoRoot "packages\cli\dist\index.js"

if (-not (Test-Path $CliEntry)) {
  throw "CLI is not built. Run scripts\install-windows.ps1 first."
}

node $CliEntry @Args
