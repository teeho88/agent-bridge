import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { WindowsSandbox } from '../../next/runtime/src/index.mjs';
import { powershellWorkspaceCommand } from './powershell-cwd.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pointer = JSON.parse(readFileSync(resolve(process.argv[2] ?? join(root, 'docs/phase8-2-20261018/round.json')), 'utf8'));
const output = resolve(process.argv[3] ?? join(root, 'docs/phase8-2-20261018/shell-preflight.json'));
if (existsSync(output)) throw new Error('Shell evidence already exists; choose a new output path');
const directory = join(pointer.directory, 'shell-probe-' + randomUUID());
const workspace = join(directory, 'project');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'sentinel.txt'), 'workspace sentinel');
const protectedFiles = ['authoritative', 'state', 'evidence', 'evaluator', 'other-workspace'].map(kind => {
  const path = join(directory, kind + '.txt');
  writeFileSync(path, 'protected sentinel');
  return { kind, path };
});
const sandbox = new WindowsSandbox({ control: join(directory, 'supervisor'), profileName: 'BridgeV2.ShellProbe.' + randomUUID() });
const boundary = sandbox.verify({ workspace, protectedFiles, internetClient: false });
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), protocolHash: pointer.protocolHash,
  providerInvocations: 0, workspace, boundary, passed: false, node: null, powershell: null,
  compatibility: 'powershell-workspace-psdrive-v1',
  bootstrapHash: createHash('sha256').update(readFileSync(new URL('./powershell-cwd.mjs', import.meta.url))).digest('hex') };
if (boundary.writerEnabled) {
  report.node = sandbox.run({ workspace, executable: process.execPath,
    arguments: ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),sentinel:require("node:fs").readFileSync("sentinel.txt","utf8")}))'], timeoutMs: 15000 });
  report.powershell = sandbox.run({ workspace, executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    arguments: ['-NoProfile', '-NonInteractive', '-Command', powershellWorkspaceCommand('$ErrorActionPreference="Stop"; Set-Content -LiteralPath "shell-write.txt" -Value "shell write"; [ordered]@{cwd=(Get-Location).ProviderPath;processCwd=[Environment]::CurrentDirectory;sentinel=(Test-Path -LiteralPath "sentinel.txt");written=(Get-Content -LiteralPath "shell-write.txt")} | ConvertTo-Json -Compress')], timeoutMs: 15000 });
  try {
    const node = JSON.parse(report.node.stdout.trim()), shell = JSON.parse(report.powershell.stdout.trim());
    report.passed = report.node.exitStatus === 0 && report.powershell.exitStatus === 0 && node.cwd === workspace && shell.cwd.replace(/[\\/]+$/, '') === workspace.replace(/[\\/]+$/, '') && shell.sentinel === true && shell.written === 'shell write';
  } catch (error) { report.error = error.message; }
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, passed: report.passed, node: report.node?.stdout, powershell: report.powershell?.stdout }));
process.exitCode = report.passed ? 0 : 2;
