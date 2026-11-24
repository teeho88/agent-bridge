import { existsSync, readFileSync, copyFileSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, resolve, sep, toNamespacedPath } from 'node:path';
import { createHash } from 'node:crypto';
import { validateCommandCaptures } from './comparison-evidence.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const allowed = ['compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs', 'comparison-evidence.mjs', 'g4-targeted-recovery.mjs', 'recovery-scope-worker.ps1'];

export function validateCompactionTimeout(record, events, audited) {
  const compactions = events.filter(event => event.message?.method === 'item/completed' &&
    event.message.params?.item?.type === 'contextCompaction');
  if (record.status !== 'finished' || record.attempt !== 1 || record.turn?.status !== 'timeout' ||
      record.failureClass !== 'controlled_input_compaction' || record.measurementEligible !== false ||
      record.nativeStop?.appContainer !== true || record.nativeStop.writersStopped !== true ||
      record.nativeStop.activeProcesses !== 0 || record.nativeStop.runId !== record.launch?.runId ||
      record.cleanup?.passed !== true || record.acceptance?.passed !== true ||
      record.unexpectedFiles?.length !== 0 || !compactions.length ||
      compactions.some(event => event.message.params.turnId !== record.launch.turnId) ||
      events.some(event => event.message?.method === 'turn/completed') ||
      audited?.id !== record.id || audited.leaseCount !== 0 ||
      audited.sourceRevisionEvidence?.passed !== true ||
      audited.problems?.length !== 1 || audited.problems[0] !== 'Final turn usage ordering/binding')
    throw Error('Compaction timeout recovery requires stopped, audited evidence and no other integrity defect');
  return true;
}

export function validateCapacityFailure(record, events, before, after) {
  const messages = events.map(event => event.message);
  const turns = messages.filter(message => message?.method === 'turn/completed');
  if (record.status !== 'terminal_infrastructure_failed' || record.measurementEligible !== false ||
      record.invocationError?.message !== 'Selected model is at capacity. Please try a different model.' ||
      record.toolCalls !== 0 || record.toolCallItems?.length !== 0 || !record.launch ||
      record.nativeStop?.writersStopped !== true || record.nativeStop.activeProcesses !== 0 ||
      record.nativeStop.appContainer !== true || record.nativeStop.runId !== record.launch.runId ||
      record.cleanup?.passed !== true || record.finalizationError ||
      turns.length !== 1 || turns[0].params?.turn?.status !== 'failed' ||
      messages.some(message => message?.method?.startsWith('item/') && message.params?.item?.type !== 'userMessage') ||
      digest(JSON.stringify(before)) !== digest(JSON.stringify(after)))
    throw Error('Capacity recovery requires a stopped, unchanged invocation with no model work');
  return true;
}

export function validateStartupInterruption(record, events, before, after) {
  const commands = events.filter(event => event.message?.method === 'item/completed' &&
    event.message.params?.item?.type === 'commandExecution').map(event => event.message.params.item);
  const turns = events.filter(event => event.message?.method === 'turn/completed');
  if (record.status !== 'finished' || record.turn?.status !== 'failed' ||
      record.turn.error?.message !== 'stream disconnected before completion: ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.' ||
      turns.length !== 1 || turns[0].message.params.turn.status !== 'failed' ||
      record.toolCalls !== 1 || commands.length !== 1 || commands[0].exitCode !== 0 ||
      record.toolCallItems?.[0] !== commands[0].id ||
      !commands[0].command?.includes('node .bridge-runtime/evidence/agent-evidence-command.cjs ' + record.lifecycleCommand?.path) ||
      record.nativeStop?.writersStopped !== true || record.nativeStop.activeProcesses !== 0 ||
      record.nativeStop.appContainer !== true || record.nativeStop.runId !== record.launch?.runId ||
      record.cleanup?.passed !== true || record.finalizationError ||
      digest(JSON.stringify(before)) !== digest(JSON.stringify(after)))
    throw Error('Startup transport recovery requires only one successful bootstrap and unchanged product');
  const captures = validateCommandCaptures(record.evidence, commands).captured;
  const expected = [record.lifecycleCommand.path, record.lifecycleCommand.context.path].map(path => path.split('/').at(-1).replace(/\.json$/, ''));
  if (captures.length !== 2 || captures.some(receipt => receipt.exitCode !== 0 || !expected.includes(receipt.id)))
    throw Error('Interrupted startup receipts differ');
  for (const spec of [record.lifecycleCommand, record.lifecycleCommand.context]) {
    if (digest(readFileSync(join(record.workspace, spec.path))) !== spec.hash) throw Error('Interrupted startup spec changed');
  }
  return true;
}

