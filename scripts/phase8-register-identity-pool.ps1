param(
  [Parameter(Mandatory=$true)][ValidateSet('Discover','Audit')][string]$Mode,
  [string]$InputFile
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($Mode -eq 'Discover') {
  $registryPath = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings'
  $candidates = @()
  foreach ($key in Get-ChildItem -LiteralPath $registryPath -ErrorAction Stop) {
    $moniker = $key.GetValue('Moniker')
    if ($moniker -is [string] -and $moniker -imatch '^BridgeV2\.[A-Za-z0-9.-]{1,54}$' -and $key.PSChildName -match '^S-1-15-2-(\d+-){6}\d+$') {
      $candidates += [ordered]@{profileName=('BridgeV2.' + $moniker.Substring(9)); mappingMoniker=$moniker; sid=$key.PSChildName; localAppData=$env:PHASE8_HOST_LOCALAPPDATA; registryPath=$key.Name}
    }
  }
  [ordered]@{schemaVersion=1; scanComplete=$true; registryPath=$registryPath; candidates=@($candidates)} | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
$data = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$sids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($candidate in $data.candidates) { [void]$sids.Add($candidate.sid) }
$matchesFound = [System.Collections.Generic.List[object]]::new()
$links = [System.Collections.Generic.List[object]]::new()
$failures = [System.Collections.Generic.List[object]]::new()
$pending = [System.Collections.Generic.Stack[string]]::new()
$visited = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$rootPath = [System.IO.Path]::GetFullPath($data.root).TrimEnd('\')
$pending.Push($data.root)
$checked = 0
while ($pending.Count -gt 0) {
  $path = $pending.Pop()
  if (-not $visited.Add($path)) { continue }
  try {
    $attributes = [System.IO.File]::GetAttributes($path)
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    $entry = if ($isDirectory) { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) }
    $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($entry)
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($sids.Contains($rule.IdentityReference.Value) -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
        $matchesFound.Add([ordered]@{sid=$rule.IdentityReference.Value; path=$path; rights=$rule.FileSystemRights.ToString(); inherited=$rule.IsInherited})
      }
    }
    $checked++
    if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      $target = $entry.ResolveLinkTarget($true)
      if ($null -eq $target) { throw 'Unresolved reparse point prevents exhaustive project ACL inspection' }
      $resolvedPath = [System.IO.Path]::GetFullPath($target.FullName)
      if (-not ($resolvedPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedPath.StartsWith($rootPath + '\', [System.StringComparison]::OrdinalIgnoreCase))) {
        throw ('Reparse point target outside project: ' + $resolvedPath)
      }
      $pending.Push($resolvedPath)
      $links.Add([ordered]@{path=$path; target=$resolvedPath})
      continue
    }
    if ($isDirectory) {
      foreach ($child in $entry.EnumerateFileSystemInfos()) { $pending.Push($child.FullName) }
    }
  } catch {
    $failures.Add([ordered]@{path=$path; error=$_.Exception.Message})
    break
  }
}
[ordered]@{schemaVersion=1; root=$data.root; candidateSids=@($sids | Sort-Object); checked=$checked; scanComplete=($failures.Count -eq 0); links=@($links.ToArray()); matches=@($matchesFound.ToArray()); failures=@($failures.ToArray())} | ConvertTo-Json -Depth 6 -Compress
if ($failures.Count -ne 0) { exit 2 }
