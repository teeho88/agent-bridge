$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\' + $env:PHASE8_PROFILE_SID
$package = Join-Path $env:PHASE8_HOST_LOCALAPPDATA ('Packages\' + $env:PHASE8_PROFILE_NAME)
$files = @()
$links = @()
foreach ($ancestor in @($env:PHASE8_HOST_LOCALAPPDATA, (Split-Path -Parent $package))) {
  if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $links += $ancestor }
}
$mappingMoniker = $null
if (Test-Path -LiteralPath $key) { $mappingMoniker = (Get-ItemProperty -LiteralPath $key).Moniker }
if (Test-Path -LiteralPath $package) {
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($package)
  while ($pending.Count -gt 0) {
    $entry = Get-Item -LiteralPath $pending.Pop() -Force
    if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $links += $entry.FullName; continue }
    if ($entry.PSIsContainer) {
      foreach ($child in Get-ChildItem -LiteralPath $entry.FullName -Force) { $pending.Push($child.FullName) }
    } else {
      $files += [ordered]@{relative=$entry.FullName.Substring($package.Length); bytes=$entry.Length; writeUtc=$entry.LastWriteTimeUtc.ToString('o')}
    }
  }
}
[ordered]@{mappingExists=(Test-Path -LiteralPath $key); packageExists=(Test-Path -LiteralPath $package); moniker=$env:PHASE8_PROFILE_NAME; mappingMoniker=$mappingMoniker; sid=$env:PHASE8_PROFILE_SID; packagePath=$package; registryPath=$key; scanComplete=$true; reparsePoints=@($links); files=@($files | Sort-Object { $_.relative })} | ConvertTo-Json -Depth 5 -Compress