export function validateObservationStartupInterruption(record, events, before, after) {
  const commands = events.filter(event => event.message?.method === 'item/completed' &&
    event.message.params?.item?.type === 'commandExecution').map(event => event.message.params.item);
  if (record.id !== 'S-0-handoff-2-attempt-4' || record.attempt !== 4 ||
      record.status !== 'terminal_infrastructure_failed' || record.measurementEligible !== false ||
      record.invocationError?.message !== 'Provider observation capture failed: Invalid provider observation binding' ||
      record.providerObservationError?.message !== 'Invalid provider observation binding' ||
      record.toolCalls !== 1 || commands.length !== 1 || commands[0].exitCode !== 0 ||
      record.toolCallItems?.length !== 1 || record.toolCallItems[0] !== commands[0].id ||
      !commands[0].command?.includes('node .bridge-runtime/evidence/agent-evidence-command.cjs ' + record.lifecycleCommand?.path) ||
      record.nativeStop?.writersStopped !== true || record.nativeStop.activeProcesses !== 0 ||
      record.nativeStop.appContainer !== true || record.nativeStop.runId !== record.launch?.runId ||
      record.cleanup?.passed !== true || record.finalizationError ||
      digest(JSON.stringify(before)) !== digest(JSON.stringify(after)) ||
      events.some(event => event.message?.method?.startsWith('item/') && event.message.params?.item &&
        !['userMessage', 'commandExecution'].includes(event.message.params.item.type)))
    throw Error('Observation startup recovery requires only one captured bootstrap and unchanged product');
  const captures = validateCommandCaptures(record.evidence, commands).captured;
  const expected = [record.lifecycleCommand.path, record.lifecycleCommand.context.path].map(path => path.split('/').at(-1).replace(/\.json$/, ''));
  if (captures.length !== 2 || captures.some(receipt => receipt.exitCode !== 0 || !expected.includes(receipt.id)))
    throw Error('Observation startup recovery receipts differ');
  for (const spec of [record.lifecycleCommand, record.lifecycleCommand.context]) {
    if (digest(readFileSync(join(record.workspace, spec.path))) !== spec.hash) throw Error('Observation startup spec changed');
  }
  return true;
}

