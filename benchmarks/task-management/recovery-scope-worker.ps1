param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$PolicyScript,[Parameter(Mandatory=$true)][string]$PolicyHash)
$ErrorActionPreference='Stop'
if ((Get-FileHash -LiteralPath $PolicyScript -Algorithm SHA256).Hash.ToLowerInvariant() -ne $PolicyHash) { throw 'Scope policy source hash mismatch' }
$source=[IO.File]::ReadAllText($PolicyScript)
$match=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (!$match.Success) { throw 'Scope policy compiled implementation missing' }
$adapter=@'
public static class Phase8RecoveryScopeStream {
  public static Phase8ScopeResult Run(string path) {
    using (var input = new System.IO.StreamReader(path)) {
      string first = input.ReadLine();
      if (first == null) throw new System.IO.InvalidDataException("Missing scope header");
      string sid, allowed;
      using (var meta = System.Text.Json.JsonDocument.Parse(first)) {
        if (meta.RootElement.GetProperty("kind").GetString() != "scope-header") throw new System.IO.InvalidDataException("Invalid scope header");
        sid = meta.RootElement.GetProperty("sid").GetString();
        allowed = meta.RootElement.GetProperty("readOnlyExecutables").GetRawText();
      }
      var result = new Phase8ScopeResult { sid = sid };
      var batch = new System.Collections.Generic.List<string>(4096);
      string prefix = "{\"sid\":" + System.Text.Json.JsonSerializer.Serialize(sid) + ",\"readOnlyExecutables\":" + allowed + ",\"entries\":[";
      long expected = -1, observed = 0;
      string line;
      while ((line = input.ReadLine()) != null) {
        if (expected >= 0) throw new System.IO.InvalidDataException("Trailing scope records");
        using (var entry = System.Text.Json.JsonDocument.Parse(line)) {
          System.Text.Json.JsonElement kind;
          if (entry.RootElement.TryGetProperty("kind", out kind)) {
            if (kind.GetString() != "scope-end") throw new System.IO.InvalidDataException("Unexpected scope record");
            expected = entry.RootElement.GetProperty("entries").GetInt64();
            continue;
          }
          entry.RootElement.GetProperty("path").GetString();
          entry.RootElement.GetProperty("directory").GetBoolean();
        }
        batch.Add(line); observed++;
        if (batch.Count == 4096) Flush(prefix, batch, result);
      }
      if (expected < 0 || expected != observed) throw new System.IO.InvalidDataException("Truncated scope enumeration");
      if (batch.Count > 0) Flush(prefix, batch, result);
      return result;
    }
  }
  private static void Flush(string prefix, System.Collections.Generic.List<string> batch, Phase8ScopeResult result) {
    using (var document = System.Text.Json.JsonDocument.Parse(prefix + string.Join(",", batch) + "]}")) {
      var partial = Phase8ScopeAudit.Run(document.RootElement);
      result.@checked += partial.@checked;
      result.matches.AddRange(partial.matches);
      result.failures.AddRange(partial.failures);
    }
    batch.Clear();
  }
}
'@
Add-Type -TypeDefinition ($match.Groups[1].Value + "`n" + $adapter)
$result=[Phase8RecoveryScopeStream]::Run($InputFile)
$result | ConvertTo-Json -Depth 5 -Compress
if (!$result.passed) { exit 2 }
