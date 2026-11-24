param([Parameter(Mandatory=$true)][string]$IdentityPool, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$pool = Get-Content -LiteralPath (Resolve-Path -LiteralPath $IdentityPool).ProviderPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pool.schemaVersion -ne 1 -or @($pool.entries).Count -notin @(6,44)) { throw 'Expected a registered diagnostic six-identity or operational 44-identity pool' }
$expected = [Collections.Generic.HashSet[string]]::new()
if (@($pool.entries).Count -eq 6) {
  foreach ($branch in @('B','S')) {
    foreach ($task in @('small','handoff','debug')) { [void]$expected.Add("smoke-$branch-0-$task") }
  }
} else {
  foreach ($branch in @('B','S')) {
    foreach ($task in @('small','handoff')) { [void]$expected.Add("smoke-$branch-0-$task") }
    foreach ($repetition in 1..5) {
      foreach ($task in @('small','debug','multi','handoff')) { [void]$expected.Add("formal-$branch-$repetition-$task") }
    }
  }
}
$seen = [Collections.Generic.HashSet[string]]::new()
$profiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $pool.entries) {
  if ($entry.profileName -notmatch '^BridgeV2\.[A-Za-z0-9.-]{1,54}$' -or
      $entry.sid -notmatch '^S-1-15-2-(\d+-){6}\d+$' -or -not $seen.Add($entry.sid) -or
      -not $profiles.Add($entry.profileName) -or -not $expected.Remove($entry.key)) {
    throw 'Invalid or duplicate registered test identity'
  }
}
if ($expected.Count -ne 0) { throw 'Identity pool does not cover the required schedule' }
foreach ($entry in $pool.entries) {
  $mapping = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\' + $entry.sid
  $registered = Get-Item -LiteralPath $mapping -ErrorAction Stop
  if ($registered.GetValue('Moniker') -ine $entry.profileName) { throw 'Registered profile/SID mismatch' }
}
if ($ValidateOnly) {
  [ordered]@{passed=$true; identities=@($pool.entries).Count; registryVerified=$true; mutations=0} | ConvertTo-Json -Compress
  return
}
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator is required to enable loopback for the registered test SIDs'
}
$helper = Join-Path $env:WINDIR 'System32\CheckNetIsolation.exe'
foreach ($entry in $pool.entries) {
  & $helper LoopbackExempt -a ('-p=' + $entry.sid)
  if ($LASTEXITCODE -ne 0) { throw ('Loopback exemption failed: ' + $entry.key) }
}
$readback = & $helper LoopbackExempt -s
if ($LASTEXITCODE -ne 0) { throw 'Loopback exemption readback failed' }
foreach ($entry in $pool.entries) {
  if (-not ($readback | Select-String -SimpleMatch $entry.sid)) { throw ('Loopback exemption missing: ' + $entry.key) }
}
$readback