export function loadTargetedRecovery(directory, manifest, root) {
  const path = join(directory, 'host-recovery/authorization.json');
  if (!existsSync(path)) return null;
  const recovery = read(path);
  const extraPath = join(directory, 'host-recovery/attempt-3/authorization.json');
  const extra = existsSync(extraPath) ? read(extraPath) : null;
  const fourthPath = join(directory, 'host-recovery/attempt-4/authorization.json');
  const fourth = existsSync(fourthPath) ? read(fourthPath) : null;
  const continuationPath = join(directory, 'host-recovery/transport-continuation/authorization.json');
  const continuation = existsSync(continuationPath) ? read(continuationPath) : null;
  if (extra) {
    const state = read(join(directory, 'state.json'));
    const ledger = read(join(directory, 'smoke-content-review.json'));
    const second = state.slots[8], review = ledger.rows[8];
    if (extra.schemaVersion !== 1 || extra.kind !== 'isolated-third-attempt' ||
        extra.protocolHash !== manifest.protocolHash || extra.originalAuthorizationHash !== digest(readFileSync(path)) ||
        extra.slotId !== 'S-0-handoff-2' || extra.predecessorId !== 'S-0-handoff-2-attempt-2' ||
        extra.maxAttempts !== 3 || extra.baseCount !== 9 || !extra.userInstruction?.trim() ||
        !manifest.smoke.some(slot => slot.id === extra.slotId) ||
        digest(JSON.stringify(state.slots.slice(0, 9))) !== extra.baseStateHash ||
        digest(JSON.stringify(ledger.rows.slice(0, 9))) !== extra.baseReviewsHash ||
        second?.id !== extra.predecessorId || second.status !== 'finished' || second.attempt !== 2 ||
        second.nativeStop?.appContainer !== true || second.nativeStop?.writersStopped !== true ||
        second.nativeStop?.activeProcesses !== 0 || second.cleanup?.passed !== true ||
        second.turn?.status !== 'failed' || !second.turn.error?.message?.includes('stream disconnected before completion') ||
        review?.id !== second.id || review.verdict !== 'blocked' ||
        state.slots.slice(9, 10).some(row => row.id !== 'S-0-handoff-2-attempt-3' || row.attempt !== 3) ||
        state.slots.length > (continuation ? Infinity : fourth ? 11 : 10) || !Array.isArray(extra.sources) ||
        new Set(extra.sources.map(source => source.name)).size !== extra.sources.length ||
        !extra.sources.length || !Array.isArray(extra.predecessorEvidence))
      throw Error('Third-attempt baseline/slot authorization changed');
    for (const item of extra.predecessorEvidence) {
      if (!['events.jsonl', 'source-before.json', 'source-after.json', 'result.json'].includes(item.name) ||
          digest(readFileSync(join(second.evidence, item.name))) !== item.sha256)
        throw Error('Third-attempt predecessor evidence changed');
    }
    if (new Set(extra.predecessorEvidence.map(item => item.name)).size !== 4) throw Error('Third-attempt evidence set incomplete');
    const eligible = new Set(['compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs',
      'comparison-attempts.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs', 'g4-targeted-recovery.mjs']);
    for (const source of extra.sources) {
      if (!eligible.has(source.name) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
           digest(readFileSync(join(directory, 'host-recovery/attempt-3/sources', source.name))) !== source.sha256 ||
           (!fourth && digest(readFileSync(join(root, 'benchmarks/task-management', source.name))) !== source.sha256))
        throw Error('Third-attempt source drift: ' + source.name);
    }
  }
  if (fourth) {
    const state = read(join(directory, 'state.json'));
    const ledger = read(join(directory, 'smoke-content-review.json'));
    const third = state.slots[9];
    const thirdReview = ledger.rows[9];
    const eligible = new Set(['compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs',
      'comparison-attempts.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs', 'g4-targeted-recovery.mjs']);
    let priorAuthorization = null;
    const previousSources = [];
    let currentAuthorization = fourth;
    let previousGeneration = Infinity;
    while (currentAuthorization.previousAuthorization) {
      const previous = currentAuthorization.previousAuthorization;
      const match = previous.path?.match(/^host-recovery\/attempt-4\/history\/authorization-v([1-9][0-9]*)\.json$/);
      const generation = Number(match?.[1]);
      if (!match || generation >= previousGeneration ||
          digest(readFileSync(join(directory, previous.path))) !== previous.sha256)
        throw Error('Fourth-attempt amendment history changed');
      priorAuthorization = read(join(directory, previous.path));
      for (const field of ['schemaVersion', 'kind', 'protocolHash', 'slotId', 'predecessorId', 'maxAttempts',
        'baseCount', 'baseStateHash', 'baseReviewsHash', 'originalAuthorizationHash', 'thirdAuthorizationHash',
        'predecessorAuditHash', 'predecessorEvidence', 'userInstruction', 'reason', 'issues'])
        if (JSON.stringify(priorAuthorization[field]) !== JSON.stringify(fourth[field])) throw Error('Fourth-attempt original authorization changed');
      if (currentAuthorization.sourceDirectory !== 'sources-v' + (generation + 1) ||
          (generation === 1 ? Boolean(priorAuthorization.sourceDirectory || priorAuthorization.previousAuthorization)
            : priorAuthorization.sourceDirectory !== 'sources-v' + generation)) throw Error('Invalid amended recovery source directory');
      for (const source of priorAuthorization.sources)
        if (digest(readFileSync(join(directory, 'host-recovery/attempt-4', priorAuthorization.sourceDirectory ?? 'sources', source.name))) !== source.sha256)
          throw Error('Fourth-attempt original source archive changed');
      previousSources.push(...priorAuthorization.sources);
      previousGeneration = generation;
      currentAuthorization = priorAuthorization;
    }
    if (!fourth.previousAuthorization && fourth.sourceDirectory) throw Error('Recovery source directory requires an amendment');
    if (!extra || fourth.schemaVersion !== 1 || fourth.kind !== 'isolated-fourth-attempt' ||
        fourth.protocolHash !== manifest.protocolHash || fourth.thirdAuthorizationHash !== digest(readFileSync(extraPath)) ||
        fourth.originalAuthorizationHash !== digest(readFileSync(path)) ||
        fourth.slotId !== 'S-0-handoff-2' || fourth.predecessorId !== 'S-0-handoff-2-attempt-3' ||
        fourth.maxAttempts !== 4 || fourth.baseCount !== 10 || !fourth.userInstruction?.trim() ||
        digest(JSON.stringify(state.slots.slice(0, 10))) !== fourth.baseStateHash ||
        digest(JSON.stringify(ledger.rows.slice(0, 9))) !== fourth.baseReviewsHash ||
        third?.id !== fourth.predecessorId || third.status !== 'finished' || third.attempt !== 3 ||
        third.turn?.status !== 'failed' || !third.turn.error?.message?.includes('stream disconnected before completion') ||
        third.nativeStop?.appContainer !== true || third.nativeStop?.writersStopped !== true ||
        third.nativeStop?.activeProcesses !== 0 || third.cleanup?.passed !== true ||
        state.slots.slice(10, continuation ? 11 : undefined).some(row => row.id !== 'S-0-handoff-2-attempt-4' || row.attempt !== 4) ||
        ledger.rows.length > (continuation ? Infinity : 11) || ledger.rows.slice(9, continuation ? 11 : undefined).some((row, index) =>
          row.id !== (index === 0 ? third.id : 'S-0-handoff-2-attempt-4')) ||
        (thirdReview && (thirdReview.id !== third.id || thirdReview.verdict !== 'blocked' ||
          !thirdReview.issues?.some(issue => issue.id === fourth.issues?.[0]?.id))) ||
        !Array.isArray(fourth.sources) || fourth.sources.length !== eligible.size ||
        new Set(fourth.sources.map(source => source.name)).size !== eligible.size ||
        !Array.isArray(fourth.predecessorEvidence) || fourth.predecessorEvidence.length !== 4 ||
        !fourth.issues?.length || !fourth.reason?.trim())
      throw Error('Fourth-attempt baseline/slot authorization changed');
    const auditArchive = join(directory, 'host-recovery/attempt-4/predecessor-audit.json');
    if (!/^[a-f0-9]{64}$/.test(fourth.predecessorAuditHash ?? '') ||
        digest(readFileSync(auditArchive)) !== fourth.predecessorAuditHash ||
        !read(auditArchive).mismatches?.some(message => message === third.id + ': Final turn usage ordering/binding') ||
        !read(auditArchive).mismatches?.some(message => message === third.id + ': Workflow history: canonical publication unavailable: Final full evidence reference missing'))
      throw Error('Fourth-attempt interrupted audit evidence changed');
    const trace = readFileSync(join(third.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const completedCompaction = trace.some(event => event.message?.method === 'item/completed' &&
      event.message.params?.item?.type === 'contextCompaction');
    const failedTurn = trace.some(event => event.message?.method === 'turn/completed' &&
      event.message.params?.turn?.status === 'failed');
    if (!completedCompaction || !failedTurn) throw Error('Fourth-attempt provider interruption trace changed');
    for (const item of fourth.predecessorEvidence) {
      if (!['events.jsonl', 'source-before.json', 'source-after.json', 'result.json'].includes(item.name) ||
          digest(readFileSync(join(third.evidence, item.name))) !== item.sha256)
        throw Error('Fourth-attempt predecessor evidence changed');
    }
    if (new Set(fourth.predecessorEvidence.map(item => item.name)).size !== 4) throw Error('Fourth-attempt evidence set incomplete');
    for (const source of fourth.sources) {
      if (!eligible.has(source.name) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
          digest(readFileSync(join(directory, 'host-recovery/attempt-4', fourth.sourceDirectory ?? 'sources', source.name))) !== source.sha256 ||
          (!continuation && digest(readFileSync(join(root, 'benchmarks/task-management', source.name))) !== source.sha256))
        throw Error('Fourth-attempt source drift: ' + source.name);
    }
    const startupFailures = state.hostInfrastructureFailures ?? [];
    if (startupFailures.length || fourth.startupInfrastructureRecoveryHash) {
      if (!priorAuthorization || startupFailures.length !== 1 ||
          digest(JSON.stringify(startupFailures)) !== fourth.startupInfrastructureRecoveryHash)
        throw Error('Fourth-attempt startup infrastructure authorization changed');
      const failure = startupFailures[0];
      if (failure.kind !== 'provider-observation-schema-after-startup' || !failure.userInstruction?.trim() ||
          Object.keys(failure.hashes).sort().join(',') !== 'events.jsonl,result.json,source-after.json,source-before.json' ||
          digest(JSON.stringify(read(join(failure.record.evidence, 'result.json')))) !== digest(JSON.stringify(failure.record)))
        throw Error('Fourth-attempt startup infrastructure record changed');
      for (const [name, expected] of Object.entries(failure.hashes))
        if (digest(readFileSync(join(failure.record.evidence, name))) !== expected) throw Error('Fourth-attempt startup infrastructure evidence changed');
      validateObservationStartupInterruption(failure.record,
        readFileSync(join(failure.record.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse),
        read(join(failure.record.evidence, 'source-before.json')), read(join(failure.record.evidence, 'source-after.json')));
    }
    const prelaunchFailures = state.hostPreflightFailures ?? [];
    if (prelaunchFailures.length || fourth.prelaunchRecoveryHash) {
      if (prelaunchFailures.length !== 1 || digest(JSON.stringify(prelaunchFailures)) !== fourth.prelaunchRecoveryHash ||
          prelaunchFailures[0].record.id !== 'S-0-handoff-2-attempt-4' ||
          prelaunchFailures[0].record.status !== 'preflight_failed' || prelaunchFailures[0].record.launch ||
          prelaunchFailures[0].record.evidence || !prelaunchFailures[0].reason?.startsWith('EEXIST: file already exists, mkdir '))
        throw Error('Fourth-attempt prelaunch reservation recovery changed');
    }
    if (priorAuthorization) fourth.previousSources = previousSources;
  }
  if (continuation) {
    const state = read(join(directory, 'state.json'));
    const ledger = read(join(directory, 'smoke-content-review.json'));
    const predecessor = state.slots[10];
    const eligible = ['compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs', 'comparison-attempts.mjs',
      'comparison-evidence.mjs', 'provider-observations.mjs', 'g4-targeted-recovery.mjs'];
    if (!fourth || continuation.schemaVersion !== 1 || continuation.kind !== 'isolated-transport-continuation' ||
        continuation.protocolHash !== manifest.protocolHash || continuation.fourthAuthorizationHash !== digest(readFileSync(fourthPath)) ||
        continuation.slotId !== 'S-0-handoff-2' || continuation.predecessorId !== 'S-0-handoff-2-attempt-4' ||
        continuation.baseCount !== 11 || continuation.baseReviewCount !== 10 || continuation.maxAttempts !== 12 ||
        !continuation.userInstruction?.trim() || !continuation.reason?.trim() ||
        digest(JSON.stringify(state.slots.slice(0, 11))) !== continuation.baseStateHash ||
        digest(JSON.stringify(ledger.rows.slice(0, 10))) !== continuation.baseReviewsHash ||
        predecessor?.id !== continuation.predecessorId || predecessor.status !== 'finished' ||
        predecessor.turn?.status !== 'failed' || !predecessor.turn.error?.message?.includes('stream disconnected before completion') ||
        predecessor.nativeStop?.writersStopped !== true || predecessor.nativeStop.activeProcesses !== 0 ||
        predecessor.cleanup?.passed !== true || continuation.sources?.length !== eligible.length ||
        new Set(continuation.sources.map(source => source.name)).size !== eligible.length)
      throw Error('Transport continuation baseline/authorization changed');
    if (continuation.predecessorEvidence?.length !== 4 || new Set(continuation.predecessorEvidence.map(item => item.name)).size !== 4)
      throw Error('Transport continuation evidence set incomplete');
    for (const item of continuation.predecessorEvidence)
      if (!['events.jsonl', 'source-before.json', 'source-after.json', 'result.json'].includes(item.name) ||
          digest(readFileSync(join(predecessor.evidence, item.name))) !== item.sha256) throw Error('Transport continuation evidence changed');
    for (const source of continuation.sources)
      if (!eligible.includes(source.name) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
          digest(readFileSync(join(directory, 'host-recovery/transport-continuation/sources', source.name))) !== source.sha256 ||
          digest(readFileSync(join(root, 'benchmarks/task-management', source.name))) !== source.sha256)
        throw Error('Transport continuation source drift: ' + source.name);
    const attempts = state.slots.filter(row => (row.slotId ?? row.id) === continuation.slotId && row.attempt >= 4);
    if (attempts.some((row, index) => row.attempt !== index + 4 || row.attempt > continuation.maxAttempts ||
        row.id !== continuation.slotId + '-attempt-' + row.attempt)) throw Error('Transport continuation attempt order/cap changed');
    for (const review of ledger.rows.slice(10)) {
      const row = state.slots.find(row => row.id === review.id);
      if (!row || review.sourceManifestHash !== digest(readFileSync(join(row.evidence, 'source-after.json'))) ||
          review.assessment?.eventsHash !== digest(readFileSync(join(row.evidence, 'events.jsonl'))))
        throw Error('Transport continuation review evidence changed');
      if (review.verdict === 'blocked' && (row.turn?.status !== 'failed' ||
          !row.turn.error?.message?.includes('stream disconnected before completion') ||
          row.nativeStop?.writersStopped !== true || row.nativeStop.activeProcesses !== 0 || row.cleanup?.passed !== true))
        throw Error('Transport continuation only retries stopped provider disconnects');
    }
  }
  if (recovery.feedbackAuthorization) {
    const feedbackPath = resolve(recovery.feedbackAuthorization.path);
    if (!feedbackPath.startsWith(resolve(directory, 'host-recovery/history') + sep) ||
        digest(readFileSync(feedbackPath)) !== recovery.feedbackAuthorization.sha256)
      throw Error('Recovery feedback authorization changed');
    const original = read(feedbackPath);
    for (const field of ['protocolHash', 'baseStateHash', 'baseReviewsHash', 'slotId', 'attempt', 'reason', 'issues'])
      if (JSON.stringify(original[field]) !== JSON.stringify(recovery[field])) throw Error('Recovery feedback changed');
  }
  if (recovery.schemaVersion !== 1 || recovery.kind !== 'user-directed-targeted-recovery' ||
      recovery.protocolHash !== manifest.protocolHash || recovery.maxAttempts !== 2 ||
      recovery.preservePassedSlots !== true || !recovery.userInstruction?.trim() ||
      !manifest.smoke.some(slot => slot.id === recovery.slotId) || recovery.attempt !== 2)
    throw Error('Invalid targeted recovery authorization');
  const state = read(join(directory, 'state.json'));
  const ledger = read(join(directory, 'smoke-content-review.json'));
  if (state.protocolHash !== manifest.protocolHash || ledger.protocolHash !== manifest.protocolHash ||
      !Number.isInteger(recovery.baseCount) || recovery.baseCount < 1 ||
      digest(JSON.stringify(state.slots.slice(0, recovery.baseCount))) !== recovery.baseStateHash ||
      digest(JSON.stringify(ledger.rows.slice(0, recovery.baseCount))) !== recovery.baseReviewsHash)
    throw Error('Targeted recovery baseline changed');
  const previous = state.slots.slice(0, recovery.baseCount).at(-1);
  const review = ledger.rows.find(row => row.id === previous?.id);
  if (recovery.interruptedAttempt) {
    const proof = recovery.interruptedAttempt;
    const auditPath = join(directory, 'host-recovery/predecessor-audit.json');
    if (proof.kind !== 'compaction-timeout' || digest(readFileSync(auditPath)) !== proof.auditHash ||
        !Array.isArray(proof.evidence) || proof.evidence.length !== 4 ||
        new Set(proof.evidence.map(item => item.name)).size !== 4)
      throw Error('Compaction timeout recovery proof changed');
    for (const item of proof.evidence) {
      if (!['events.jsonl', 'result.json', 'source-before.json', 'source-after.json'].includes(item.name) ||
          digest(readFileSync(join(previous.evidence, item.name))) !== item.sha256)
        throw Error('Compaction timeout predecessor evidence changed');
    }
    const audit = read(auditPath);
    if (audit.protocolHash !== manifest.protocolHash) throw Error('Compaction timeout audit binding changed');
    validateCompactionTimeout(previous,
      readFileSync(join(previous.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse),
      audit.details.find(item => item.id === previous.id));
  }
  if (previous?.id !== recovery.slotId || previous.attempt !== 1 || previous.status !== 'finished' ||
      previous.nativeStop?.writersStopped !== true || previous.nativeStop.activeProcesses !== 0 ||
      previous.cleanup?.passed !== true || review?.verdict !== 'blocked' ||
      ledger.rows.slice(0, recovery.baseCount - 1).some(row => row.verdict !== 'pass') ||
      !Array.isArray(recovery.sources) || recovery.sources.length !== allowed.length ||
      new Set(recovery.sources.map(source => source.name)).size !== allowed.length)
    throw Error('Targeted recovery predecessor/review mismatch');
  for (const source of recovery.sources) {
    if (!allowed.includes(source.name) || !/^[a-f0-9]{64}$/.test(source.sha256)) throw Error('Invalid recovery source');
    const archived = resolve(directory, 'host-recovery/sources', source.name);
    if (!archived.startsWith(resolve(directory) + sep) || digest(readFileSync(archived)) !== source.sha256 ||
         !(extra?.sources.some(item => item.name === source.name) || fourth?.sources.some(item => item.name === source.name) || digest(readFileSync(join(root, 'benchmarks/task-management', source.name))) === source.sha256))
      throw Error('Targeted recovery source drift: ' + source.name);
  }
  const infrastructureFailures = state.infrastructureFailures ?? [];
  if (digest(JSON.stringify(infrastructureFailures)) !== (recovery.infrastructureFailuresHash ?? digest('[]')))
    throw Error('Infrastructure recovery history changed');
  for (const failure of infrastructureFailures) {
    if (failure.record.slotId !== recovery.slotId || failure.record.attempt !== recovery.attempt ||
        !failure.userInstruction?.trim()) throw Error('Invalid capacity retry authorization');
    for (const [name, expected] of Object.entries(failure.hashes)) {
      if (!['events.jsonl', 'result.json', 'source-before.json', 'source-after.json'].includes(name) ||
          digest(readFileSync(join(failure.record.evidence, name))) !== expected)
        throw Error('Capacity recovery evidence changed');
    }
    if (Object.keys(failure.hashes).length !== 4 ||
        digest(JSON.stringify(read(join(failure.record.evidence, 'result.json')))) !== digest(JSON.stringify(failure.record)))
      throw Error('Capacity recovery result changed');
    const validate = failure.kind === 'provider-capacity-before-model-work' ? validateCapacityFailure :
      failure.kind === 'provider-disconnect-after-startup' ? validateStartupInterruption : null;
    if (!validate) throw Error('Unknown infrastructure retry kind');
    validate(failure.record,
      readFileSync(join(failure.record.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse),
      read(join(failure.record.evidence, 'source-before.json')), read(join(failure.record.evidence, 'source-after.json')));
  }
  const extraRows = state.slots.slice(recovery.baseCount).filter(row => (row.slotId ?? row.id) === recovery.slotId);
  if (extraRows.length > 1 || extraRows.some(row => row.attempt !== 2 || row.continuationFrom && row.continuationFrom !== recovery.slotId))
    throw Error('Targeted recovery attempt cap/continuity mismatch');
  return { ...recovery, ...(extra ? { thirdAttempt: { ...extra, authorizationHash: digest(readFileSync(extraPath)) } } : {}),
    ...(fourth ? { fourthAttempt: { ...fourth, authorizationHash: digest(readFileSync(fourthPath)) } } : {}),
    ...(continuation ? { transportContinuation: { ...continuation, authorizationHash: digest(readFileSync(continuationPath)) } } : {}),
    authorizationPath: path, authorizationHash: digest(readFileSync(path)) };
}

export function recoverySourceHash(name, frozenHash, recovery) {
  return recovery?.compactionRecovery?.sources.find(source => source.name === name)?.sha256 ??
    recovery?.transportContinuation?.sources.find(source => source.name === name)?.sha256 ??
    recovery?.fourthAttempt?.sources.find(source => source.name === name)?.sha256 ??
    recovery?.thirdAttempt?.sources.find(source => source.name === name)?.sha256 ??
    recovery?.sources.find(source => source.name === name)?.sha256 ?? frozenHash;
}

export const recoveryAttemptLimits = (maxAttempts, recovery) => recovery?.compactionRecovery
  ? recovery.attemptLimits
  : recovery?.attemptLimits && !recovery?.transportContinuation && !recovery?.fourthAttempt
  ? recovery.attemptLimits
  : recovery?.transportContinuation
  ? { default: maxAttempts, [recovery.transportContinuation.slotId]: recovery.transportContinuation.maxAttempts }
  : recovery?.fourthAttempt
  ? { default: maxAttempts, [recovery.fourthAttempt.slotId]: recovery.fourthAttempt.maxAttempts }
  : recovery?.thirdAttempt ? { default: maxAttempts, [recovery.thirdAttempt.slotId]: recovery.thirdAttempt.maxAttempts } : maxAttempts;

export function recoveryReviews(rows, recovery) {
  if (!recovery) return rows;
  return rows.map(row => row.id === recovery.formalDisconnectRecovery?.b5SmallAttempt2Recovery?.predecessorId && row.verdict === 'rework' ? {
    ...row, hostInfrastructureIssues: true,
    reason: recovery.formalDisconnectRecovery.b5SmallAttempt2Recovery.feedbackReason,
    recoveryAuthorizationHash: recovery.formalDisconnectRecovery.b5SmallAttempt2Recovery.authorizationHash,
  } : row.id === recovery.formalDisconnectRecovery?.b2Handoff2Cap3Recovery?.predecessorId && row.verdict === 'rework' ? {
    ...row, reason: recovery.formalDisconnectRecovery.b2Handoff2Cap3Recovery.feedbackReason,
    recoveryAuthorizationHash: recovery.formalDisconnectRecovery.b2Handoff2Cap3Recovery.authorizationHash,
  } : recovery.formalDisconnectRecovery?.entries?.[row.id] && row.verdict === 'blocked' ? {
    ...row, verdict: 'rework', hostInfrastructureIssues: true,
    ...(recovery.formalDisconnectRecovery.entries[row.id].feedbackIssues ? { issues: recovery.formalDisconnectRecovery.entries[row.id].feedbackIssues } : {}),
    reason: recovery.formalDisconnectRecovery.entries[row.id].feedbackReason ?? 'G6-B1-DEBUG1-TRANSPORT-001 and G6-B1-DEBUG1-CANONICAL-001: host found disconnected final turn and missing canonical publication/verifier. Record both host finding IDs in RESULT and canonical summary (not as invented failed shell commands). Preserve original failed turn and host issue IDs; retain same source/task and produce fresh acceptance, RESULT, checkpoint, canonical full evidence and verifier PASS without compaction. Attempt 2/2 only.',
    recoveryAuthorizationHash: recovery.formalDisconnectRecovery.entries[row.id].authorizationHash,
  } : row.id === recovery.cancelledRecovery?.predecessorId && row.verdict === 'blocked' ? {
    ...row, verdict: 'rework', reason: recovery.cancelledRecovery.reason, issues: recovery.cancelledRecovery.issues,
    hostInfrastructureIssues: true, recoveryAuthorizationHash: recovery.cancelledRecovery.authorizationHash,
  } : recovery.transportContinuation && row.verdict === 'blocked' &&
    /^S-0-handoff-2-attempt-(?:[4-9]|1[01])$/.test(row.id) ? {
    ...row, verdict: 'rework', reason: recovery.transportContinuation.reason,
    hostInfrastructureIssues: true, recoveryAuthorizationHash: recovery.transportContinuation.authorizationHash,
  } : row.id === recovery.fourthAttempt?.predecessorId && row.verdict === 'blocked' ? {
    ...row, verdict: 'rework', reason: recovery.fourthAttempt.reason, issues: recovery.fourthAttempt.issues,
    hostInfrastructureIssues: true,
    recoveryAuthorizationHash: recovery.fourthAttempt.authorizationHash,
  } : row.id === recovery.thirdAttempt?.predecessorId && row.verdict === 'blocked' ? {
    ...row, verdict: 'rework', reason: recovery.thirdAttempt.reason, issues: recovery.thirdAttempt.issues,
    recoveryAuthorizationHash: recovery.thirdAttempt.authorizationHash,
  } : row.id === recovery.slotId && row.verdict === 'blocked' ? {
    ...row, verdict: 'rework', reason: recovery.reason, issues: recovery.issues ?? row.issues,
    ...(recovery.interruptedAttempt ? { hostInfrastructureIssues: true } : {}),
    recoveryAuthorizationHash: recovery.feedbackAuthorization?.sha256 ?? recovery.authorizationHash,
  } : row);
}

export function recoveredSessionIds(state, row) {
  return [...(state.infrastructureFailures ?? []), ...(state.hostInfrastructureFailures ?? [])].filter(failure =>
    ['provider-disconnect-after-startup', 'provider-observation-schema-after-startup'].includes(failure.kind) &&
    failure.record.workspace === row.workspace && failure.record.binding?.taskId === row.binding?.taskId &&
    Date.parse(failure.record.startedAt) < Date.parse(row.startedAt)).map(failure => failure.record.binding.sessionId);
}

export function applyRecoveryRuntime(workspace, directory, manifest, branch, recovery) {
  if (!recovery) return null;
  const updates = [];
  for (const name of ['comparison-evidence.mjs', ...(recovery.fourthAttempt ? ['provider-observations.mjs'] : [])]) {
    const source = recovery.transportContinuation?.sources.find(item => item.name === name) ??
      recovery.fourthAttempt?.sources.find(item => item.name === name) ??
      recovery.thirdAttempt?.sources.find(item => item.name === name) ?? recovery.sources.find(item => item.name === name);
    const path = join(workspace, '.bridge-runtime/evidence', name);
    const before = digest(readFileSync(path));
    const original = manifest.frozen[`${branch === 'B' ? 'baseline-runtime' : 'bridge-runtime'}/evidence/${name}`];
    const accepted = [original, source.sha256, recovery.sources.find(item => item.name === name)?.sha256,
      recovery.thirdAttempt?.sources.find(item => item.name === name)?.sha256,
      recovery.fourthAttempt?.sources.find(item => item.name === name)?.sha256,
      ...(recovery.fourthAttempt?.previousSources?.filter(item => item.name === name).map(item => item.sha256) ?? [])];
    if (!accepted.includes(before)) throw Error('Unexpected runtime source before recovery');
    const archive = recovery.transportContinuation ? join('host-recovery/transport-continuation/sources', name)
      : recovery.fourthAttempt ? join('host-recovery/attempt-4', recovery.fourthAttempt.sourceDirectory ?? 'sources', name)
      : recovery.thirdAttempt ? join('host-recovery/attempt-3/sources', name) : join('host-recovery/sources', name);
    if (before !== source.sha256) copyFileSync(join(directory, archive), path);
    if (digest(readFileSync(path)) !== source.sha256) throw Error('Recovery runtime update failed');
    updates.push({ path, before, after: source.sha256 });
  }
  return { authorizationHash: recovery.transportContinuation?.authorizationHash ?? recovery.fourthAttempt?.authorizationHash ?? recovery.authorizationHash, ...updates[0], updates };
}

export function writeRecoveryScope(input, workspace, sid, readOnlyExecutables, root, readDirectory = readdirSync) {
  root = resolve(root); workspace = resolve(workspace); input = resolve(input);
  const inside = path => resolve(path).startsWith(root + sep);
  if (!inside(workspace) || !inside(input) || readOnlyExecutables.some(path => !inside(path)) ||
      !/^S-1-15-2-(\d+-){6}\d+$/.test(sid)) throw Error('Invalid recovery scope paths/identity');
  const fd = openSync(input, 'wx'), streamInput = input + 'l', lines = openSync(streamInput, 'wx'), links = [];
  let buffer = '', count = 0, retriedDirectories = 0;
  const flush = () => { if (buffer) { writeSync(fd, buffer); buffer = ''; } };
  const emit = text => { buffer += text; if (buffer.length > 65536) flush(); };
  const entry = (path, directory) => { const text = JSON.stringify({ path, directory }); emit((count++ ? ',' : '') + text); writeSync(lines, text + '\n'); };
  const walk = path => {
    if (path === workspace) return;
    entry(path, true);
    let entries;
    try { entries = readDirectory(path, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'UNKNOWN') throw error;
      retriedDirectories++;
      entries = readDirectory(toNamespacedPath(path), { withFileTypes: true });
    }
    for (const item of entries) {
      const file = join(path, item.name);
      if (file === workspace) continue;
      if (item.isSymbolicLink()) links.push(file);
      else if (item.isDirectory()) walk(file);
      else if (item.isFile()) entry(file, false);
    }
  };
  try {
    writeSync(lines, JSON.stringify({ kind: 'scope-header', sid, readOnlyExecutables: [...new Set(readOnlyExecutables)] }) + '\n');
    emit('{"root":' + JSON.stringify(root) + ',"workspace":' + JSON.stringify(workspace) + ',"entries":[');
    walk(root);
    emit('],"links":' + JSON.stringify(links) + ',"readOnlyExecutables":' + JSON.stringify([...new Set(readOnlyExecutables)]) + ',"sid":' + JSON.stringify(sid) + '}');
    flush();
    writeSync(lines, JSON.stringify({ kind: 'scope-end', entries: count, links }) + '\n');
  } finally { closeSync(fd); closeSync(lines); }
  return { entries: count, links: links.length, retriedDirectories, streamInput };
}
