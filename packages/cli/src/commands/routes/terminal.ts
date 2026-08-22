import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AgentKind, Task } from "@agent-bridge/memory";

// Opening and focusing the OS terminal windows that agent sessions run in.

export function commandExists(command: string): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export function focusAgentTerminal(
  task: Task,
  agent: AgentKind,
  sessionId: string,
  sessionWindow?: { hwnd?: string; windowId?: string; pid?: number },
): { focused: boolean; patterns: string[]; hwnd?: string; windowId?: string; reason?: string } {
  const patterns = [
    terminalTitle(agent, task.id, sessionId),
    sessionId,
  ];
  const hwnd = sessionWindow?.hwnd;
  const windowId = sessionWindow?.windowId;
  if (process.platform !== "win32") {
    return {
      focused: false,
      patterns,
      hwnd,
      windowId,
      reason: "Window focus is currently implemented for Windows terminals.",
    };
  }
  if (hwnd) {
    const byHandle = focusWindowByHandle(hwnd);
    if (byHandle.focused) return { ...byHandle, patterns, windowId };
  }
  if (windowId) {
    if (sessionWindow?.pid && !isProcessAlive(sessionWindow.pid)) {
      return { focused: false, patterns, hwnd, windowId, reason: "The terminal process has closed." };
    }
    try {
      execFileSync("wt.exe", ["-w", windowId, "focus-tab", "-t", "0"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
      return { focused: true, patterns, hwnd, windowId };
    } catch (error) {
      return {
        focused: false,
        patterns,
        hwnd,
        windowId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const script = `
$patterns = @(${patterns.map((pattern) => psString(pattern)).join(", ")})
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AgentBridgeWindowFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$script:found = [IntPtr]::Zero
[AgentBridgeWindowFocus]::EnumWindows({
  param($hWnd, $lParam)
  if (-not [AgentBridgeWindowFocus]::IsWindowVisible($hWnd)) { return $true }
  $text = New-Object System.Text.StringBuilder 512
  [void][AgentBridgeWindowFocus]::GetWindowText($hWnd, $text, $text.Capacity)
  $title = $text.ToString()
  foreach ($pattern in $patterns) {
    if ($title -like "*$pattern*") {
      $script:found = $hWnd
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:found -eq [IntPtr]::Zero) { exit 2 }
[void][AgentBridgeWindowFocus]::ShowWindowAsync($script:found, 9)
[void][AgentBridgeWindowFocus]::SetForegroundWindow($script:found)
`;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    return { focused: true, patterns, hwnd };
  } catch (error) {
    return {
      focused: false,
      patterns,
      hwnd,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function focusWindowByHandle(hwnd: string): { focused: boolean; hwnd: string; reason?: string } {
  const numericHwnd = Number(hwnd);
  if (!Number.isFinite(numericHwnd) || numericHwnd <= 0) {
    return { focused: false, hwnd, reason: "Invalid window handle." };
  }
  const script = `
$hwnd = [IntPtr]${Math.trunc(numericHwnd)}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentBridgeWindowHandleFocus {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
}
"@
if (-not [AgentBridgeWindowHandleFocus]::IsWindow($hwnd)) { exit 2 }
[void][AgentBridgeWindowHandleFocus]::ShowWindowAsync($hwnd, 9)
[AgentBridgeWindowHandleFocus]::SwitchToThisWindow($hwnd, $true)
[void][AgentBridgeWindowHandleFocus]::SetForegroundWindow($hwnd)
`;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    return { focused: true, hwnd };
  } catch (error) {
    return {
      focused: false,
      hwnd,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function terminalTitle(agent: AgentKind, taskId: string, sessionId: string): string {
  return `AgentBridge ${agent} ${taskId} ${sessionId}`;
}

export function launchAgentTerminal(
  cwd: string,
  task: Task,
  agent: AgentKind,
  sessionId: string,
  command: string,
  uiPort: number,
): { launcherPid?: number; title: string; windowId: string } {
  const title = terminalTitle(agent, task.id, sessionId);
  const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AgentBridgeTerminalWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
  $script:terminalHwnd = [IntPtr]::Zero
  $deadline = [DateTime]::UtcNow.AddSeconds(1)
  do {
    [AgentBridgeTerminalWindow]::EnumWindows({
      param($hWnd, $lParam)
      if (-not [AgentBridgeTerminalWindow]::IsWindowVisible($hWnd)) { return $true }
      $text = New-Object System.Text.StringBuilder 512
      [void][AgentBridgeTerminalWindow]::GetWindowText($hWnd, $text, $text.Capacity)
      if ($text.ToString() -eq ${psString(title)}) { $script:terminalHwnd = $hWnd; return $false }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($script:terminalHwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 50 }
  } while ($script:terminalHwnd -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
  $registration = @{ sessionId = ${psString(sessionId)}; windowId = ${psString(sessionId)}; pid = $PID }
  if ($script:terminalHwnd -ne [IntPtr]::Zero) { $registration.hwnd = $script:terminalHwnd.ToInt64().ToString() }
  $payload = $registration | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri ${psString(`http://127.0.0.1:${uiPort}/api/session/window`)} -Method Post -ContentType 'application/json' -Body $payload | Out-Null
} catch {
  Write-Warning 'Agent Bridge could not register this terminal window.'
}
$env:AGENT_BRIDGE_TERMINAL_SESSION_ID = ${psString(sessionId)}
& ${psString(command)}
`;
  if (!commandExists("wt.exe")) {
    throw new Error("Windows Terminal (wt.exe) is required to open a visible agent terminal.");
  }
  const child = spawn(
    "wt.exe",
    [
      "-w",
      sessionId,
      "new-tab",
      "--title",
      title,
      "--suppressApplicationTitle",
      "-d",
      cwd,
      "powershell.exe",
      "-NoLogo",
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { cwd, detached: true, stdio: "ignore", windowsHide: false },
  );
  child.on("error", () => undefined);
  child.unref();
  return { launcherPid: child.pid, title, windowId: sessionId };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
