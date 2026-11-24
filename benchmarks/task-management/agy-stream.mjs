import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateModel, containedPath } from './remediation-policy.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function agyCapability(models, help, binaryHash) {
  const match = models.split(/\r?\n/).find(line => /^gemini-3\.8-flash-high\s+Gemini 3\.8 Flash \(High\)\s*$/.test(line));
  return { provider: 'agy', name: 'Gemini 3.8 Flash High', resolvedId: match ? 'gemini-3.8-flash-high' : null,
    effort: 'high', available: Boolean(match && /--effort\s+[^\n]*\bhigh\b/.test(help)), binaryHash,
    timeoutSupported: /--print-timeout/.test(help),
    evidenceHash: digest(models + '\0' + help), effortEvidence: 'listed-high-model-id-and-cli-effort-capability' };
}

export function agyArguments({ workspace, prompt, capability, boundary, model = 'gemini-3.8-flash-high', effort = 'high' }) {
  validateModel({ provider: 'agy', model, effort }, capability);
  if (capability.timeoutSupported !== true) throw new Error('Verified agy print-timeout capability required');
  const cwd = containedPath(workspace);
  if (boundary?.writerEnabled !== true || resolve(boundary.workspace) !== cwd) throw new Error('Same-workspace native boundary required before agy');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) throw new Error('Invalid agy prompt');
  const args = ['--model', model, '--effort', effort, '--output-format', 'stream-json', '--print-timeout', '3600s', '--disable-slash-commands',
    '--dangerously-skip-permissions', '--add-dir', cwd, '--print', prompt];
  const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  if (args.map(quote).join(' ').length + 1024 > 32766) throw new Error('Windows argv limit: a verified prompt-artifact reader is required');
  return args;
}

export function agyUsage(raw, semantics = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const input = count(raw.input_tokens), cached = count(raw.cache_read_tokens), output = count(raw.output_tokens), thinking = count(raw.thinking_tokens);
  for (const key of ['input_tokens', 'cache_read_tokens', 'output_tokens', 'thinking_tokens', 'total_tokens'])
    if (raw[key] !== undefined && count(raw[key]) === null) throw new Error('Invalid agy usage: ' + key);
  const verified = /^[a-f0-9]{64}$/.test(semantics.evidenceHash ?? '');
  const includesCache = verified ? semantics.inputIncludesCached : null;
  const includesThinking = verified ? semantics.outputIncludesThinking : null;
  if (includesCache === true && input !== null && cached !== null && cached > input) throw new Error('Cached input exceeds inclusive input');
  const inputTokens = includesCache === true ? input : includesCache === false && input !== null && cached !== null ? input + cached : null;
  const outputTokens = includesThinking === true ? output : includesThinking === false && output !== null && thinking !== null ? output + thinking : null;
  return { inputTokens, cachedInputTokens: cached, outputTokens, reasoningOutputTokens: thinking, cacheWriteInputTokens: null,
    uncachedInputTokens: includesCache === false ? input : includesCache === true && input !== null && cached !== null ? input - cached : null,
    reported: { ...raw }, semantics: verified ? { ...semantics } : null };
}

