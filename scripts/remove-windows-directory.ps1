param(
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$FullPath = [System.IO.Path]::GetFullPath($Path)
$RootPath = [System.IO.Path]::GetPathRoot($FullPath)

if ($FullPath.TrimEnd('\') -ieq $RootPath.TrimEnd('\')) {
  throw "Refusing to recursively remove a drive root: $FullPath"
}

if (-not (Test-Path -LiteralPath $FullPath)) {
  return
}

try {
  Remove-Item -LiteralPath $FullPath -Recurse -Force -ErrorAction Stop
  return
} catch {
  Write-Warning "PowerShell could not remove '$FullPath': $($_.Exception.Message)"
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  & node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $FullPath 2>$null
  if ($LASTEXITCODE -eq 0 -and -not (Test-Path -LiteralPath $FullPath)) {
    Write-Host "Removed with Node.js fallback: $FullPath"
    return
  }
}

& cmd.exe /d /c rd /s /q $FullPath 2>$null
if ($LASTEXITCODE -eq 0 -and -not (Test-Path -LiteralPath $FullPath)) {
  Write-Host "Removed with cmd.exe fallback: $FullPath"
  return
}

if (-not (Test-Path -LiteralPath $FullPath)) {
  return
}

throw "Unable to remove '$FullPath'. A damaged Windows reparse point may require filesystem repair before the clean install can continue."
