import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { WindowsSandbox } from '../../next/runtime/src/index.mjs';
import { CodexRpc } from '../../next/adapter-codex/src/rpc.mjs';
import { codexManagedSection } from '../../packages/adapters/dist/codex.js';

const base = dirname(fileURLToPath(import.meta.url)), root = resolve(base, '../..');
const pointer = join(root, 'docs/phase0-20261016/round.json');
const phase = process.argv[2];
if (!['prepare', 'smoke', 'formal', 'report'].includes(phase)) throw new Error('Usage: run.mjs prepare|smoke|formal|report');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
function inventory(directory, exclude = []) {
  const result = {};
  function walk(path) {
    for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
      const name = path ? path + '/' + entry.name : entry.name;
      if (exclude.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) result[name] = hash(readFileSync(join(directory, name)));
      else throw new Error('Unexpected link in snapshot: ' + name);
    }
  }
  walk(''); return result;
}
function verify(directory, expected) {
  const actual = inventory(directory);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Frozen inventory differs: ' + directory);
}
function command(args, cwd, prefix) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (prefix) { writeFileSync(prefix + '.stdout.log', result.stdout ?? ''); writeFileSync(prefix + '.stderr.log', result.stderr ?? ''); }
  return { exitStatus: result.status, error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function acl(file, sid, owner) {
  const result = spawnSync('icacls.exe', [file, '/inheritance:r', '/grant:r', '*' + owner + ':F', '*' + sid + ':RX'], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Read-only input ACL failed');
}
function nativeReceipt(evidence, runId) {
  const prefix = join(evidence, 'supervisor', runId), request = json(prefix + '.json');
  if (request.receipt !== prefix + '.receipt' || request.stdout !== prefix + '.stdout') throw new Error('Native receipt path binding mismatch');
  if (!existsSync(prefix + '.receipt')) return null;
  const receipt = json(prefix + '.receipt');
  if (receipt.appContainer !== true || receipt.writersStopped !== true || receipt.activeProcesses !== 0) return null;
  return { ...receipt, runId, stdoutPath: prefix + '.stdout', stderrPath: prefix + '.stderr' };
}
const cli = '.bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js';
const slotSchedule = repetition => [['small', 1], ['debug', 1], ['multi', 1], ['handoff', 1], ['handoff', 2]]
  .map(([taskId, stage]) => ({ id: 'B-' + repetition + '-' + taskId + '-' + stage, branch: 'B', repetition, taskId, stage }));
if (phase === 'prepare') {
  if (existsSync(pointer)) {
    if (process.argv[3] !== '--new-round') throw new Error('Round pointer exists; explicit --new-round required');
    const prior = json(pointer), priorState = json(join(prior.directory, 'state.json'));
    if (priorState.status !== 'infrastructure_failed' || priorState.slots.some(slot => slot.launch &&
      (slot.nativeStop?.writersStopped !== true || slot.nativeStop.activeProcesses !== 0) && !nativeReceipt(slot.evidence, slot.launch.runId))) throw new Error('Prior model writers unresolved');
    const history = join(root, 'docs/phase0-20261016/round-history', prior.protocolHash + '.json');
    mkdirSync(dirname(history), { recursive: true });
    writeFileSync(history, readFileSync(pointer), { flag: 'wx' });
  }
  const preflight = json(join(root, 'docs/phase0-20261016/provider-preflight-luna-v5.json'));
  if (!preflight.passed || preflight.model !== 'gpt-6-luna' || preflight.effort !== 'medium') throw new Error('Codex Luna 6 preflight required');
  const directory = join(root, 'next/.local/phase0-baselines', randomUUID()), frozen = join(directory, 'protocol');
  mkdirSync(frozen, { recursive: true });
  for (const name of ['fixtures', 'controls']) cpSync(join(base, name), join(frozen, name), { recursive: true });
  for (const name of ['PROTOCOL.md', 'verify.mjs', 'run.mjs', 'provider-preflight.mjs', 'native-stdio.cjs']) copyFileSync(join(base, name), join(frozen, name));
  const production = join(frozen, 'bridge-runtime/node_modules'), visited = new Set();
  function pack(source) {
    source = realpathSync(source);
    const pkg = json(join(source, 'package.json'));
    if (visited.has(pkg.name)) return;
    visited.add(pkg.name);
    const destination = join(production, pkg.name);
    cpSync(source, destination, { recursive: true, dereference: true, filter: path => {
      const parts = relative(source, path).split(/[\\/]/);
      return !parts.includes('node_modules') && (!pkg.name.startsWith('@agent-bridge/') || !parts[0] || ['dist', 'package.json'].includes(parts[0]));
    } });
    const require = createRequire(join(source, 'package.json'));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      let entry;
      try { entry = require.resolve(dependency + '/package.json'); } catch { entry = require.resolve(dependency); }
      let location = dirname(entry);
      while (!existsSync(join(location, 'package.json')) || json(join(location, 'package.json')).name !== dependency) {
        const parent = dirname(location); if (parent === location) throw new Error('Missing package ' + dependency); location = parent;
      }
      pack(location);
    }
  }
  pack(join(root, 'packages/cli'));
  copyFileSync(join(base, 'native-stdio.cjs'), join(frozen, 'bridge-runtime/native-stdio.cjs'));
  const provider = join(frozen, 'provider'); mkdirSync(provider);
  for (const name of ['codex.exe', 'codex-code-mode-host.exe']) copyFileSync(join(dirname(preflight.executable), name), join(provider, name));
  writeFileSync(join(frozen, 'AGENTS.md'), codexManagedSection({ hooked: false }).replaceAll('agent-bridge ', 'node ' + cli + ' '));
  copyFileSync(join(root, 'pnpm-lock.yaml'), join(frozen, 'pnpm-lock.yaml'));
  const harnessSources = {};
  for (const folder of ['next/runtime/src', 'next/adapter-codex/src'])
    for (const [path, digest] of Object.entries(inventory(join(root, folder)))) harnessSources[folder + '/' + path] = digest;
  const manifest = { schemaVersion: 2, id: randomUUID(), createdAt: new Date().toISOString(), directory,
    archiveManifestHash: json(join(root, 'docs/phase0-20261016/recovery.json')).manifestId,
    codeProvenance: 'restored legacy 0.1.1; exact archive blobs and matching surviving files',
    model: 'gpt-6-luna', effort: 'medium', node: process.version, nodeHash: hash(readFileSync(process.execPath)),
    providerHash: preflight.providerHash, codeModeHostHash: preflight.codeModeHostHash,
    network: 'appcontainer-internet-client', runtimeMode: 'full', lifecycle: 'manual, hooks disabled',
    frozen: inventory(frozen), harnessSources,
    smoke: [slotSchedule(0)[0], ...slotSchedule(0).filter(slot => slot.taskId === 'handoff')],
    schedule: [1, 2, 3, 4, 5].flatMap(slotSchedule), maxAttempts: 2, maxAttemptMs: 600000,
    maxTokens: 1000000, maxUncachedOutputTokens: 100000, nativeCompatibility: 'file-backed synchronous stdio; test isolation none inside AppContainer' };
  manifest.protocolHash = hash(JSON.stringify(manifest));
  save(join(directory, 'protocol.json'), manifest);
  save(pointer, { directory, protocolHash: manifest.protocolHash, protocol: join(directory, 'protocol.json') });
  console.log(JSON.stringify({ phase, directory, protocolHash: manifest.protocolHash, productionPackages: visited.size }));
  process.exit(0);
}
const location = json(pointer), directory = location.directory, frozen = join(directory, 'protocol'), manifest = json(location.protocol);
const { protocolHash, ...body } = manifest;
if (hash(JSON.stringify(body)) !== protocolHash || protocolHash !== location.protocolHash) throw new Error('Protocol fingerprint mismatch');
verify(frozen, manifest.frozen);
for (const [path, expected] of Object.entries(manifest.harnessSources)) if (hash(readFileSync(join(root, path))) !== expected) throw new Error('Native harness source drift');
if (hash(readFileSync(fileURLToPath(import.meta.url))) !== manifest.frozen['run.mjs']) throw new Error('Runner changed after freeze');
const statePath = join(directory, 'state.json');
const state = existsSync(statePath) ? json(statePath) : { schemaVersion: 1, protocolHash, status: 'prepared', slots: [], failures: [] };
if (state.protocolHash !== protocolHash) throw new Error('State protocol mismatch');
function summarize() {
  const rows = state.slots.filter(row => row.phase === 'formal');
  const sum = field => rows.length && rows.every(row => Number.isFinite(row.usage?.[field])) ? rows.reduce((total, row) => total + row.usage[field], 0) : null;
  const report = { schemaVersion: 1, protocolHash, directory, status: state.status, formalCompleted: rows.filter(row => row.status === 'finished').length,
    expectedFormalInvocations: 25, smokeCompleted: state.slots.filter(row => row.phase === 'smoke' && row.status === 'finished').length,
    providerInvocations: state.slots.filter(row => row.launch).length, acceptancePassed: rows.filter(row => row.acceptance?.passed).length,
    usage: Object.fromEntries(['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'uncachedInputTokens'].map(field => [field, sum(field)])),
    cost: null, baselineComplete: false, reviewStatus: 'pending-host-content-review', failures: state.failures };
  save(join(directory, 'report.json'), report); return report;
}
if (phase === 'report') { console.log(JSON.stringify(summarize())); process.exit(0); }
if (state.slots.some(slot => !['finished', 'preflight_failed'].includes(slot.status))) throw new Error('Unresolved invocation; no replay');
if (state.status === 'infrastructure_failed') throw new Error('Round stopped by infrastructure failure; no replay');
if (phase === 'formal') {
  const smoke = json(join(directory, 'smoke-review.json'));
  if (smoke.protocolHash !== protocolHash || smoke.verdict !== 'pass' || !manifest.smoke.every(slot => state.slots.some(row => row.id === slot.id && row.acceptance?.passed))) throw new Error('Successful reviewed smoke required');
}
const authPath = join(process.env.USERPROFILE, '.codex/auth.json');
async function invocation(slot) {
  const record = { ...slot, phase, attempt: 1, attemptId: randomUUID(), startedAt: new Date().toISOString(), status: 'reserved', usage: null, launch: null };
  state.slots.push(record); save(statePath, state);
  const start = performance.now(), branch = join(directory, 'runs', phase + '-' + slot.repetition + '-' + slot.taskId), workspace = join(branch, 'project');
  const evidence = join(branch, 'evidence', slot.id); mkdirSync(evidence, { recursive: true });
  record.evidence = evidence; record.workspace = workspace;
  if (slot.stage === 1) {
    if (existsSync(workspace)) throw new Error('Refuse to reseed existing workspace');
    mkdirSync(workspace, { recursive: true });
    cpSync(join(frozen, 'fixtures', slot.taskId), workspace, { recursive: true, filter: path => !/REQUEST-2\.md$|acceptance-2\.test\.mjs$/.test(path) });
    cpSync(join(frozen, 'bridge-runtime'), join(workspace, '.bridge-runtime'), { recursive: true });
    const setup = command([cli, 'init', '--no-claude-hooks', '--no-antigravity-hooks'], workspace, join(evidence, 'init'));
    if (setup.exitStatus !== 0) throw new Error('Legacy workspace init failed; see init logs');
    copyFileSync(join(frozen, 'AGENTS.md'), join(workspace, 'AGENTS.md'));
  } else {
    if (!existsSync(workspace)) throw new Error('Missing actual predecessor workspace');
    copyFileSync(join(frozen, 'fixtures/handoff/acceptance-2.test.mjs'), join(workspace, 'acceptance-2.test.mjs'));
    copyFileSync(join(frozen, 'fixtures/handoff/REQUEST-2.md'), join(workspace, 'REQUEST-2.md'));
  }
  const testFile = slot.taskId === 'handoff' ? 'acceptance-' + slot.stage + '.test.mjs' : 'acceptance.test.mjs';
  const requestFile = slot.taskId === 'handoff' ? 'REQUEST-' + slot.stage + '.md' : 'REQUEST.md';
  const product = () => ({ ...Object.fromEntries(Object.entries(inventory(join(workspace, 'src'))).map(([path, digest]) => ['src/' + path, digest])),
    ...(existsSync(join(workspace, 'RESULT.md')) ? { 'RESULT.md': hash(readFileSync(join(workspace, 'RESULT.md'))) } : {}) });
  const before = product(); save(join(evidence, 'source-before.json'), before);
  record.sourceRevision = hash(JSON.stringify(before));
  cpSync(join(workspace, 'src'), join(evidence, 'source-before'), { recursive: true });
  const readonly = Object.keys(inventory(workspace, ['src', '.git', '.bridge-runtime', '.agent-memory', '.handoff', '.bridge-home', '.bridge-tmp']))
    .filter(path => path !== 'RESULT.md');
  const protectedHashes = Object.fromEntries(readonly.map(path => [path, hash(readFileSync(join(workspace, path)))]));
  const runtimeHashes = inventory(join(workspace, '.bridge-runtime'));
  mkdirSync(join(workspace, '.bridge-home/codex'), { recursive: true });
  const preload = join(workspace, '.bridge-runtime/native-stdio.cjs').replaceAll('\\', '/');
  writeFileSync(join(workspace, '.bridge-home/codex/config.toml'), '[shell_environment_policy]\ninherit = "all"\n[shell_environment_policy.set]\nNODE_OPTIONS = ' +
    JSON.stringify('--preserve-symlinks --preserve-symlinks-main --require="' + preload + '"') + '\n');
  const sandbox = new WindowsSandbox({ control: join(evidence, 'supervisor'), profileName: 'BridgeV2.Baseline.' + randomUUID() });
  const owner = sandbox.invoke({ operation: 'workspace-owner', workspace });
  const sid = sandbox.invoke({ operation: 'sid', name: sandbox.profileName });
  if (!owner.receipt?.userSid || !sid.receipt?.sid) throw new Error('Sandbox identity unavailable');
  for (const path of readonly) acl(join(workspace, path), sid.receipt.sid, owner.receipt.userSid);
  const other = join(evidence, 'other-workspace.txt'); writeFileSync(other, 'other workspace sentinel');
  const providerDirectory = join(evidence, 'provider'); mkdirSync(providerDirectory);
  for (const name of ['codex.exe', 'codex-code-mode-host.exe']) copyFileSync(join(frozen, 'provider', name), join(providerDirectory, name));
  const helperGrant = spawnSync('icacls.exe', [join(providerDirectory, 'codex-code-mode-host.exe'), '/grant', '*' + sid.receipt.sid + ':RX'], { windowsHide: true, encoding: 'utf8' });
  if (helperGrant.status !== 0) throw new Error('Code Mode helper grant failed');
  const guard = [{ kind: 'authoritative', path: join(frozen, 'fixtures', slot.taskId, 'src', readdirSync(join(frozen, 'fixtures', slot.taskId, 'src'))[0]) },
    { kind: 'state', path: statePath }, { kind: 'evidence', path: join(directory, 'protocol.json') },
    { kind: 'evaluator', path: join(frozen, 'controls/small/src/clamp.mjs') }, { kind: 'other-workspace', path: other }, { kind: 'auth', path: authPath }];
  const proof = sandbox.verify({ workspace, protectedFiles: guard, internetClient: true }); save(join(evidence, 'boundary.json'), proof);
  if (!proof.writerEnabled) throw new Error('Native write boundary failed');
  let transport, rpc, turnId, completion, usage = null, failure = null, tokenLimit = false;
  const calls = new Map(), events = [];
  try {
    transport = sandbox.start({ workspace, executable: join(providerDirectory, 'codex.exe'), readOnlyExecutable: true, maxSessionMs: 660000,
      arguments: ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'web_search="disabled"',
        '-c', 'model_auto_compact_token_limit=1000000000', '-c', 'project_doc_max_bytes=0', '--disable', 'hooks', '--disable', 'apps',
        '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'multi_agent_v2_dynamic_tools', '--disable', 'memories',
        '--disable', 'external_agent_memory_import', '--disable', 'skill_search', '--disable', 'in_app_browser', '--disable', 'in_app_chat',
        '--disable', 'standalone_web_search', '--disable', 'browser_use', '--disable', 'computer_use'] });
    rpc = new CodexRpc(transport);
    let resolveCompleted;
    const completed = new Promise(resolve => { resolveCompleted = resolve; });
    rpc.on('request', async message => {
      if (message.method === 'account/chatgptAuthTokens/refresh') {
        const auth = json(authPath);
        rpc.send({ id: message.id, result: { accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id } });
      } else rpc.send({ id: message.id, error: { code: -32600, message: 'No interactive approvals or extra tools in baseline protocol' } });
    });
    rpc.on('failure', error => { failure = error.message; resolveCompleted({ status: 'infrastructure_failed' }); });
    rpc.on('closed', () => { if (!completion) resolveCompleted({ status: 'transport_closed' }); });
    rpc.on('notification', message => {
      appendFileSync(join(evidence, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), message }) + '\n');
      events.push(message);
      const params = message.params ?? {}, item = params.item;
      if (message.method === 'item/completed' && item?.id && /commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgent/.test(item.type ?? '')) calls.set(item.id, item);
      if (message.method === 'thread/tokenUsage/updated') {
        usage = params.tokenUsage?.total ?? null;
        if (usage && (usage.inputTokens + usage.outputTokens > manifest.maxTokens ||
          usage.inputTokens - usage.cachedInputTokens + usage.outputTokens > manifest.maxUncachedOutputTokens) && !tokenLimit) {
          tokenLimit = true;
          rpc.request('turn/interrupt', { threadId: record.launch.threadId, turnId }).catch(error => {
            failure = 'Budget interrupt failed: ' + error.message; resolveCompleted({ status: 'infrastructure_failed' });
          });
        }
      }
      if (message.method === 'turn/completed') { completion = params.turn; resolveCompleted(completion); }
    });
    await rpc.request('initialize', { clientInfo: { name: 'phase0_baseline', title: 'Phase 0 baseline', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const auth = json(authPath);
    if (auth.auth_mode !== 'chatgpt') throw new Error('ChatGPT auth required; no API fallback');
    await rpc.request('account/login/start', { type: 'chatgptAuthTokens', accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id });
    const limits = await rpc.request('account/rateLimits/read'), rates = limits.rateLimits;
    save(join(evidence, 'quota.json'), rates);
    const windows = [rates?.primary, rates?.secondary].filter(Boolean), credits = rates?.credits;
    if (!windows.length || windows.some(window => window.usedPercent >= 100) || !credits || credits.unlimited !== false || !(credits.hasCredits === false || Number(credits.balance) === 0)) throw new Error('Ordinary quota/no-paid-fallback gate failed');
    const thread = await rpc.request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access', model: manifest.model,
      config: { model_reasoning_effort: manifest.effort }, dynamicTools: [], ephemeral: false });
    if (thread.model !== manifest.model) throw new Error('Actual thread model differs');
    save(join(evidence, 'thread.json'), thread);
    const lifecycle = slot.stage === 1
      ? 'First create exactly one Bridge task using task start "Short title" --goal "Current goal" --agent codex; task start already opens one session, so do not also session start.'
      : 'First session start --agent codex on the existing task; do not create a new task. Read the actual predecessor Bridge handoff and verify the source revision before editing.';
    const request = `Follow the read-only AGENTS.md below and the current request. This is an isolated measurement task; no network calls, package installs, subagents, extra model/provider calls, git commits, or future requirements. Use Node for file IO when rg is unavailable. Bridge executable: node ${cli}. Hooks are disabled; manual lifecycle only. ${lifecycle} Run context startup --agent codex after startup. Native test compatibility: add --experimental-test-isolation=none to every node --test command (same frozen tests/acceptance, same OS sandbox). Do not end the Bridge session yourself; the host ends it only after native writer stop. Product scope: src/** and RESULT.md. Read-only inputs: acceptance tests, checks.mjs, requests, package.json, AGENTS.md, .bridge-runtime. Bridge metadata and a structured handoff payload may be written only under .agent-memory/ or .handoff/. Keep handoff evidence as complete actual command/result text, including failures. Record decisions with reasons and constraints. No runtime goal tool is requested.\n${readFileSync(join(workspace, 'AGENTS.md'), 'utf8')}\nCURRENT REQUEST:\n${readFileSync(join(workspace, requestFile), 'utf8')}`;
    writeFileSync(join(evidence, 'request.txt'), request);
    record.launch = { runId: transport.runId, threadId: thread.thread.id, model: thread.model, effort: manifest.effort, requestHash: hash(request), observedAt: new Date().toISOString() };
    record.status = 'launched'; save(statePath, state);
    const response = await rpc.request('turn/start', { threadId: thread.thread.id, model: manifest.model, effort: manifest.effort,
      input: [{ type: 'text', text: request }], approvalPolicy: 'never', sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' } });
    turnId = response.turn?.id; record.launch.turnId = turnId; save(statePath, state);
    let timer;
    try { completion = await Promise.race([completed, new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), manifest.maxAttemptMs); })]); }
    finally { clearTimeout(timer); }
    record.turn = completion;
  } catch (error) { failure = error.message; }
  finally {
    if (rpc) record.nativeStop = await rpc.close();
    else if (transport) record.nativeStop = await transport.stop();
    if (transport && record.nativeStop?.writersStopped !== true) {
      const graceDeadline = Date.now() + 15000;
      while (Date.now() < graceDeadline && record.nativeStop?.writersStopped !== true) {
        const late = nativeReceipt(evidence, transport.runId);
        if (late) { record.nativeStop = { ...late, recoveredLateReceipt: true }; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    record.implementationMs = performance.now() - start;
    if (transport) {
      record.rawProtocol = record.nativeStop.stdoutPath ?? null;
      if (record.rawProtocol && existsSync(record.rawProtocol)) record.rawProtocolHash = hash(readFileSync(record.rawProtocol));
    }
  }
  record.toolCalls = calls.size;
  record.toolCallItems = [...calls.keys()];
  save(join(evidence, 'tool-calls.json'), [...calls.values()]);
  record.usage = usage ? { inputTokens: usage.inputTokens ?? null, cachedInputTokens: usage.cachedInputTokens ?? null,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null, outputTokens: usage.outputTokens ?? null,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? null,
    uncachedInputTokens: Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.cachedInputTokens) && usage.inputTokens >= usage.cachedInputTokens ? usage.inputTokens - usage.cachedInputTokens : null } : null;
  if (!record.nativeStop?.writersStopped || record.nativeStop.activeProcesses !== 0 || record.nativeStop.appContainer !== true) throw new Error('Native writer stop unverified');
  if (failure || !record.launch || !usage || !Number.isSafeInteger(record.usage.inputTokens) || !Number.isSafeInteger(record.usage.cachedInputTokens) || !Number.isSafeInteger(record.usage.outputTokens)) throw new Error(failure ?? 'Missing mandatory provider usage');
  if (events.some(event => /compacted/.test(event.method ?? '') || event.params?.item?.type === 'contextCompaction')) throw new Error('Unexpected compaction changes controlled input');
  for (const [path, expected] of Object.entries(protectedHashes)) if (hash(readFileSync(join(workspace, path))) !== expected) throw new Error('Read-only input changed');
  verify(join(workspace, '.bridge-runtime'), runtimeHashes);
  const runtimeDatabase = new DatabaseSync(join(workspace, '.agent-memory/runtime.db'), { readOnly: true });
  const runtimeConfig = JSON.parse(runtimeDatabase.prepare('SELECT payload FROM workspace_runtime WHERE id=1').get().payload);
  runtimeDatabase.close();
  const config = { ...json(join(workspace, '.agent-memory/config.json')), ...runtimeConfig };
  const taskId = config.currentTasks?.codex ?? config.currentTaskId, sessionId = config.currentSessions?.codex;
  if (!taskId || !sessionId) throw new Error('Missing Bridge task/session identity');
  record.binding = { taskId, sessionId };
  const predecessor = state.slots.find(row => row.repetition === slot.repetition && row.taskId === slot.taskId && row.stage === 1 && row.phase === phase);
  if (slot.stage === 2 && (predecessor?.binding?.taskId !== taskId || predecessor.binding.sessionId === sessionId)) throw new Error('Handoff task/session continuity failed');
  const close = command([cli, 'session', 'end', '--agent', 'codex', '--id', sessionId], workspace, join(evidence, 'session-close'));
  if (close.exitStatus !== 0) throw new Error('Bridge close failed after stop');
  const after = product(); save(join(evidence, 'source-after.json'), after);
  cpSync(join(workspace, 'src'), join(evidence, 'source-after'), { recursive: true });
  if (existsSync(join(workspace, 'RESULT.md'))) copyFileSync(join(workspace, 'RESULT.md'), join(evidence, 'RESULT.md'));
  if (existsSync(join(workspace, '.handoff'))) cpSync(join(workspace, '.handoff'), join(evidence, 'handoff'), { recursive: true });
  cpSync(join(workspace, '.agent-memory'), join(evidence, 'agent-memory'), { recursive: true });
  const evaluatorProof = sandbox.verify({ workspace, protectedFiles: guard, internetClient: false });
  save(join(evidence, 'evaluator-boundary.json'), evaluatorProof);
  if (!evaluatorProof.writerEnabled) throw new Error('Evaluator boundary failed');
  const acceptance = sandbox.run({ workspace, executable: process.execPath,
    arguments: ['--test', '--experimental-test-isolation=none', '--test-reporter=tap', testFile], timeoutMs: 30000 });
  writeFileSync(join(evidence, 'acceptance.stdout.log'), acceptance.stdout);
  writeFileSync(join(evidence, 'acceptance.stderr.log'), acceptance.stderr);
  for (const [path, expected] of Object.entries(protectedHashes)) if (hash(readFileSync(join(workspace, path))) !== expected) throw new Error('Evaluator read-only input changed');
  const cases = Number(acceptance.stdout.match(/^# tests (\d+)$/m)?.[1] ?? 0);
  const failures = Number(acceptance.stdout.match(/^# fail (\d+)$/m)?.[1] ?? 0);
  record.acceptance = { passed: acceptance.exitStatus === 0 && cases === 2 && failures === 0, cases, failures,
    exitStatus: acceptance.exitStatus, nativeStop: { writersStopped: acceptance.writersStopped, activeProcesses: acceptance.activeProcesses, appContainer: acceptance.appContainer } };
  record.unexpectedFiles = Object.keys(inventory(workspace, ['src', '.git', '.bridge-runtime', '.agent-memory', '.handoff', '.bridge-home', '.bridge-tmp']))
    .filter(path => path !== 'RESULT.md' && !(path in protectedHashes));
  record.status = 'finished'; record.finishedAt = new Date().toISOString(); record.elapsedMs = performance.now() - start;
  record.failureClass = record.acceptance.passed && completion?.status === 'completed' && !tokenLimit && record.unexpectedFiles.length === 0 ? null : 'product';
  record.retryCount = 0; record.reworkCount = 0; record.review = 'pending-host-content-review';
  save(join(evidence, 'result.json'), record); save(statePath, state);
  console.log(JSON.stringify({ slot: slot.id, acceptance: record.acceptance.passed, usage: record.usage, elapsedMs: Math.round(record.elapsedMs) }));
}
state.status = 'running-' + phase; save(statePath, state);
for (const slot of phase === 'smoke' ? manifest.smoke : manifest.schedule) {
  if (state.slots.some(row => row.id === slot.id && row.status === 'finished')) continue;
  try { await invocation(slot); }
  catch (error) {
    const row = state.slots.find(row => row.id === slot.id);
    if (row && !row.launch) row.status = 'preflight_failed';
    state.status = 'infrastructure_failed'; state.failures.push({ slotId: slot.id, at: new Date().toISOString(), message: error.message, stack: error.stack });
    save(statePath, state); summarize(); throw error;
  }
  summarize();
}
state.status = phase + '-completed'; save(statePath, state); console.log(JSON.stringify(summarize()));