export class AgyStream {
  constructor({ workspace, capability, semantics = {}, onEvent = () => {}, maxLineBytes = 16 * 1024 * 1024, backend = 'windows-appcontainer-job' }) {
    if (!['windows-appcontainer-job', 'agy-trusted-host-builtin-sandbox-v1'].includes(backend)) throw Error('Unknown agy backend');
    this.backend = backend;
    this.workspace = resolve(workspace); this.capability = capability; this.semantics = semantics; this.onEvent = onEvent;
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.line = 0; this.init = null; this.result = null;
    this.steps = new Map(); this.failures = []; this.unknownEvents = []; this.maxLineBytes = maxLineBytes; this.ended = false;
  }
  write(bytes) {
    if (this.ended) throw new Error('agy stream already ended');
    this.buffer += this.decoder.write(bytes);
    this.drain(false);
  }
  drain(final) {
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1); this.accept(line);
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) throw new Error('agy protocol line overflow');
    if (final && this.buffer.trim()) { const line = this.buffer; this.buffer = ''; this.accept(line); }
  }
  accept(line) {
    if (!line.trim()) return;
    this.line++;
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('agy protocol line overflow');
    let event;
    try { event = JSON.parse(line); } catch (error) { this.failures.push({ id: 'parse-' + this.line, line: this.line, error: error.message }); return; }
    this.onEvent(event, line, this.line);
    if (this.result) { this.failures.push({ id: 'after-result-' + this.line, error: 'Event after terminal result' }); return; }
    if (event.event === 'init') {
      if (this.init) this.failures.push({ id: 'duplicate-init', error: 'Duplicate init' });
      else this.init = { ...event.init, conversation_id: event.conversation_id };
    } else if (event.event === 'step_update') {
      const step = event.step_update;
      if (!Number.isSafeInteger(step?.step_index) || step.step_index < 0 || !['ACTIVE', 'DONE'].includes(step.state)) {
        this.failures.push({ id: 'invalid-step-' + this.line, error: 'Invalid step identity/state' }); return;
      }
      if (step.conversation_id && step.conversation_id !== this.init?.conversation_id) this.failures.push({ id: 'conversation-' + this.line, error: 'Conversation changed' });
      if (step.subagent_info) this.failures.push({ id: 'subagent-' + step.step_index, error: 'Subagents forbidden by protocol' });
      const key = step.step_index, previous = this.steps.get(key);
      if (previous?.state === 'DONE' && JSON.stringify(previous) !== JSON.stringify(step)) this.failures.push({ id: 'step-drift-' + key, error: 'Completed step changed' });
      this.steps.set(key, step);
    } else if (event.event === 'result') this.result = event.result;
    else this.unknownEvents.push({ line: this.line, event });
  }
  finish({ receipt, stderr = '' }) {
    if (this.ended) throw new Error('agy stream already ended');
    this.buffer += this.decoder.end(); this.drain(true); this.ended = true;
    const settingsVerified = this.init?.model === this.capability?.resolvedId && resolve(this.init?.cwd ?? '') === this.workspace &&
      this.init?.permission_mode === (this.backend === 'windows-appcontainer-job' ? 'always-proceed' : 'proceed-in-sandbox') && this.capability?.available === true;
    const tools = [...this.steps.values()].filter(step => step.step_type === 'tool').map(step => ({
      id: (this.init?.conversation_id ?? 'unknown') + '-step-' + step.step_index, state: step.state,
      name: step.tool_name ?? step.tool_info?.name ?? null, parameters: step.tool_info?.parameters ?? null,
      output: step.tool_info?.output ?? null, error: step.tool_info?.error ?? null, failed: Boolean(step.tool_info?.error) }));
    const softDenial = /soft.denied|permission (?:denied|required)|requires approval|not allowed in (?:print|headless) mode/i.test(stderr);
    const conversationVerified = Boolean(this.init?.conversation_id && this.result?.conversation_id === this.init.conversation_id);
    const usage = agyUsage(this.result?.usage, this.semantics);
    const identity = this.backend === 'windows-appcontainer-job' ? receipt?.appContainer === true : receipt?.hostCoordinator === true && receipt.appContainer === false;
    const stopped = identity && receipt.writersStopped === true && receipt.activeProcesses === 0;
    return { passed: stopped && receipt.exitStatus === 0 && receipt.timedOut !== true && settingsVerified && conversationVerified &&
      this.result?.status === 'SUCCESS' && !this.failures.length && !this.unknownEvents.length && !softDenial && tools.every(tool => tool.state === 'DONE'),
      settingsVerified, actualModel: this.init?.model ?? null, actualEffort: null, effortEvidence: this.capability?.effortEvidence ?? null,
      conversationId: this.init?.conversation_id ?? null, status: this.result?.status ?? null, usage, rawUsage: this.result?.usage ?? null,
      mandatoryUsageComplete: ['inputTokens', 'cachedInputTokens', 'outputTokens', 'uncachedInputTokens'].every(key => Number.isSafeInteger(usage?.[key])),
      tools, failures: this.failures, unknownEvents: this.unknownEvents, softDenial, stopped, rawResult: this.result };
  }
}
