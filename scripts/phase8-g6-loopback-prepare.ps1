param([string]$PreparationPath, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (-not $PreparationPath) { $PreparationPath = Join-Path $projectRoot '.local/g6-preparation-work-20261028.json' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $ValidateOnly -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator required to add AppContainer loopback exemptions. No changes made.' }
$preparation = Get-Content -LiteralPath $PreparationPath -Raw | ConvertFrom-Json
$cohort = [IO.Path]::GetFullPath($preparation.directory)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'docs/phase8-2-remediation-20261019/cohorts/gpt6-web-high')).TrimEnd('\') + '\'
if (-not $cohort.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Preparation cohort outside expected project boundary' }
$poolPath = Join-Path $cohort 'identity-pool.json'
$validation = Get-Content -LiteralPath (Join-Path $cohort 'identity-validation.json') -Raw | ConvertFrom-Json
$poolHash = (Get-FileHash -LiteralPath $poolPath -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $validation.passed -or -not $validation.disjointParent -or $poolHash -ne $validation.registration.hash) { throw 'Identity pool proof mismatch' }
$pool = Get-Content -LiteralPath $poolPath -Raw | ConvertFrom-Json
$sids = @($pool.entries | ForEach-Object { $_.sid })
if ($sids.Count -ne 44 -or @($sids | Sort-Object -Unique).Count -ne 44) { throw 'Expected 44 unique validated identities' }
foreach ($entry in $pool.entries) {
  if ($entry.sid -notmatch '^S-1-15-2-(\d+-){6}\d+$' -or $entry.profileName -notmatch '^BridgeV2\.[a-zA-Z0-9-]+\.[0-9a-fA-F-]{36}$') { throw 'Invalid AppContainer identity' }
  $mapping = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\' + $entry.sid
  if (-not (Test-Path -LiteralPath $mapping)) { throw ('Missing identity mapping: ' + $entry.sid) }
}
$tool = Join-Path $env:SystemRoot 'System32/CheckNetIsolation.exe'
if ($ValidateOnly) {
  $inventory = & $tool LoopbackExempt -s 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw ('Loopback inventory failed: ' + $inventory) }
  $existing = @([regex]::Matches($inventory, 'S-1-15-2-(?:\d+-){6}\d+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
  [ordered]@{ validationPassed = $true; targets = $sids.Count; missing = @($sids | Where-Object { $existing -notcontains $_ }).Count; poolHash = $poolHash; noChangesMade = $true } | ConvertTo-Json -Compress
  exit 0
}
$logDirectory = Join-Path $cohort ('loopback-admin/' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $logDirectory | Out-Null
$report = [ordered]@{ passed = $false; observedAt = [DateTime]::UtcNow.ToString('o'); poolHash = $poolHash; scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); targets = $sids; added = @(); commands = @(); error = $null }
try {
  $before = & $tool LoopbackExempt -s 2>&1 | Out-String
  $beforeExit = $LASTEXITCODE
  [IO.File]::WriteAllText((Join-Path $logDirectory 'before.log'), $before)
  if ($beforeExit -ne 0) { throw ('Loopback inventory failed: ' + $before) }
  $beforeSids = @([regex]::Matches($before, 'S-1-15-2-(?:\d+-){6}\d+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
  foreach ($sid in $sids) {
    if ($beforeSids -contains $sid) { continue }
    $output = & $tool LoopbackExempt -a ('-p=' + $sid) 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $logName = 'add-' + $report.commands.Count + '.log'
    [IO.File]::WriteAllText((Join-Path $logDirectory $logName), $output)
    $report.commands += [ordered]@{ executable = $tool; argv = @('LoopbackExempt', '-a', ('-p=' + $sid)); exitCode = $exitCode; output = $logName }
    if ($exitCode -ne 0) { throw ('Loopback addition failed for ' + $sid + ': ' + $output) }
    $report.added += $sid
  }
  $after = & $tool LoopbackExempt -s 2>&1 | Out-String
  $afterExit = $LASTEXITCODE
  [IO.File]::WriteAllText((Join-Path $logDirectory 'after.log'), $after)
  if ($afterExit -ne 0) { throw ('Loopback verification failed: ' + $after) }
  $afterSids = @([regex]::Matches($after, 'S-1-15-2-(?:\d+-){6}\d+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
  if (@($sids | Where-Object { $afterSids -notcontains $_ }).Count -ne 0) { throw 'Target exemptions missing after addition' }
  if (@($beforeSids | Where-Object { $afterSids -notcontains $_ }).Count -ne 0) { throw 'Existing exemptions changed unexpectedly' }
  $report.passed = $true
} catch { $report.error = $_.Exception.Message }
$reportPath = Join-Path $logDirectory 'report.json'
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
[ordered]@{ passed = $report.passed; added = $report.added.Count; report = $reportPath; error = $report.error } | ConvertTo-Json -Compress
if (-not $report.passed) { exit 1 }
