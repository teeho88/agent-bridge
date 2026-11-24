import { nextInvocation } from './comparison-attempts.mjs';

export const campaignRecoveryPolicy = Object.freeze({
  version: 1,
  maxProviderLaunchesPerSlot: 2,
  minimumFreePhysicalBytes: 1073741824,
  minimumFreeCommitBytes: 2147483648,
  minimumFreeDiskBytes: 8589934592,
});

export function assessCampaignResources(resources, policy = campaignRecoveryPolicy) {
  const failures = [];
  for (const [field, minimum] of [
    ['freePhysicalBytes', policy.minimumFreePhysicalBytes],
    ['freeCommitBytes', policy.minimumFreeCommitBytes],
    ['freeDiskBytes', policy.minimumFreeDiskBytes],
  ]) {
    if (!Number.isSafeInteger(minimum) || minimum <= 0) throw Error('Invalid resource policy: ' + field);
    if (!Number.isSafeInteger(resources?.[field]) || resources[field] < minimum) failures.push(field);
  }
  return { passed: failures.length === 0, failures };
}

export function campaignResumeAction(manifest, state, reviews, phase, capacityRecovery = null) {
  if (!['smoke', 'formal'].includes(phase) || !manifest.protocolHash || state.protocolHash !== manifest.protocolHash || reviews.protocolHash !== manifest.protocolHash)
    throw Error('Campaign resume binding mismatch');
  if (manifest.maxAttempts !== 2 || manifest.recoveryPolicy?.maxProviderLaunchesPerSlot !== 2)
    throw Error('Campaign recovery cap mismatch');
  for (const row of state.slots) {
    if (capacityRecovery?.predecessorIds?.includes(row.id) && row.status === 'terminal_infrastructure_failed') continue;
    if (capacityRecovery?.interruptedRecovery?.predecessorId === row.id && row.status === 'terminal_infrastructure_failed') continue;
    if (capacityRecovery?.cancelledRecovery?.predecessorId === row.id && row.status === 'finished') continue;
    if (row.status === 'terminal_infrastructure_failed' && (capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]?.capacityFailure || capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]?.startupFailure || capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]?.hostInterruptedFailure)) continue;
    if (!['finished', 'preflight_failed'].includes(row.status))
      return { action: 'stop', id: row.id, reason: 'Unresolved or terminal invocation; no replay' };
    if (!row.launch) continue;
    if (capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]) continue;
    const stop = row.nativeStop ?? row.acceptance?.nativeStop;
    if (stop?.appContainer !== true || stop.writersStopped !== true || stop.activeProcesses !== 0 || row.cleanup?.passed !== true)
      return { action: 'stop', id: row.id, reason: 'Native stop or cleanup unverified' };
    if (!['inputTokens', 'cachedInputTokens', 'outputTokens'].every(key => Number.isSafeInteger(row.usage?.[key]) && row.usage[key] >= 0) ||
        row.usage.cachedInputTokens > row.usage.inputTokens || !row.launch.turnId || row.turn?.id !== row.launch.turnId || row.turn?.status !== 'completed')
      return { action: 'stop', id: row.id, reason: 'Final turn binding or mandatory usage missing; measurement incomplete' };
  }
  return nextInvocation(phase === 'smoke' ? manifest.smoke : manifest.schedule,
    state.slots.filter(row => row.phase === phase), reviews.rows.map(row => capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id] && row.verdict === 'blocked' ? { ...row, verdict: 'rework' } : row), capacityRecovery?.attemptLimits ?? manifest.maxAttempts, capacityRecovery);
}
