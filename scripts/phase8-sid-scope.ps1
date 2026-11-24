param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
$inputStream = [System.IO.File]::OpenRead($InputFile)
$jsonStream = $inputStream
try {
  if ($InputFile.EndsWith('.gz', [StringComparison]::OrdinalIgnoreCase)) {
    $jsonStream = [System.IO.Compression.GZipStream]::new($inputStream, [System.IO.Compression.CompressionMode]::Decompress, $true)
  }
  $inputData = [System.Text.Json.JsonDocument]::Parse($jsonStream)
} finally {
  if ($jsonStream -ne $inputStream) { $jsonStream.Dispose() }
  $inputStream.Dispose()
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Threading.Tasks;

public sealed class Phase8ScopeMatch {
  public string path { get; set; }
  public string rights { get; set; }
  public string type { get; set; }
}
public sealed class Phase8ScopeFailure {
  public string path { get; set; }
  public string error { get; set; }
}
public sealed class Phase8ScopeResult {
  public string sid { get; set; }
  public int @checked { get; set; }
  public List<Phase8ScopeMatch> matches { get; } = new List<Phase8ScopeMatch>();
  public List<Phase8ScopeFailure> failures { get; } = new List<Phase8ScopeFailure>();
  public bool passed { get { return failures.Count == 0 && matches.Count == 0; } }
}
public static class Phase8ScopeAudit {
  public static Phase8ScopeResult Run(JsonElement input) {
    var result = new Phase8ScopeResult { sid = input.GetProperty("sid").GetString() };
    var executables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    JsonElement allowed;
    if (input.TryGetProperty("readOnlyExecutables", out allowed)) {
      foreach (var executable in allowed.EnumerateArray()) executables.Add(executable.GetString());
    }
    var allowedRights = FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
    var entries = new List<JsonElement>();
    foreach (var entry in input.GetProperty("entries").EnumerateArray()) entries.Add(entry);
    var matches = new List<Phase8ScopeMatch>[entries.Count];
    var failures = new Phase8ScopeFailure[entries.Count];
    var completed = new bool[entries.Count];
    Parallel.For(0, entries.Count, new ParallelOptions {
      MaxDegreeOfParallelism = Math.Min(4, Environment.ProcessorCount)
    }, index => {
      var entry = entries[index];
      var path = entry.GetProperty("path").GetString();
      var directory = entry.GetProperty("directory").GetBoolean();
      try {
        FileSystemSecurity acl = directory
          ? FileSystemAclExtensions.GetAccessControl(new DirectoryInfo(path))
          : FileSystemAclExtensions.GetAccessControl(new FileInfo(path));
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
          if (!String.Equals(rule.IdentityReference.Value, result.sid, StringComparison.OrdinalIgnoreCase)) continue;
          if (executables.Contains(path) && !directory && rule.AccessControlType == AccessControlType.Allow &&
              (rule.FileSystemRights & ~allowedRights) == 0) continue;
          if (matches[index] == null) matches[index] = new List<Phase8ScopeMatch>();
          matches[index].Add(new Phase8ScopeMatch {
            path = path, rights = rule.FileSystemRights.ToString(), type = rule.AccessControlType.ToString()
          });
        }
        completed[index] = true;
      } catch (Exception error) {
        failures[index] = new Phase8ScopeFailure { path = path, error = error.Message };
      }
    });
    for (var index = 0; index < entries.Count; index++) {
      if (completed[index]) result.@checked++;
      if (matches[index] != null) result.matches.AddRange(matches[index]);
      if (failures[index] != null) result.failures.Add(failures[index]);
    }
    return result;
  }
}
'@
try {
  $result = [Phase8ScopeAudit]::Run($inputData.RootElement)
} finally {
  $inputData.Dispose()
}
$result | ConvertTo-Json -Depth 5 -Compress
if (-not $result.passed) { exit 2 }
