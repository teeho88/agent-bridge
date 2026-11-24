import { nextInvocation } from './comparison-attempts.mjs';

export function validateRollover(prior, state, manifest, reviews, ledgerHashes, receipt = () => null) {
  if ([state, manifest].some(value => value.protocolHash !== prior.protocolHash)) throw new Error('Prior round binding mismatch');
  for (const row of state.slots) {
    const terminal = row.status === 'terminal_infrastructure_failed' && state.status === 'infrastructure_failed' &&
      row.terminal?.classification === 'infrastructure_failed' && row.terminal.nativeStopVerified === true &&
      row.measurementEligible === false && row.cleanup?.passed === true;
    if (!['finished', 'preflight_failed'].includes(row.status) && !terminal) throw new Error('Unresolved invocation');
    if (row.launch) {
      const stop = row.nativeStop ?? receipt(row);
      if (stop?.runId !== row.launch.runId || stop.appContainer !== true || stop.writersStopped !== true || stop.activeProcesses !== 0) throw new Error('Prior model writers unresolved');
    }
  }
  if (state.status === 'infrastructure_failed') return;
  for (const phase of ['formal', 'smoke']) {
    const { review, ledger } = reviews[phase] ?? {};
    if (!review || !ledger || review.verdict === 'pass') continue;
    if ([review, ledger].some(value => value.protocolHash !== prior.protocolHash) || review.reviewLedgerHash !== ledgerHashes[phase]) throw new Error('Prior review binding mismatch');
    const rows = state.slots.filter(row => row.phase === phase);
    const plan = nextInvocation(phase === 'formal' ? manifest.schedule : manifest.smoke, rows, ledger.rows, manifest.maxAttempts);
    if (state.status === 'quality_failed' && review.verdict === 'blocked' && plan.action === 'blocked' && plan.reason?.trim() && review.reason === plan.reason) return;
  }
  throw new Error('Terminal reviewed quality failure required');
}
