import { readFileSync, existsSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { isProviderLaunchFailure, isCompletedCommandEvent, verifyProviderObservation, providerObservationAncestors } from './provider-observations.mjs';

export function canonicalEvidence(evidence, { handoffDirectory = 'handoff' } = {}) {
  if (!['handoff', '.handoff'].includes(handoffDirectory)) throw new Error('Invalid handoff directory');
  const current = readFileSync(join(evidence, handoffDirectory, 'CURRENT.md'), 'utf8');
  const reference = current.match(/^Full evidence: (.+)$/m)?.[1]?.trim();
  if (!reference) throw new Error('Final full evidence reference missing');
  const path = resolve(evidence, reference.replace(/^\.handoff[\\/]/, handoffDirectory + '/'));
  if (!path.startsWith(resolve(evidence, handoffDirectory) + sep)) throw new Error('Evidence reference outside handoff');
  if (!realpathSync.native(path).startsWith(realpathSync.native(join(evidence, handoffDirectory)) + sep)) throw new Error('Evidence reference outside handoff');
  const full = readFileSync(path, 'utf8');
  const payload = JSON.parse(full);
  if (!Array.isArray(payload.evidence) || !payload.evidence.length) throw new Error('Structured evidence missing');
  if (payload.decisions !== undefined && (!Array.isArray(payload.decisions) || payload.decisions.some(item => !item || ['decision', 'reason'].some(field => typeof item[field] !== 'string' || !item[field].trim())))) throw new Error('Invalid canonical decisions');
  if (payload.unresolved !== undefined && (!Array.isArray(payload.unresolved) || payload.unresolved.some(item => typeof item !== 'string' || !item.trim()))) throw new Error('Invalid canonical unresolved');
  const artifacts = [];
  for (const item of payload.evidence) {
    if (!Number.isSafeInteger(item.cases) || item.cases < 0 || ['command', 'result', 'artifact'].some(field => typeof item[field] !== 'string' || !item[field].trim())) throw new Error('Invalid handoff evidence');
    const artifact = resolve(evidence, item.artifact.replace(/^\.handoff[\\/]/, handoffDirectory + '/'));
    if (!artifact.startsWith(resolve(evidence) + sep) || !existsSync(artifact)) throw new Error('Evidence artifact missing or outside snapshot');
    if (!realpathSync.native(artifact).startsWith(realpathSync.native(evidence) + sep)) throw new Error('Evidence artifact outside snapshot');
    const content = readFileSync(artifact);
    const digest = createHash('sha256').update(content).digest('hex');
    if (item.sha256 !== undefined && item.sha256 !== digest) throw new Error('Evidence artifact hash mismatch');
    artifacts.push({ path: artifact, hash: digest, bytes: content.length, content: content.toString('utf8') });
  }
  return { current, full, payload, path, artifacts, handoffDirectory, hash: createHash('sha256').update(current).update(full).update(JSON.stringify(artifacts)).digest('hex') };
}

export function findEvidenceArtifact(evidence, canonical, { id, kind, path, sha256 }) {
  const matches = canonical.payload.evidence.filter(item =>
    (id === undefined || item.id === id) && (kind === undefined || item.kind === kind) &&
    (path === undefined || item.artifact.replaceAll('\\', '/') === path.replaceAll('\\', '/')));
  if (matches.length !== 1 || [id, kind, path].every(value => value === undefined)) throw new Error('Evidence identity missing or ambiguous');
  const target = resolve(evidence, matches[0].artifact.replace(/^\.handoff[\\/]/, (canonical.handoffDirectory ?? 'handoff') + '/'));
  const artifact = canonical.artifacts.find(item => item.path === target);
  if (!artifact || !/^[a-f0-9]{64}$/.test(sha256 ?? '') || artifact.hash !== sha256 ||
    !realpathSync.native(artifact.path).startsWith(realpathSync.native(evidence) + sep) ||
    createHash('sha256').update(readFileSync(artifact.path)).digest('hex') !== sha256) throw new Error('Evidence bytes hash mismatch');
  return artifact;
}

export function validateFailureReportHistory(evidence, canonical, { requiredFailureReports = [], authoritative = false } = {}) {
  const directory = join(evidence, canonical.handoffDirectory ?? 'handoff', 'verifications');
  const required = new Map();
  for (const receipt of requiredFailureReports) {
    if (!/^\.handoff\/verifications\/[A-Za-z0-9_-]+\.json$/.test(receipt.artifact) || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw Error('Invalid required failure report receipt');
    const previous = required.get(receipt.artifact);
    if (previous && previous.sha256 !== receipt.sha256) throw Error('Failure report revision reused');
    required.set(receipt.artifact, receipt);
  }
  const revisions = new Set();
  if (existsSync(directory)) {
    if (!realpathSync.native(directory).startsWith(realpathSync.native(evidence) + sep)) throw Error('Failure reports outside snapshot');
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (!/^[A-Za-z0-9_-]+\.json$/.test(name) || !lstatSync(path).isFile()) throw Error('Invalid failure report file');
      const bytes = readFileSync(path), report = JSON.parse(bytes);
      if (typeof report.passed !== 'boolean' || report.revision !== name.slice(0, -5) || revisions.has(report.revision)) throw Error('Invalid failure report revision');
      revisions.add(report.revision);
      if (!report.passed) {
        const artifact = '.handoff/verifications/' + name;
        if (authoritative && !required.has(artifact)) throw Error('FAIL report has no bound verifier output: ' + artifact);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (required.has(artifact) && required.get(artifact).sha256 !== sha256) throw Error('Failure report bytes changed');
        required.set(artifact, { artifact, sha256 });
      }
    }
  }
  for (const receipt of required.values()) {
    const artifact = findEvidenceArtifact(evidence, canonical, { path: receipt.artifact, sha256: receipt.sha256 });
    const report = JSON.parse(artifact.content);
    if (report.passed !== false || receipt.artifact !== `.handoff/verifications/${report.revision}.json`) throw Error('Required report is not a matching FAIL revision');
  }
  return { requiredFailureReports: [...required.values()] };
}

export function publicationHash(evidence, canonical) {
  const artifacts = canonical.artifacts.map(item => ({
    path: item.path.slice(resolve(evidence).length + 1).replaceAll('\\', '/').replace(/^\.handoff\//, 'handoff/'),
    hash: item.hash,
  }));
  return createHash('sha256').update(canonical.current).update(canonical.full).update(JSON.stringify(artifacts)).digest('hex');
}

export function validateSourceClaims(claim, { original, before, final, predecessor = null }) {
  const paths = Object.keys(final).filter(path => path.startsWith('src/'));
  if (!claim || !paths.length || JSON.stringify(Object.keys(claim.files ?? {}).sort()) !== JSON.stringify(paths.sort())) throw new Error('Source claim paths missing or unexpected');
  if (predecessor === null ? claim.predecessorStatus !== 'absent' || !claim.reason?.trim() : claim.predecessorStatus !== 'matched') throw new Error('Invalid predecessor status/reason');
  for (const path of paths) {
    const entry = claim.files[path];
    const expected = { originalBefore: original[path], predecessorFinal: predecessor?.[path] ?? null, actualBefore: before[path], final: final[path] };
    for (const [role, digest] of Object.entries(expected)) {
      if (digest !== null && !/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Invalid source manifest: ' + path + ' ' + role);
      if (entry?.[role] !== digest) throw new Error('Source claim mismatch: ' + path + ' ' + role);
    }
    if (predecessor && before[path] !== predecessor[path]) throw new Error('Continuation source mismatch: ' + path);
  }
  return { passed: true, files: paths.length };
}

export function verifySourceEvidence(evidence, manifests, canonical = canonicalEvidence(evidence)) {
  const reference = canonical.payload.evidence.find(item => item.artifact.replaceAll('\\', '/').endsWith('/source-claims.json'));
  if (!reference) throw new Error('Source claims artifact missing');
  const artifact = canonical.artifacts.find(item => item.path === resolve(evidence, reference.artifact.replace(/^\.handoff[\\/]/, (canonical.handoffDirectory ?? 'handoff') + '/')));
  const claim = JSON.parse(artifact.content);
  const result = validateSourceClaims(claim, manifests);
  const rendered = JSON.stringify(claim);
  for (const [name, content] of [['RESULT', readFileSync(join(evidence, 'RESULT.md'), 'utf8')], ['CURRENT', canonical.current]]) {
    if (!content.includes(rendered)) throw new Error('Source claims missing or inconsistent in ' + name);
  }
  return { ...result, path: artifact.path, hash: artifact.hash, canonicalHash: canonical.hash, artifacts: canonical.artifacts.length };
}

export function validateEvidenceAssessment(assessment, binding, requiredIssues, commands = []) {
  if (assessment?.canonicalHash !== binding.canonicalHash || assessment?.eventsHash !== binding.eventsHash || assessment?.resultHash !== binding.resultHash) throw new Error('Content assessment binding mismatch');
  if (!assessment.rawTraceReviewed || !assessment.checkpointBeforeFinal || !assessment.freshAcceptanceReviewed || !assessment.rubricPassed) throw new Error('Full raw/content review required');
  const issues = assessment.issues;
  if (!Array.isArray(issues) || new Set(issues.map(issue => issue.id)).size !== issues.length) throw new Error('Unique issue assessment required');
  for (const id of requiredIssues) if (!issues.some(issue => issue.id === id)) throw new Error('Missing prior issue: ' + id);
  for (const command of commands) {
    const reviewed = assessment.commands?.find(item => item.id === command.id);
    if (!reviewed || typeof reviewed.reason !== 'string' || !reviewed.reason.trim() || typeof reviewed.failed !== 'boolean') throw new Error('Unreviewed raw command: ' + command.id);
    if ((reviewed.failed || command.exitCode !== 0) && !issues.some(issue => issue.rawReference.includes(command.id))) throw new Error('Observed command failure omitted: ' + command.id);
  }
  for (const issue of issues) {
    for (const field of ['id', 'rawReference', 'command', 'output', 'correction', 'resultReference', 'canonicalReference', 'ledgerReference', 'reason']) {
      if (typeof issue[field] !== 'string' || !issue[field].trim()) throw new Error('Missing issue evidence: ' + field);
    }
    if (commands.length && !commands.some(command => issue.rawReference.includes(command.id))) {
      throw new Error('Issue has no completed raw command: ' + issue.id);
    }
    if (issue.verified !== true) throw new Error('Unverified issue: ' + issue.id);
  }
}

export function validatePublishedIssues(evidence, issues, canonical, { strict = false, providerObservations = null } = {}) {
  const ledger = JSON.parse(readFileSync(join(evidence, canonical.handoffDirectory ?? 'handoff', 'errors.json'), 'utf8'));
  const entries = Array.isArray(ledger) ? ledger : ledger.issues;
  if (!Array.isArray(entries)) throw new Error('Agent error ledger must contain issues');
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate agent error ID');
  const result = readFileSync(join(evidence, 'RESULT.md'), 'utf8');
  for (const issue of issues) {
    const entry = entries.find(item => item.id === issue.id);
    if (!entry || !result.includes(issue.id) || !(canonical.current + canonical.full).includes(issue.id)) throw new Error('Published error history incomplete: ' + issue.id);
    const output = entry.output ?? entry.actualOutput;
    if (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || typeof output !== 'string' || !output.trim() || ['command', 'correction', 'reference'].some(field => typeof entry[field] !== 'string' || !entry[field].trim())) throw new Error('Incomplete agent error ledger: ' + issue.id);
    if (strict) validateIssueReceipt(evidence, entry, issue, canonical.handoffDirectory ?? 'handoff', providerObservations, canonical);
  }
  for (const entry of entries) if (!issues.some(issue => issue.id === entry.id)) throw new Error('Agent error not reviewed: ' + entry.id);
  if (strict && providerObservations) {
    for (const record of providerObservations.requireRawTrace ? providerObservations.records ?? [] : []) {
      for (const envelope of record.envelopes.filter(event => isProviderLaunchFailure(event.message) ||
          providerObservations.scheme === 'ed25519-completed-command-v2' && isCompletedCommandEvent(event.message))) {
        const item = envelope.message.params.item;
        const kind = isProviderLaunchFailure(envelope.message) ? 'provider-launch-failure' : 'provider-completed-command';
        if ((kind === 'provider-launch-failure' || Number.isInteger(item.exitCode) && item.exitCode !== 0) &&
            !entries.some(entry => entry.outputReference?.kind === kind && entry.outputReference.eventId === item.id)) {
          throw Error('Provider ' + (kind === 'provider-launch-failure' ? 'launch' : 'completed command') + ' failure omitted: ' + item.id);
        }
      }
    }
    const directory = join(evidence, canonical.handoffDirectory ?? 'handoff', 'provider-observations');
    if (existsSync(directory)) for (const name of readdirSync(directory)) {
      const path = rawFailurePath(evidence, join(canonical.handoffDirectory ?? 'handoff', 'provider-observations', name), canonical.handoffDirectory ?? 'handoff');
      const observation = JSON.parse(readFileSync(path, 'utf8'));
      const verified = verifyObservationContext(observation, providerObservations);
      const mustReport = verified.kind === 'provider-launch-failure' ||
        Number.isInteger(verified.envelope.message.params.item.exitCode) && verified.envelope.message.params.item.exitCode !== 0;
      if (name !== verified.eventId + '.json' || mustReport && !entries.some(entry => entry.outputReference?.kind === verified.kind &&
          entry.outputReference.eventId === verified.eventId)) throw Error('Provider ' +
          (verified.kind === 'provider-launch-failure' ? 'launch' : 'completed command') + ' failure omitted: ' + verified.eventId);
    }
  }
}

function rawFailurePath(evidence, name, handoffDirectory) {
  if (typeof name !== 'string' || name.split(/[\\/]/).includes('..')) throw new Error('Invalid raw failure path');
  const path = resolve(evidence, name.replace(/^\.handoff[\\/]/, handoffDirectory + '/'));
  if (!path.startsWith(resolve(evidence) + sep) || !realpathSync.native(path).startsWith(realpathSync.native(evidence) + sep)) throw new Error('Raw failure path outside snapshot');
  return path;
}

function verifyObservationContext(observation, context) {
  if (!context?.publicKey) throw Error('Provider observation public key required');
  const verified = verifyProviderObservation(observation, context.publicKey, { binding: context.binding ?? {} });
  if (context.requireRawTrace) {
    const record = context.records?.find(record => record.binding.attemptId === verified.binding.attemptId);
    const envelope = record?.envelopes.find(event => event.message.method === 'item/completed' && event.message.params?.item?.id === verified.eventId);
    if (!record || !envelope) throw Error('Original provider event missing: ' + verified.eventId);
    verifyProviderObservation(observation, context.publicKey, { binding: record.binding, envelope });
  }
  return verified;
}

function validateIssueReceipt(evidence, entry, issue, handoffDirectory, providerObservations, canonical) {
  if (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || entry.verificationStatus !== 'verified') throw new Error('Unverified/capped error ledger: ' + entry.id);
  const reference = entry.outputReference;
  if (['provider-launch-failure', 'provider-completed-command'].includes(reference?.kind)) {
    const path = rawFailurePath(evidence, reference.path, handoffDirectory), bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.hash) throw Error('Provider observation artifact hash mismatch');
    const verified = verifyObservationContext(JSON.parse(bytes), providerObservations);
    if (path !== resolve(evidence, handoffDirectory, 'provider-observations', verified.eventId + '.json') ||
        lstatSync(path).isSymbolicLink() || lstatSync(path).nlink !== 1) throw Error('Provider observation must be an unlinked file in its protected directory');
    if (verified.kind !== reference.kind || verified.eventId !== reference.eventId || issue.rawCommandId && issue.rawCommandId !== verified.eventId ||
        verified.binding.attempt !== entry.attempt) throw Error('Provider observation ledger identity mismatch');
    if (entry.command !== verified.envelope.message.params.item.command) throw Error('Provider failure command differs from signed event');
    if (verified.kind === 'provider-completed-command') {
      const exitCode = verified.envelope.message.params.item.exitCode;
      if (reference.failureMode !== (Number.isInteger(exitCode) && exitCode !== 0 ? 'nonzero' : 'reviewed-inner-error')) {
        throw Error('Completed command failure mode differs from signed event');
      }
    }
    if (!canonical.artifacts.some(artifact => artifact.path === path)) throw Error('Provider observation missing from canonical artifacts');
    if (!canonical.artifacts.some(artifact => artifact.path === resolve(evidence, handoffDirectory, 'errors.json'))) throw Error('Provider error ledger missing from canonical artifacts');
    if (entry.outputMode !== 'artifact-reference' && (entry.output ?? entry.actualOutput) !== verified.output) throw Error('Provider failure output differs from signed event');
    return;
  }
  if (!reference || !['stdout', 'stderr', 'receipt'].includes(reference.stream)) throw new Error('Raw failure reference required: ' + entry.id);
  const inside = name => rawFailurePath(evidence, name, handoffDirectory);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const receiptPath = inside(reference.receipt), receiptBytes = readFileSync(receiptPath);
  if (sha(receiptBytes) !== reference.receiptHash) throw new Error('Raw command receipt hash mismatch');
  const receipt = JSON.parse(receiptBytes);
  if (receipt.id !== reference.commandId || issue.rawCommandId && issue.rawCommandId !== receipt.id) throw new Error('Failure command ID mismatch');
  const failed = receipt.exitCode !== 0 && (Number.isInteger(receipt.exitCode) || typeof receipt.error === 'string' && receipt.error.length > 0 || receipt.signal);
  if (!failed && reference.kind !== 'observed-inner-error') throw new Error('Successful checkpoint cannot prove command failure');
  const path = inside(reference.path), bytes = readFileSync(path);
  const expected = reference.stream === 'receipt' ? { path: reference.receipt, hash: reference.receiptHash } : receipt[reference.stream];
  if (!expected || inside(expected.path) !== path || sha(bytes) !== reference.hash || expected.hash !== reference.hash) throw new Error('Raw failure artifact binding mismatch');
  if (entry.outputMode !== 'artifact-reference' && (entry.output ?? entry.actualOutput) !== bytes.toString('utf8')) throw new Error('Raw failure output differs from captured bytes');
  if (reference.stream === 'stdout' && /(?:^|[\\/])agent-verify\.mjs$/.test(receipt.argv?.[0] ?? '')) {
    const report = JSON.parse(bytes.toString('utf8'));
    if (report.passed !== (receipt.exitCode === 0) || sha(readFileSync(inside(report.artifact))) !== report.sha256) throw new Error('Immutable verification report binding mismatch');
  }
}

export function validateCommandCaptures(evidence, commands, { handoffDirectory = 'handoff' } = {}) {
  const receipts = new Map();
  const captured = new Map();
  const pending = [];
  function inspect(text, depth = 0) {
    if (typeof text !== 'string' || depth > 3) return;
    const unwrapped = text.replace(/([^\r\n])\r\n\x1b\[[1-9][0-9]*;80H\1/g, '$1');
    for (const line of stripVTControlCharacters(unwrapped).split(/\r?\n/)) {
      const prefix = line.match(/^CAPTURE ([A-Za-z0-9._-]{1,200}):?\s+(\{.*\})$/);
      const helper = line.match(/^CAPTURE_HELPER ([A-Za-z0-9._-]{1,200}) exit (-?\d+|null) stdout (\{.*\})$/);
      const inline = line.match(/^RECEIPT (\.handoff\/commands\/([A-Za-z0-9._-]{1,200})\/command\.json) (\{.*\})$/);
      let value; try { value = JSON.parse(inline ? inline[3] : prefix ? prefix[2] : helper ? helper[3] : line); } catch { continue; }
      if (inline) {
        const path = resolve(evidence, inline[1].replace(/^\.handoff\//, handoffDirectory + '/'));
        if (!path.startsWith(resolve(evidence) + sep) || !realpathSync.native(path).startsWith(realpathSync.native(evidence) + sep)) throw Error('Inline receipt outside snapshot');
        const bytes = readFileSync(path), receipt = JSON.parse(bytes);
        if (value.schemaVersion !== 1 || value.id !== inline[2] || typeof value.executable !== 'string' ||
            !Array.isArray(value.argv) || !value.argv.every(arg => typeof arg === 'string') ||
            !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.finishedAt)) ||
            !value.stdout || !value.stderr || JSON.stringify(value) !== JSON.stringify(receipt)) throw Error('Inline receipt differs from immutable raw trace');
        value = { commandId: receipt.id, receipt: inline[1], sha256: createHash('sha256').update(bytes).digest('hex'), exitCode: receipt.exitCode };
      }
      if (value?.commandId && value?.receipt && value?.sha256) {
        if (prefix && value.commandId !== prefix[1]) throw new Error('Captured command prefix identity mismatch');
        if (helper && (value.commandId !== helper[1] || value.exitCode !== JSON.parse(helper[2])))
          throw new Error('Captured helper prefix identity/exit mismatch');
        if (typeof value.receipt !== 'string' || value.receipt.split(/[\\/]/).includes('..')) throw new Error('Invalid captured receipt reference');
        const path = resolve(evidence, value.receipt.replace(/^\.handoff[\\/]/, handoffDirectory + '/'));
        if (!path.startsWith(resolve(evidence) + sep) || !realpathSync.native(path).startsWith(realpathSync.native(evidence) + sep)) throw new Error('Captured receipt outside snapshot');
        const bytes = readFileSync(path), receipt = JSON.parse(bytes);
        if (createHash('sha256').update(bytes).digest('hex') !== value.sha256 || receipt.id !== value.commandId || receipt.exitCode !== value.exitCode) throw new Error('Captured command receipt differs from immutable raw trace');
        if (receipts.has(value.commandId) && receipts.get(value.commandId) !== value.sha256) throw new Error('Captured command ID reused with different bytes');
        if (!receipts.has(value.commandId)) pending.push(receipt);
        receipts.set(value.commandId, value.sha256);
        captured.set(value.commandId, receipt);
      }
      for (const key of ['output', 'stdout', 'aggregatedOutput']) if (typeof value?.[key] === 'string') inspect(value[key], depth + 1);
    }
  }
  for (const command of commands) inspect(command.aggregatedOutput ?? command.output);
  for (let index = 0; index < pending.length; index++) {
    for (const name of ['stdout', 'stderr']) {
      const stream = pending[index][name];
      if (stream === undefined) continue;
      if (!stream || typeof stream.path !== 'string' || stream.path.split(/[\\/]/).includes('..') ||
          !/^[a-f0-9]{64}$/.test(stream.hash ?? '')) throw new Error('Invalid captured stream reference');
      const path = resolve(evidence, stream.path.replace(/^\.handoff[\\/]/, handoffDirectory + '/'));
      if (!path.startsWith(resolve(evidence) + sep) || !realpathSync.native(path).startsWith(realpathSync.native(evidence) + sep))
        throw new Error('Captured stream outside snapshot');
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== stream.hash) throw new Error('Captured stream hash mismatch');
      inspect(bytes.toString('utf8'));
    }
  }
  return { passed: true, commandReceipts: receipts.size, captured: [...captured.values()] };
}

export function validateWorkflowHistory(evidence, commands, canonical, { continuation = false, taskId, sessionId, requiredFailureReports = [], requireFinalPass = false, authoritative = false, notBefore } = {}) {
  const directory = canonical.handoffDirectory ?? 'handoff';
  const captures = validateCommandCaptures(evidence, commands, { handoffDirectory: directory }).captured;
  const reports = [...requiredFailureReports], starts = [], passes = [], contexts = [];
  const earliest = notBefore === undefined ? null : Date.parse(notBefore);
  if (earliest !== null && !Number.isFinite(earliest)) throw Error('Invalid invocation lifecycle timestamp');
  for (const command of commands) {
    if (!/(?:^|[\\/])agent-verify\.mjs(?:\s|['"])/.test(command.command ?? '')) continue;
    for (const line of stripVTControlCharacters(command.aggregatedOutput ?? '').split(/\r?\n/)) {
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value.passed === false && value.artifact && value.sha256) reports.push(value);
      if (value.passed === true && value.artifact && value.sha256) passes.push(value);
    }
  }
  const readStream = stream => {
    if (!stream || typeof stream.path !== 'string' || stream.path.split(/[\\/]/).includes('..')) throw Error('Invalid workflow stream');
    const path = resolve(evidence, stream.path.replace(/^\.handoff[\\/]/, directory + '/'));
    if (!realpathSync.native(path).startsWith(realpathSync.native(evidence) + sep)) throw Error('Workflow stream outside snapshot');
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== stream.hash) throw Error('Workflow stream hash mismatch');
    return bytes.toString('utf8');
  };
  for (const receipt of captures) {
    const argv = receipt.argv ?? [];
    const output = readStream(receipt.stdout);
    readStream(receipt.stderr);
    if (earliest !== null) {
      const created = Date.parse(receipt.startedAt);
      if (!Number.isFinite(created)) throw Error('Invalid workflow receipt timestamp');
      if (created < earliest) continue;
    }
    const cli = argv.findIndex(arg => /@agent-bridge[\\/]cli[\\/]dist[\\/]index\.js$/.test(arg));
    if (cli >= 0 && ['task', 'session'].includes(argv[cli + 1]) && argv[cli + 2] === 'start' && receipt.exitCode === 0) {
      const match = output.match(/(?:Bound codex session|Started codex session) (\S+) (?:to|for) (\S+)/);
      if (!match) throw Error('Lifecycle start receipt lacks task/session binding');
      starts.push({ kind: argv[cli + 1], sessionId: match[1], taskId: match[2], receipt: receipt.id });
    }
    if (cli >= 0 && argv[cli + 1] === 'context' && argv[cli + 2] === 'startup' && receipt.exitCode === 0) {
      contexts.push({ taskId: output.match(/^Task: (.+)$/m)?.[1]?.trim(), sessionId: output.match(/^Session: (.+)$/m)?.[1]?.trim() });
    }
    if (argv.some(arg => /(?:^|[\\/])agent-verify\.mjs$/.test(arg))) {
      for (const line of output.trim().split(/\r?\n/)) {
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.passed === false && value.artifact && value.sha256) reports.push(value);
        if (value.passed === true && value.artifact && value.sha256) passes.push(value);
      }
    }
  }
  const expected = continuation ? 'session' : 'task';
  if (starts.length !== 1 || starts[0].kind !== expected || (taskId && starts[0].taskId !== taskId) || (sessionId && starts[0].sessionId !== sessionId)) throw Error('G4-first-task-extra-session: invalid invocation task/session lifecycle');
  if (!contexts.length || contexts.some(context => context.taskId !== starts[0].taskId || context.sessionId !== starts[0].sessionId)) throw Error('Lifecycle context startup task/session binding missing or inconsistent');
  const history = validateFailureReportHistory(evidence, canonical, { requiredFailureReports: reports, authoritative });
  if (requireFinalPass) {
    const digest = publicationHash(evidence, canonical);
    const resultHash = createHash('sha256').update(readFileSync(join(evidence, 'RESULT.md'))).digest('hex');
    const manifestHash = createHash('sha256').update(readFileSync(join(evidence, directory, 'manifests.json'))).digest('hex');
    const bound = passes.some(receipt => {
      if (!/^\.handoff\/verifications\/[A-Za-z0-9_-]+\.json$/.test(receipt.artifact)) return false;
      const path = join(evidence, receipt.artifact.replace('.handoff/', directory + '/'));
      if (!existsSync(path) || !realpathSync.native(path).startsWith(realpathSync.native(evidence) + sep)) return false;
      const bytes = readFileSync(path), report = JSON.parse(bytes);
      return createHash('sha256').update(bytes).digest('hex') === receipt.sha256 && report.passed === true &&
        report.publicationHash === digest && report.resultHash === resultHash && report.sourceManifestsHash === manifestHash;
    });
    if (!bound) throw Error('Final PASS is missing or publication/result/source binding changed');
  }
  return { starts, ...history };
}

export function validateWorkflowChain(rows, row, { requireFinalPass = true, recovery = null } = {}) {
  let history = [], result;
  const sessions = new Set();
  const chain = providerObservationAncestors(rows, row);
  for (const [index, invocation] of chain.entries()) {
    const archived = JSON.parse(readFileSync(join(invocation.evidence, 'source-after.json'), 'utf8'));
    for (const [name, digest] of Object.entries(archived)) {
      if ((!name.startsWith('src/') && name !== 'RESULT.md') || name.split(/[\\/]/).includes('..')) throw Error('Invalid archived source path');
      const path = name === 'RESULT.md' ? join(invocation.evidence, name) : join(invocation.evidence, 'source-after', name.slice(4));
      if (!realpathSync.native(path).startsWith(realpathSync.native(invocation.evidence) + sep) || createHash('sha256').update(readFileSync(path)).digest('hex') !== digest) throw Error('Archived source changed after verification');
    }
    const commands = readFileSync(join(invocation.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
      .filter(event => isCompletedCommandEvent(event.message)).map(event => event.message.params.item);
    if (index < chain.length - 1 && recovery?.formalDisconnectRecovery?.entries?.[invocation.id]) {
      if (createHash('sha256').update(JSON.stringify(invocation)).digest('hex') !== recovery.formalDisconnectRecovery.entries[invocation.id].predecessorHash ||
          (recovery.formalDisconnectRecovery.entries[invocation.id].startupFailure ? invocation.turn?.status !== 'completed' || commands.length !== 0 || invocation.binding != null :
            recovery.formalDisconnectRecovery.entries[invocation.id].capacityFailure ? invocation.turn?.status !== 'failed' || invocation.turn.error?.codexErrorInfo !== 'serverOverloaded' || invocation.usage !== null || commands.length !== 0 :
            recovery.formalDisconnectRecovery.entries[invocation.id].hostInterruptedFailure ? invocation.turn !== null || invocation.usage !== null || invocation.failureClass !== 'host_interrupted' || invocation.nativeStop?.exitStatus !== 125 || commands.length !== 13 :
            recovery.formalDisconnectRecovery.entries[invocation.id].approvedTimeoutGap ? invocation.turn?.status !== 'timeout' :
            recovery.formalDisconnectRecovery.entries[invocation.id].completedCompaction ? invocation.turn?.status !== 'completed' || invocation.failureClass !== 'controlled_input_compaction' || invocation.measurementEligible !== false :
            recovery.formalDisconnectRecovery.entries[invocation.id].finalTurnTimeout ? invocation.turn?.status !== 'timeout' || invocation.failureClass !== 'product' :
            recovery.formalDisconnectRecovery.entries[invocation.id].timeoutIncompleteWorkflow ? invocation.turn?.status !== 'timeout' || invocation.failureClass !== 'controlled_input_compaction' :
            recovery.formalDisconnectRecovery.entries[invocation.id].completedIncompleteWorkflow ? invocation.turn?.status !== 'completed' :
            invocation.turn?.status !== 'failed' || !(recovery.formalDisconnectRecovery.entries[invocation.id].hostCancelled
              ? invocation.turn.error?.message?.includes('client_cancelled')
              : invocation.turn.error?.message?.includes('stream disconnected before completion'))) ||
          invocation.nativeStop?.writersStopped !== true || invocation.nativeStop.activeProcesses !== 0 || invocation.cleanup?.passed !== true) throw Error('Formal disconnected ancestor changed');
      const inheritedCaptures = validateCommandCaptures(invocation.evidence, commands).captured;
      for (const receipt of inheritedCaptures) {
        if (receipt.exitCode === 0 || !receipt.argv?.some(arg => /(?:^|[\\/])agent-verify\.mjs$/.test(arg))) continue;
        const outputPath = resolve(invocation.evidence, receipt.stdout.path.replace(/^\.handoff[\\/]/, 'handoff/'));
        if (!realpathSync.native(outputPath).startsWith(realpathSync.native(invocation.evidence) + sep)) throw Error('Inherited verifier output outside snapshot');
        const output = readFileSync(outputPath);
        if (createHash('sha256').update(output).digest('hex') !== receipt.stdout.hash) throw Error('Inherited verifier stdout changed');
        for (const line of output.toString('utf8').trim().split(/\r?\n/)) {
          let report; try { report = JSON.parse(line); } catch { continue; }
          if (report.passed !== false || !/^\.handoff\/verifications\/[A-Za-z0-9_-]+\.json$/.test(report.artifact ?? '') || !/^[a-f0-9]{64}$/.test(report.sha256 ?? '')) continue;
          const path = resolve(invocation.evidence, report.artifact.replace('.handoff/', 'handoff/'));
          if (!realpathSync.native(path).startsWith(realpathSync.native(invocation.evidence) + sep)) throw Error('Inherited verifier report outside snapshot');
          const bytes = readFileSync(path), failed = JSON.parse(bytes);
          if (createHash('sha256').update(bytes).digest('hex') !== report.sha256 || failed.passed !== false || report.artifact !== '.handoff/verifications/' + failed.revision + '.json') throw Error('Inherited failed verifier report changed');
          history.push({ artifact: report.artifact, sha256: report.sha256 });
        }
      }
      if (recovery.formalDisconnectRecovery.entries[invocation.id].capacityFailure || recovery.formalDisconnectRecovery.entries[invocation.id].startupFailure) continue;
      if (sessions.has(invocation.binding.sessionId)) throw Error('Formal retry reused session');
      sessions.add(invocation.binding.sessionId);
      continue;
    }
    if (index < chain.length - 1 && invocation.id === recovery?.cancelledRecovery?.predecessorId) {
      if (createHash('sha256').update(JSON.stringify(invocation)).digest('hex') !== recovery.cancelledRecovery.predecessorHash ||
          invocation.turn?.status !== 'failed' || !invocation.turn.error?.message?.includes('client_cancelled') ||
          invocation.nativeStop?.appContainer !== true || invocation.nativeStop.writersStopped !== true || invocation.nativeStop.activeProcesses !== 0 ||
          invocation.cleanup?.passed !== true || !invocation.binding?.sessionId) throw Error('Cancelled ancestor binding changed');
      validateCommandCaptures(invocation.evidence, commands);
      if (sessions.has(invocation.binding.sessionId)) throw Error('Cancelled ancestor reused session');
      sessions.add(invocation.binding.sessionId);
      continue;
    }
    const interrupted = index < chain.length - 1 && (
      recovery?.transportContinuation && (invocation.slotId ?? invocation.id) === 'S-0-handoff-2' &&
        invocation.attempt >= 2 && invocation.attempt < row.attempt ||
      recovery?.thirdAttempt?.predecessorId === invocation.id &&
        ['S-0-handoff-2-attempt-3', 'S-0-handoff-2-attempt-4'].includes(row.id) ||
      recovery?.fourthAttempt?.predecessorId === invocation.id && row.id === 'S-0-handoff-2-attempt-4');
    if (interrupted) {
      const turns = readFileSync(join(invocation.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
        .filter(event => event.message?.method === 'turn/completed');
      if (invocation.turn?.status !== 'failed' ||
          !invocation.turn.error?.message?.includes('stream disconnected before completion') ||
          turns.length !== 1 || turns[0].message.params?.turn?.status !== 'failed' ||
          invocation.nativeStop?.writersStopped !== true || invocation.nativeStop.activeProcesses !== 0 ||
          invocation.nativeStop.appContainer !== true || invocation.cleanup?.passed !== true)
        throw Error('Interrupted ancestor verification failed');
      continue;
    }
    result = validateWorkflowHistory(invocation.evidence, commands, canonicalEvidence(invocation.evidence), {
      continuation: Boolean(invocation.continuationFrom), taskId: invocation.binding?.taskId,
      sessionId: invocation.binding?.sessionId, requiredFailureReports: history,
      requireFinalPass: index === chain.length - 1 ? requireFinalPass : (chain[index + 1].attempt ?? 1) === 1,
      authoritative: true,
      notBefore: invocation.startedAt,
    });
    const session = result.starts[0].sessionId;
    if (sessions.has(session)) throw Error('Continuation reused a closed session');
    sessions.add(session);
    history = result.requiredFailureReports;
  }
  return result;
}
