param([switch]$Preview)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Run this script with PowerShell 7: pwsh -NoProfile -File .\scripts\cleanup-project.ps1'
}
if (-not $IsWindows) { throw 'This script requires Windows.' }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$prefix = $projectRoot + '\'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'pnpm-workspace.yaml'))) {
    throw 'Project marker pnpm-workspace.yaml is missing.'
}

if (-not ('ProjectCleanup.Files' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;

namespace ProjectCleanup {
    public static class Files {
        public static long Removed;
        public static long Bytes;
        public static readonly List<string> Errors = new List<string>();

        public static string LongPath(string path) {
            if (path.StartsWith(@"\\?\")) return path;
            if (path.StartsWith(@"\\")) return @"\\?\UNC\" + path.Substring(2);
            return @"\\?\" + path;
        }

        public static void Remove(string path) {
            try {
                var attributes = File.GetAttributes(path);
                bool directory = (attributes & FileAttributes.Directory) != 0;
                bool link = (attributes & FileAttributes.ReparsePoint) != 0;
                if (directory && !link) {
                    foreach (var child in Directory.EnumerateFileSystemEntries(path)) Remove(child);
                }
                if (!link && (attributes & FileAttributes.ReadOnly) != 0) {
                    File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
                }
                long size = !directory && !link ? new FileInfo(path).Length : 0;
                if (directory) Directory.Delete(path, false);
                else File.Delete(path);
                Removed++;
                Bytes += size;
            } catch (FileNotFoundException) {
            } catch (DirectoryNotFoundException) {
            } catch (Exception error) {
                Errors.Add(path + ": " + error.Message);
            }
        }
    }
}
'@
}

[ProjectCleanup.Files]::Removed = 0
[ProjectCleanup.Files]::Bytes = 0
[ProjectCleanup.Files]::Errors.Clear()

function Assert-ProjectPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path outside project: $full"
    }
    $ancestor = [IO.Path]::GetDirectoryName($full)
    while ($ancestor) {
        $attributes = [IO.File]::GetAttributes([ProjectCleanup.Files]::LongPath($ancestor))
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Linked ancestor is not allowed: $ancestor"
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $full
}

$targets = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$manifests = [Collections.Generic.List[string]]::new()
$fixed = @(
    '.bridge-tmp', '.phase8-tmp', '.local', 'next/.local', 'r', 'docs', 'next/tests',
    'scripts/memory-runtime.vitest.config.mts', 'scripts/memory-runtime.tsconfig.json',
    'scripts/memory-runtime-fixtures.mts', 'scripts/memory-runtime-fixtures.mjs',
    'scripts/phase8-clean-test-scratch.ps1', 'scripts/phase0-preflight.mjs',
    'scripts/phase8-isolation-retry.mjs', 'scripts/phase8-native-evidence-check.mjs',
    'scripts/phase8-recovery-prepare.mjs', 'scripts/phase8-remediation-check.mjs',
    'scripts/phase83-verify.mjs', 'scripts/phase83-close-verifiable.mjs',
    'scripts/installed-cli-smoke.mjs', 'scripts/bridge-uncached-smoke.mjs',
    'scripts/phase7-routing-smoke.mjs'
)
foreach ($relative in $fixed) {
    [void]$targets.Add([IO.Path]::GetFullPath((Join-Path $projectRoot $relative)))
}

$cacheNames = @('.cache', '.vite', '.vitest', '.turbo', '.parcel-cache', '__pycache__',
    '.pytest_cache', 'coverage', 'test-results', 'playwright-report')
$skipNames = @('.git', '.agent-memory', '.remediation-backups')
$stack = [Collections.Generic.Stack[string]]::new()
$stack.Push($projectRoot)
while ($stack.Count) {
    $directory = $stack.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
        if ($targets.Contains($entry)) { continue }
        $name = [IO.Path]::GetFileName($entry)
        $attributes = [IO.File]::GetAttributes($entry)
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($attributes -band [IO.FileAttributes]::Directory) {
            if ($skipNames -contains $name) { continue }
            if ($cacheNames -contains $name) {
                [void]$targets.Add($entry)
            } elseif ($name -eq 'node_modules') {
                foreach ($cache in $cacheNames) {
                    [void]$targets.Add((Join-Path $entry $cache))
                }
            } else {
                $stack.Push($entry)
            }
        } else {
            if ($name -eq 'package.json') { $manifests.Add($entry) }
            if ($name -match '\.(test|spec)\.|\.tsbuildinfo$|^(vitest|jest|playwright)\.config\.|^\.eslintcache$') {
                [void]$targets.Add($entry)
            }
        }
    }
}

$existing = [Collections.Generic.List[string]]::new()
foreach ($target in $targets) {
    $full = Assert-ProjectPath $target
    try {
        [void][IO.File]::GetAttributes([ProjectCleanup.Files]::LongPath($full))
        $existing.Add($full)
    } catch [IO.FileNotFoundException] {
    } catch [IO.DirectoryNotFoundException] {
    }
}

Write-Host ("Targets: {0}" -f $existing.Count)
foreach ($target in ($existing | Sort-Object)) {
    $relative = [IO.Path]::GetRelativePath($projectRoot, $target)
    if ($Preview) {
        Write-Host "PREVIEW: $relative"
    } else {
        Write-Host "Removing: $relative"
        [ProjectCleanup.Files]::Remove([ProjectCleanup.Files]::LongPath($target))
    }
}

if ($Preview) {
    Write-Host 'Preview only. No files or configuration were changed.'
    return
}

$report = [ordered]@{
    root = $projectRoot
    removedEntries = [ProjectCleanup.Files]::Removed
    removedBytes = [ProjectCleanup.Files]::Bytes
    errors = @([ProjectCleanup.Files]::Errors.ToArray())
}
$reportPath = Join-Path $projectRoot 'cleanup-report.json'
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host ("Removed {0} entries; {1:N2} GiB. Report: {2}" -f $report.removedEntries, ($report.removedBytes / 1GB), $reportPath)
if ([ProjectCleanup.Files]::Errors.Count) {
    [ProjectCleanup.Files]::Errors | Select-Object -First 15 | ForEach-Object { Write-Warning $_ }
    throw "Some entries could not be removed. See $reportPath and rerun after resolving the errors. Test dependencies were retained."
}

foreach ($file in $manifests) {
    [void](Assert-ProjectPath $file)
    $data = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable
    $changed = $false
    if ($data.ContainsKey('scripts')) {
        foreach ($key in @($data.scripts.Keys)) {
            if ($key -match '^(test(?::|$)|fixture$)') {
                [void]$data.scripts.Remove($key)
                $changed = $true
            }
        }
    }
    foreach ($section in @('dependencies', 'devDependencies')) {
        if ($data.ContainsKey($section) -and $data[$section].ContainsKey('vitest')) {
            [void]$data[$section].Remove('vitest')
            $changed = $true
        }
    }
    if ($changed) {
        $data | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $file -Encoding utf8
    }
}

$lockPath = Join-Path $projectRoot 'next/package-lock.json'
if (Test-Path -LiteralPath $lockPath) {
    [void](Assert-ProjectPath $lockPath)
    if (([IO.File]::GetAttributes($lockPath)) -band [IO.FileAttributes]::ReparsePoint) {
        throw "Linked lockfile is not allowed: $lockPath"
    }
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json -AsHashtable
    $changed = $false
    if ($lock.ContainsKey('packages')) {
        foreach ($entry in $lock.packages.Values) {
            if ($entry.ContainsKey('devDependencies') -and $entry.devDependencies.ContainsKey('vitest')) {
                [void]$entry.devDependencies.Remove('vitest')
                $changed = $true
            }
        }
    }
    if ($changed) {
        $lock | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $lockPath -Encoding utf8
    }
}

Push-Location -LiteralPath $projectRoot
try {
    & corepack pnpm install --offline --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency synchronization failed.' }
    & corepack pnpm -r lint
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript verification failed.' }
} finally {
    Pop-Location
}
Write-Host 'Cleanup completed.'
