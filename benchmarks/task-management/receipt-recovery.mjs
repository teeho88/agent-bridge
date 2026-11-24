import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateWorkflowChain, validateCommandCaptures } from './comparison-evidence.mjs';
import { loadTransportRecovery } from './transport-recovery.mjs';
import { loadCancelledRecovery } from './cancelled-recovery.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sources = ['capacity-recovery.mjs', 'campaign-admission.mjs', 'comparison-attempts.mjs', 'compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs', 'compare-report.mjs', 'comparison-evidence.mjs', 'receipt-recovery.mjs'];
export function loadReceiptRecovery(directory, manifest, root) {
  const folder = join(directory, 'receipt-recovery'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const transportRecovery = loadTransportRecovery(directory, manifest, root, {
    authorizeSourceCorrection: existsSync(join(directory, 'cancelled-recovery/authorization.json')) });
  const cancelledRecovery = loadCancelledRecovery(directory, manifest, root, transportRecovery);
  const effectiveSources = cancelledRecovery?.sources ?? transportRecovery?.sources;
  const auth = read(file), state = read(join(directory, 'state.json'));
  if (auth.schemaVersion !== 1 || auth.kind !== 'inline-receipt-parser-correction-v1' || !auth.userInstruction?.trim() ||
      auth.protocolHash !== manifest.protocolHash || state.protocolHash !== manifest.protocolHash ||
      auth.baseAuthorizationHash !== sha(join(directory, 'capacity-recovery/attempt-3/authorization.json')) ||
      auth.sources?.length !== sources.length || new Set(auth.sources.map(x => x.name)).size !== sources.length ||
      !auth.sources.every(x => sources.includes(x.name)) || digest(state.slots.slice(0, auth.baseCount)) !== auth.baseSlotsHash ||
      digest(read(join(folder, 'predecessor-state.json')).slots) !== auth.baseSlotsHash) throw Error('Receipt correction authorization changed');
  for (const source of auth.sources) if (sha(join(folder, 'sources', source.name)) !== source.sha256 ||
      !existsSync(join(directory, 'compaction-recovery/authorization.json')) && sha(join(root, 'benchmarks/task-management', source.name)) !==
        (effectiveSources?.find(x => x.name === source.name)?.sha256 ?? source.sha256)) throw Error('Receipt correction source changed');
  const row = state.slots.find(x => x.id === auth.targetId);
  if (!row || row.attempt !== 3 || row.status !== 'finished' || row.turn?.status !== 'completed' ||
      row.acceptance?.passed !== true || digest(row) !== auth.targetHash) throw Error('Receipt correction target changed');
  for (const proof of auth.evidence) if (sha(join(row.evidence, proof.name)) !== proof.sha256) throw Error('Receipt correction evidence changed');
  if (sha(join(folder, 'previous-review-ledger.json')) !== auth.originalLedgerHash ||
      digest(read(join(folder, 'previous-review-ledger.json')).rows.find(x => x.id === row.id)) !== auth.originalReviewHash)
    throw Error('Previous blocked review archive changed');
  validateWorkflowChain(state.slots, row, { requireFinalPass: true });
  return { ...auth, sources: effectiveSources ?? auth.sources, transportRecovery, cancelledRecovery,
    authorizationHash: sha(file), archive: join(folder, 'previous-review-ledger.json') };
}
export async function authorizeReceiptRecovery(pointerPath, userInstruction, root) {
  const pointer = read(pointerPath), manifest = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
  const { loadCapacityRecovery } = await import('./capacity-recovery.mjs');
  const recovery = loadCapacityRecovery(pointer.directory, manifest, root, { authorizeReceipt: true });
  const row = state.slots.at(-1), ledgerPath = join(pointer.directory, 'smoke-content-review.json'), ledger = read(ledgerPath);
  const review = ledger.rows.find(x => x.id === row.id), folder = join(pointer.directory, 'receipt-recovery');
  if (!userInstruction?.trim() || !recovery?.thirdAttempt || row.attempt !== 3 || row.status !== 'finished' ||
      row.turn?.status !== 'completed' || row.acceptance?.passed !== true || review?.verdict !== 'blocked' ||
      review.assessment?.eventsHash !== sha(join(row.evidence, 'events.jsonl'))) throw Error('Receipt correction requires an immutable completed attempt and blocked raw-bound review');
  const audit = read(join(pointer.directory, 'smoke-audit.partial.json'));
  const problems = audit.details.find(x => x.id === row.id)?.problems;
  if (problems?.length !== 1 || problems[0] !== 'Workflow history: G4-first-task-extra-session: invalid invocation task/session lifecycle')
    throw Error('Receipt correction cannot mask other audit defects');
  const commands = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse).map(x => x.message)
    .filter(x => x.method === 'item/completed' && x.params.item.type === 'commandExecution').map(x => x.params.item);
  const captures = validateCommandCaptures(row.evidence, commands).captured;
  if (![row.lifecycleCommand.path.split('/').at(-1).replace('.json', ''), row.lifecycleCommand.context.path.split('/').at(-1).replace('.json', '')].every(id => captures.some(x => x.id === id)))
    throw Error('Both original startup captures must be bound by raw receipt bytes');
  validateWorkflowChain(state.slots, row, { requireFinalPass: true });
  if (existsSync(folder)) throw Error('Receipt correction already exists; never overwrite history');
  mkdirSync(join(folder, 'sources'), { recursive: true });
  copyFileSync(join(pointer.directory, 'state.json'), join(folder, 'predecessor-state.json'));
  copyFileSync(ledgerPath, join(folder, 'previous-review-ledger.json'));
  copyFileSync(join(pointer.directory, 'smoke-audit.partial.json'), join(folder, 'previous-audit.json'));
  const amendmentSources = sources.map(name => { copyFileSync(join(root, 'benchmarks/task-management', name), join(folder, 'sources', name)); return { name, sha256: sha(join(folder, 'sources', name)) }; });
  const auth = { schemaVersion: 1, kind: 'inline-receipt-parser-correction-v1', userInstruction, authorizedAt: new Date().toISOString(),
    protocolHash: pointer.protocolHash, baseAuthorizationHash: sha(join(pointer.directory, 'capacity-recovery/attempt-3/authorization.json')),
    targetId: row.id, targetHash: digest(row), baseCount: state.slots.length, baseSlotsHash: digest(state.slots), sources: amendmentSources,
    originalLedgerHash: sha(join(folder, 'previous-review-ledger.json')), originalReviewHash: digest(review),
    evidence: ['events.jsonl', 'result.json', 'source-before.json', 'source-after.json', 'RESULT.md'].map(name => ({ name, sha256: sha(join(row.evidence, name)) })) };
  writeFileSync(join(folder, 'authorization.json'), JSON.stringify(auth, null, 2) + '\n', { flag: 'wx' });
  return loadReceiptRecovery(pointer.directory, manifest, root);
}
