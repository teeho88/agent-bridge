import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { TaskStore, ProjectBroker, SessionHost, WindowsSandbox } from '../../next/runtime/src/index.mjs';
import { CodexAdapter } from '../../next/adapter-codex/src/index.mjs';
import { assessProviderQuota } from './remediation-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, 'next/.local/phase0-provider', randomUUID());
const output = resolve(process.argv[2] ?? join(root, 'docs/phase0-20261016/provider-preflight.json'));
if (existsSync(output)) throw new Error('Provider evidence already exists');
const executable = join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe');
const authPath = join(process.env.USERPROFILE, '.codex/auth.json');
const project = join(directory, 'authoritative');
mkdirSync(join(project, 'src'), { recursive: true });
writeFileSync(join(project, 'src/probe.txt'), 'Phase 0 provider capability probe; no inference');
const store = new TaskStore(join(directory, 'host'));
const broker = new ProjectBroker(store, { project, allowlist: ['src'] });
store.createTask({ id: 'probe', objective: 'Verify provider without inference', constraints: [], sourceRevision: broker.currentRevision() });
const work = broker.prepare('probe', 'probe-A'), other = broker.prepare('probe', 'probe-B');
const host = new SessionHost(store, broker);
const sandbox = new WindowsSandbox({ control: join(directory, 'supervisor'), profileName: 'BridgeV2.Phase0.' + randomUUID() });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binaryDirectory = join(directory, 'provider');
mkdirSync(binaryDirectory);
const binary = join(binaryDirectory, 'codex.exe');
copyFileSync(executable, binary);
const evidence = join(directory, 'protected-evidence.txt'), evaluator = join(directory, 'protected-evaluator.txt');
writeFileSync(evidence, 'protected evidence');
writeFileSync(evaluator, 'protected evaluator');
const protectedFiles = [{ kind: 'authoritative', path: join(project, 'src/probe.txt') },
  { kind: 'state', path: join(store.directory, 'state.sqlite') }, { kind: 'evidence', path: evidence },
  { kind: 'evaluator', path: evaluator }, { kind: 'other-workspace', path: join(other.workspace, 'src/probe.txt') },
  { kind: 'auth', path: authPath }];
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), model: 'gpt-6-luna', effort: 'medium',
  providerInvocations: 0, inferenceStarted: false, node: process.version, nodeHash: hash(readFileSync(process.execPath)),
  executable, providerHash: hash(readFileSync(binary)), directory, passed: false };
let adapter;
try {
  const sid = sandbox.invoke({ operation: 'sid', name: sandbox.profileName });
  if (!sid.receipt?.sid) throw new Error('Provider profile SID unavailable');
  const helper = join(binaryDirectory, 'codex-code-mode-host.exe');
  copyFileSync(join(dirname(executable), 'codex-code-mode-host.exe'), helper);
  report.codeModeHostHash = hash(readFileSync(helper));
  const grant = spawnSync('icacls.exe', [helper, '/grant', '*' + sid.receipt.sid + ':RX'], { encoding: 'utf8', windowsHide: true });
  if (grant.status !== 0) throw new Error('Provider dependency RX grant failed');
  adapter = await CodexAdapter.launch({ host, sandbox, protectedFiles, sessionId: 'probe-A', workspaceId: 'probe-A',
    executable: binary, model: report.model, effort: report.effort, internetClient: true, bridgeEnabled: false,
    maxSessionMs: 120000, tokenProvider: async () => {
      const auth = JSON.parse(readFileSync(authPath, 'utf8'));
      if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('Existing ChatGPT authentication unavailable');
      return { accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id };
    } });
  report.boundaryVerified = adapter.boundaryProof.writerEnabled;
  report.thread = { id: adapter.threadId, model: adapter.threadReceipt.model,
    reasoningEffort: adapter.threadReceipt.reasoningEffort ?? null };
  const models = await adapter.rpc.request('model/list', { includeHidden: false, limit: 100 });
  const match = models.data?.find(model => model.id === report.model || model.model === report.model);
  report.modelAvailable = Boolean(match);
  report.supportedReasoningEfforts = match?.supportedReasoningEfforts ?? null;
  const limits = await adapter.rpc.request('account/rateLimits/read');
  report.rateLimits = limits.rateLimits ?? null;
  report.quotaAdmission = assessProviderQuota(report.rateLimits);
  report.ordinaryQuotaAvailable = report.quotaAdmission.ordinaryQuotaAvailable;
  report.noPaidFallback = report.quotaAdmission.noPaidFallback;
  report.stop = await adapter.close({ publish: false });
  report.passed = report.boundaryVerified && report.modelAvailable && report.thread.model === report.model &&
    report.supportedReasoningEfforts?.some(value => value.reasoningEffort === report.effort) === true &&
    report.quotaAdmission.passed && report.stop.phase === 'closed';
} catch (error) {
  report.error = { name: error.name, code: error.code ?? null, message: error.message };
  if (adapter) {
    try { report.stop = await adapter.close({ publish: false, crashed: true }); }
    catch { report.stopUnverified = true; }
  }
} finally {
  store.close();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, report: output, modelAvailable: report.modelAvailable ?? null,
    ordinaryQuotaAvailable: report.ordinaryQuotaAvailable ?? null, error: report.error ?? null }));
}
process.exitCode = report.passed ? 0 : 2;
