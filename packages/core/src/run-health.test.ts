import { describe, expect, it } from "vitest";
import { describeInfraFailure, detectInfraFailure } from "./run-health.js";

// Verbatim from a codex run in D:\TAILIEU\MyProject\AI_Tool\MCP_KiCad: pwsh on
// PATH was an MSIX App Execution Alias, which cannot be launched under the
// unelevated sandbox token. The run still exited 0.
const SANDBOX_DENIAL =
  'ERROR codex_core::exec: exec error: windows sandbox: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=D:\\TAILIEU\\MyProject\\AI_Tool\\MCP_KiCad | cmd=C:\\Users\\rkaka\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe -Command "Get-Location"';

describe("detectInfraFailure", () => {
  it("flags a run whose every command was refused by the sandbox", () => {
    const failure = detectInfraFailure([SANDBOX_DENIAL, SANDBOX_DENIAL, SANDBOX_DENIAL].join("\n"))!;

    expect(failure.kind).toBe("sandbox-spawn-denied");
    expect(failure.occurrences).toBe(3);
    expect(failure.sample).toContain("CreateProcessAsUserW failed: 5");
    expect(failure.detail).toContain("MSIX App Execution Alias");
  });

  it("ignores a one-off denial, which is a normal failure an agent can work around", () => {
    expect(detectInfraFailure(`${SANDBOX_DENIAL}\nretrying with a different path\nok`)).toBeUndefined();
  });

  it("does not mistake ordinary tool errors for a broken environment", () => {
    const log = [
      "Error: EACCES: permission denied, open 'C:\\locked\\config.json'",
      "Error: ENOENT: no such file or directory, open 'missing.ts'",
      "npm ERR! code EPERM",
      "Access is denied.",
      "The build failed with 3 errors.",
    ].join("\n");

    // Every line here comes from a command that actually ran. Blocking the
    // subtask on these would throw away real work.
    expect(detectInfraFailure(log)).toBeUndefined();
  });

  it("catches a missing shell and a refused spawn", () => {
    const enoent = "Error: spawn pwsh.exe ENOENT";
    expect(detectInfraFailure([enoent, enoent, enoent].join("\n"))?.kind).toBe("shell-not-found");

    const eacces = "Error: spawn /bin/sh EACCES";
    expect(detectInfraFailure([eacces, eacces, eacces].join("\n"))?.kind).toBe("spawn-permission-denied");
  });

  it("summarises the failure as an environment problem, not shoddy work", () => {
    const summary = describeInfraFailure(detectInfraFailure(Array(5).fill(SANDBOX_DENIAL).join("\n"))!);

    expect(summary).toContain("ENVIRONMENT FAILURE");
    expect(summary).toContain("5 refusals");
    expect(summary).toContain("No code was written.");
    expect(summary).toContain("staff a different provider");
  });
});
