import { execFileSync } from "node:child_process";

export type SessionProcess = { pid?: number; processStartedAt?: string; updatedAt?: string };
export type SessionLiveness = "running" | "ended" | "unknown";
let snapshot: Map<number, string | undefined> | undefined;
let checkedAt = 0;

export function readSessionProcessStart(pid: number, refresh = false): string | null | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "win32") return undefined;
  if (refresh || Date.now() - checkedAt > 1000) {
    try {
      const script = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; startedAt = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } }) | ConvertTo-Json -Compress";
      const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const rows = JSON.parse(result) as { pid: number; startedAt: string }[];
      snapshot = new Map(rows.map((row) => [row.pid, Number.isFinite(Date.parse(row.startedAt)) ? new Date(row.startedAt).toISOString() : undefined]));
    } catch { snapshot = undefined; }
    checkedAt = Date.now();
  }
  return snapshot ? snapshot.has(pid) ? snapshot.get(pid) : null : undefined;
}

export function sessionProcessLiveness(binding: SessionProcess | undefined,
  readStart: (pid: number) => string | null | undefined = readSessionProcessStart): SessionLiveness {
  if (!binding?.pid) return "unknown";
  const actual = readStart(binding.pid);
  if (actual === null) return "ended";
  if (actual === undefined) return "unknown";
  if (binding.processStartedAt) return Date.parse(actual) === Date.parse(binding.processStartedAt) ? "running" : "ended";
  const registered = Date.parse(binding.updatedAt ?? "");
  return Number.isFinite(registered) && Date.parse(actual) > registered ? "ended" : "unknown";
}
