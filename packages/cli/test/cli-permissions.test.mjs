import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cliPermissionArgs } from "@agent-bridge/adapters";
import { cmdPermissionAutoRun, installCmdLaunchers, installPermissionProfile, powershellPermissionIntegration, repositoryCliPermissions, syncCodexPermissions } from "../dist/cli-permissions.js";
import { handleAntigravityHook } from "../dist/commands/antigravity.js";
import { ensureWorkspace } from "../dist/workspace.js";

function save(root, policies, enabled = true) {
  mkdirSync(join(root, ".agent-memory"), { recursive: true });
  writeFileSync(join(root, ".agent-memory/config.json"), JSON.stringify({ enabled, cliApprovalPolicies: policies }));
}

test("external launches read current repo permissions, nested folders and explicit overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-permissions-"));
  try {
    const repo = join(root, "repo");
    const nested = join(repo, "src");
    mkdirSync(nested, { recursive: true });
    const policies = { codex: "never", codexSandbox: "danger-full-access", claude: "auto", antigravity: "bypass", antigravityMode: "plan" };
    save(repo, policies);
    for (const provider of ["codex", "claude", "antigravity"]) {
      const settings = { policy: policies[provider], codexSandbox: policies.codexSandbox, antigravityMode: policies.antigravityMode };
      assert.deepEqual(repositoryCliPermissions(provider, nested), cliPermissionArgs(provider, settings));
      assert.deepEqual(repositoryCliPermissions(provider, root), []);
      assert.deepEqual(repositoryCliPermissions(provider, nested, ["--help"]), []);
      assert.deepEqual(repositoryCliPermissions(provider, nested, ["mcp", "list"]), []);
    }
    assert.deepEqual(repositoryCliPermissions("codex", root, ["-C", repo]), cliPermissionArgs("codex", { policy: "never", codexSandbox: "danger-full-access" }));
    for (const args of [["--sandbox=read-only"], ["-c", 'approval_policy="on-request"'], ["--yolo"]]) {
      assert.deepEqual(repositoryCliPermissions("codex", repo, args), []);
    }
    assert.deepEqual(repositoryCliPermissions("claude", repo, ["--permission-mode", "plan"]), []);
    save(repo, { ...policies, codex: "auto-review", claude: "plan" });
    assert.deepEqual(repositoryCliPermissions("claude", nested), ["--permission-mode", "plan"]);
    assert.ok(repositoryCliPermissions("codex", nested).includes('approvals_reviewer="auto_review"'));
    mkdirSync(join(nested, ".git"));
    assert.deepEqual(repositoryCliPermissions("codex", nested), []);
    save(repo, policies, false);
    assert.deepEqual(repositoryCliPermissions("codex", repo), []);
    writeFileSync(join(repo, ".agent-memory/config.json"), "{");
    assert.throws(() => repositoryCliPermissions("codex", repo), SyntaxError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex native sync preserves unrelated root keys and tables and updates without duplicates", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-native-permissions-"));
  try {
    mkdirSync(join(root, ".codex"));
    const path = join(root, ".codex/config.toml");
    writeFileSync(path, 'model = "custom"\napproval_policy = "on-request"\n# keep this\n[mcp_servers.example]\ncommand = "example"\napproval_policy = "nested"\n');
    const policies = { codex: "never", codexSandbox: "danger-full-access" };
    syncCodexPermissions(root, policies);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^approval_policy = "never"\nsandbox_mode = "danger-full-access"/);
    assert.ok(text.includes('model = "custom"\n# keep this\n[mcp_servers.example]\ncommand = "example"\napproval_policy = "nested"'));
    syncCodexPermissions(root, policies);
    assert.equal(readFileSync(path, "utf8"), text);
    syncCodexPermissions(root, { codex: "auto-review", codexSandbox: "read-only" });
    const changed = readFileSync(path, "utf8");
    assert.match(changed, /^approval_policy = "on-request"\nsandbox_mode = "read-only"\napprovals_reviewer = "auto_review"/);
    assert.equal(changed.match(/^sandbox_mode =/gm).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PowerShell integration preserves profile content and installs idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-profile-"));
  try {
    const path = join(root, "Microsoft.PowerShell_profile.ps1");
    writeFileSync(path, "$userSetting = 1\n");
    installPermissionProfile(path);
    const text = readFileSync(path, "utf8");
    assert.ok(text.startsWith("$userSetting = 1\n"));
    installPermissionProfile(path);
    assert.equal(readFileSync(path, "utf8"), text);
    writeFileSync(path, "# agent-bridge:cli-permissions:start");
    assert.throws(() => installPermissionProfile(path), /Incomplete/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PowerShell external and embedded launchers forward arguments, stdin and native exit codes", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-shell-"));
  try {
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    mkdirSync(bin);
    mkdirSync(repo);
    save(repo, { codex: "never", codexSandbox: "danger-full-access", claude: "auto", antigravity: "default", antigravityMode: "auto" });
    for (const command of ["codex", "claude", "agy"]) {
      writeFileSync(join(bin, `${command}.ps1`), 'ConvertTo-Json -InputObject @{argv=@($args); data=@($input)} -Compress\nexit 23\n');
    }
    const profile = join(root, "profile.ps1");
    installPermissionProfile(profile);
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const run = (cwd, script, embedded = false) => {
      const file = join(root, "run.ps1");
      writeFileSync(file, `${embedded ? powershellPermissionIntegration() : `. ${quote(profile)}`}\n${script}\nexit $LASTEXITCODE\n`);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
        cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin};${process.env.PATH}` }, windowsHide: true,
      });
      assert.equal(result.status, 23, result.stderr || result.stdout);
      return JSON.parse(result.stdout.trim());
    };
    const expected = ["--sandbox", "danger-full-access", "-c", 'approval_policy="never"', "prompt with spaces", "--model", "test"];
    for (const embedded of [false, true]) assert.deepEqual(run(repo, "codex 'prompt with spaces' --model test", embedded).argv, expected);
    assert.deepEqual(run(repo, "claude 'hello'").argv, ["--permission-mode", "auto", "hello"]);
    assert.deepEqual(run(repo, "agy 'hello'").argv, ["--mode", "auto", "hello"]);
    assert.deepEqual(run(root, "codex 'outside'").argv, ["outside"]);
    assert.deepEqual(run(repo, "codex --sandbox read-only").argv, ["--sandbox", "read-only"]);
    assert.deepEqual(run(repo, "'piped text' | codex exec -").data, ["piped text"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PowerShell integration passes valid permission arguments to a native Windows executable", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-native-shell-"));
  try {
    save(root, { codex: "never", codexSandbox: "danger-full-access", claude: "auto", antigravity: "default", antigravityMode: "auto" });
    const bin = join(root, "bin");
    mkdirSync(bin);
    const file = join(root, "run.ps1");
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    writeFileSync(file, `Add-Type -TypeDefinition @'
using System;
public class Capture {
  public static int Main(string[] args) {
    foreach (string arg in args) Console.WriteLine(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(arg)));
    return 19;
  }
}
'@ -OutputAssembly ${quote(join(bin, "codex.exe"))} -OutputType ConsoleApplication
${powershellPermissionIntegration()}
codex 'prompt with spaces'
exit $LASTEXITCODE
`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin};${process.env.PATH}` }, windowsHide: true,
    });
    assert.equal(result.status, 19, result.stderr || result.stdout);
    const args = result.stdout.trim().split(/\r?\n/).map(line => Buffer.from(line, "base64").toString("utf8"));
    assert.deepEqual(args.slice(0, 3), ["--sandbox", "danger-full-access", "-c"]);
    assert.ok(['approval_policy="never"', "approval_policy=never"].includes(args[3]));
    assert.equal(args[4], "prompt with spaces");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Antigravity monitoring delegates permission decisions to the native mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-agy-permissions-"));
  try {
    ensureWorkspace(root);
    const result = await handleAntigravityHook({ cwd: root, conversationId: "permission-test", toolCall: { name: "run_command", args: { CommandLine: "git status" } } }, "PreToolUse");
    assert.deepEqual(result, { decision: "allow" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CMD setup preserves existing AutoRun and does not overwrite unrelated launchers", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-cmd-install-"));
  try {
    const path = installCmdLaunchers(root);
    const original = '@echo existing & call "C:\\other\\init.cmd"';
    const combined = cmdPermissionAutoRun(original, path);
    assert.ok(combined.startsWith(`${original} & `));
    assert.equal(cmdPermissionAutoRun(combined, path), combined);
    assert.equal(cmdPermissionAutoRun("", path), `call "${path}"`);
    const text = readFileSync(join(root, "codex.cmd"), "utf8");
    installCmdLaunchers(root);
    assert.equal(readFileSync(join(root, "codex.cmd"), "utf8"), text);
    writeFileSync(join(root, "agy.cmd"), "@echo user-owned");
    assert.throws(() => installCmdLaunchers(root), /unmanaged CMD launcher/);
    assert.equal(readFileSync(join(root, "agy.cmd"), "utf8"), "@echo user-owned");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CMD launchers apply live repo permissions and preserve quoted arguments, stdin and exit codes", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-cmd-"));
  try {
    const native = join(root, "native bin");
    const shims = join(root, "bridge & shims");
    const repo = join(root, "repo");
    mkdirSync(native);
    mkdirSync(repo);
    const policies = { codex: "never", codexSandbox: "danger-full-access", claude: "auto", antigravity: "default", antigravityMode: "auto" };
    save(repo, policies);
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const compiler = join(root, "compile.ps1");
    writeFileSync(compiler, `Add-Type -TypeDefinition @'
using System;
public class Capture {
  public static int Main(string[] args) {
    foreach (string arg in args) Console.WriteLine("ARG:" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(arg)));
    if (Console.IsInputRedirected) Console.WriteLine("STDIN:" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(Console.In.ReadToEnd())));
    return 29;
  }
}
'@ -OutputAssembly ${quote(join(native, "codex.exe"))} -OutputType ConsoleApplication
`);
    const compiled = spawnSync("powershell.exe", ["-NoProfile", "-File", compiler], { encoding: "utf8", windowsHide: true });
    assert.equal(compiled.status, 0, compiled.stderr);
    for (const command of ["claude", "agy"]) copyFileSync(join(native, "codex.exe"), join(native, `${command}.exe`));
    const init = installCmdLaunchers(shims);
    const run = (command, cwd = repo, input, expectedStatus = 29) => {
      const file = join(root, "run.cmd");
      writeFileSync(file, `@echo off\r\ncall "${init}"\r\n${command}\r\n`);
      const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${file}"`], {
        cwd, encoding: "utf8", input, env: { ...process.env, PATH: `${native};${process.env.PATH}`, AGENT_BRIDGE_CMD_BIN: "" }, windowsHide: true, windowsVerbatimArguments: true,
      });
      assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
      const lines = result.stdout.trim().split(/\r?\n/);
      return {
        args: lines.filter(line => line.startsWith("ARG:")).map(line => Buffer.from(line.slice(4), "base64").toString("utf8")),
        data: lines.filter(line => line.startsWith("STDIN:")).map(line => Buffer.from(line.slice(6), "base64").toString("utf8")).join(""),
      };
    };
    const codex = run('codex "prompt with spaces & symbols | < > ^ ( )"');
    assert.deepEqual(codex.args.slice(0, 3), ["--sandbox", "danger-full-access", "-c"]);
    assert.equal(codex.args[3], 'approval_policy="never"');
    assert.equal(codex.args[4], "prompt with spaces & symbols | < > ^ ( )");
    assert.deepEqual(run("claude hello").args, ["--permission-mode", "auto", "hello"]);
    assert.deepEqual(run("agy hello").args, ["--mode", "auto", "hello"]);
    assert.deepEqual(run("claude hello", root).args, ["hello"]);
    assert.deepEqual(run("claude --permission-mode plan").args, ["--permission-mode", "plan"]);
    assert.equal(run("codex exec -", repo, "piped text\r\n").data, "piped text\r\n");
    save(repo, { ...policies, claude: "plan" });
    assert.deepEqual(run("claude hello").args, ["--permission-mode", "plan", "hello"]);
    save(repo, policies, false);
    assert.deepEqual(run("agy hello").args, ["hello"]);
    writeFileSync(join(repo, ".agent-memory/config.json"), "{");
    assert.deepEqual(run("claude hello", repo, undefined, 1).args, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
