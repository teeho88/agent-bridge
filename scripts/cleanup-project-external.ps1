param([switch]$Preview)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run this script with PowerShell 7.' }
if (-not $IsWindows) { throw 'This script requires Windows.' }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$planPath = Join-Path $projectRoot 'external-cleanup-plan.json'
$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json -AsHashtable
if ($plan.root -ine $projectRoot) { throw 'Cleanup plan belongs to another project.' }

if (-not ('ProjectExternalCleanup.Profiles' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
namespace ProjectExternalCleanup {
    public static class Profiles {
        [DllImport("userenv.dll", CharSet=CharSet.Unicode)]
        public static extern int DeleteAppContainerProfile(string name);
        [DllImport("userenv.dll", CharSet=CharSet.Unicode)]
        private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
        [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
        public static string Sid(string name) {
            IntPtr sid;
            Marshal.ThrowExceptionForHR(DeriveAppContainerSidFromAppContainerName(name, out sid));
            try { return new SecurityIdentifier(sid).Value; }
            finally { FreeSid(sid); }
        }
    }
}
'@
}

$mappingRoot = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Packages'))
$validated = [Collections.Generic.List[object]]::new()
foreach ($name in @($plan.profiles | Select-Object -Unique)) {
    if ($name -notmatch '^BridgeV2\.[A-Za-z0-9.-]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw "Unexpected profile name: $name"
    }
    $sid = [ProjectExternalCleanup.Profiles]::Sid($name)
    $keyPath = Join-Path $mappingRoot $sid
    $directory = [IO.Path]::GetFullPath((Join-Path $packageRoot $name))
    if ([IO.Path]::GetDirectoryName($directory) -ine $packageRoot) { throw 'Invalid profile directory.' }
    if (-not (Test-Path -LiteralPath $keyPath)) {
        if (Test-Path -LiteralPath $directory) { throw "Profile has storage but no verified registry mapping: $name" }
        continue
    }
    $key = Get-Item -LiteralPath $keyPath
    if ($key.GetValue('Moniker') -ine $name) { throw "Registry identity mismatch: $name" }
    $validated.Add([pscustomobject]@{Name=$name;Sid=$sid;Directory=$directory;Registry=$keyPath})
}

$indexPath = Join-Path $env:USERPROFILE '.agent-memory-linker/session-directories.json'
$indexMatches = 0
if (Test-Path -LiteralPath $indexPath) {
    $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json -AsHashtable
    foreach ($entry in $index.Values) {
        if ($entry.ContainsKey('cwd') -and $entry.cwd -is [string]) {
            $cwd = $entry.cwd.TrimEnd('\')
            if ($cwd -ieq $projectRoot -or $cwd.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $indexMatches++
            }
        }
    }
}
Write-Host ("Verified sandbox profiles: {0}; project cache index entries: {1}" -f $validated.Count, $indexMatches)
if ($Preview) {
    Write-Host 'Preview only. Shared npm/pnpm/Node caches, agent configuration, handoffs and conversation files are excluded.'
    return
}

$backupDirectory = Join-Path $projectRoot '.remediation-backups/external-cleanup'
[void][IO.Directory]::CreateDirectory($backupDirectory)
$report = [ordered]@{root=$projectRoot;removedProfiles=@();removedIndexEntries=0;removedTemporaryFiles=@();errors=@()}
foreach ($profile in $validated) {
    Write-Host ("Removing sandbox: {0}" -f $profile.Name)
    $result = [ProjectExternalCleanup.Profiles]::DeleteAppContainerProfile($profile.Name)
    if ($result -ne 0) {
        $report.errors += "Failed to remove $($profile.Name): HRESULT $result"
    } elseif ((Test-Path -LiteralPath $profile.Directory) -or (Test-Path -LiteralPath $profile.Registry)) {
        $report.errors += "Profile removal left storage or registry mapping: $($profile.Name)"
    } else {
        $report.removedProfiles += $profile.Name
    }
}

if (Test-Path -LiteralPath $indexPath) {
    if (([IO.File]::GetAttributes($indexPath)) -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked cache index is not allowed.' }
    $stream = [IO.File]::Open($indexPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 4096, $true)
        $original = $reader.ReadToEnd()
        $reader.Dispose()
        $index = $original | ConvertFrom-Json -AsHashtable
        foreach ($key in @($index.Keys)) {
            $entry = $index[$key]
            if ($entry.ContainsKey('cwd') -and $entry.cwd -is [string]) {
                $cwd = $entry.cwd.TrimEnd('\')
                if ($cwd -ieq $projectRoot -or $cwd.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    [void]$index.Remove($key)
                    $report.removedIndexEntries++
                }
            }
        }
        if ($report.removedIndexEntries) {
            $backupPath = Join-Path $backupDirectory ('session-directories.' + [guid]::NewGuid().ToString('N') + '.json')
            [IO.File]::WriteAllText($backupPath, $original, [Text.UTF8Encoding]::new($false))
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($index | ConvertTo-Json -Depth 100 -Compress))
            $stream.Position = 0
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.SetLength($bytes.Length)
            $stream.Flush($true)
        }
    } finally {
        $stream.Dispose()
    }
}

foreach ($name in @('agent-bridge-cleanup-plan.json', 'agent-bridge-cleanup-result.json')) {
    $temporaryPath = [IO.Path]::GetFullPath((Join-Path $env:TEMP $name))
    if ([IO.Path]::GetDirectoryName($temporaryPath) -ine [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')) { throw 'Invalid temporary path.' }
    if (Test-Path -LiteralPath $temporaryPath) {
        if (([IO.File]::GetAttributes($temporaryPath)) -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked temporary file is not allowed.' }
        $metadata = Get-Content -LiteralPath $temporaryPath -Raw | ConvertFrom-Json -AsHashtable
        if ($metadata.ContainsKey('root') -and $metadata.root -ieq $projectRoot) {
            Remove-Item -LiteralPath $temporaryPath -Force
            $report.removedTemporaryFiles += $temporaryPath
        }
    }
}

$reportPath = Join-Path $projectRoot 'external-cleanup-report.json'
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host ("Removed profiles: {0}; cache index entries: {1}. Report: {2}" -f $report.removedProfiles.Count, $report.removedIndexEntries, $reportPath)
if ($report.errors.Count) {
    $report.errors | ForEach-Object { Write-Warning $_ }
    throw 'Some verified sandbox profiles could not be removed. See external-cleanup-report.json.'
}
