import type { CanonicalOrchestrationStatus, NormalizedBoardSnapshot } from './types.js';

const CANONICAL_STATUSES = new Set([
  'planning', 'executing', 'adjudicating', 'reporting', 'paused', 'done', 'failed'
]);

export function normalizeOfficeOrchestrationStatus(status: unknown): CanonicalOrchestrationStatus {
  if (status === 'reviewing' || status === 'reworking') return 'executing';
  return CANONICAL_STATUSES.has(String(status))
    ? status as CanonicalOrchestrationStatus
    : 'failed';
}

function array(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

export function normalizeBoardSnapshot(payload: any): NormalizedBoardSnapshot {
  const orchestration = payload?.orchestration && typeof payload.orchestration === 'object'
    ? { ...payload.orchestration, status: normalizeOfficeOrchestrationStatus(payload.orchestration.status) }
    : null;
  return {
    orchestration,
    runs: array(payload?.runs),
    subtasks: array(payload?.subtasks),
    reviews: array(payload?.reviews),
    approvals: array(payload?.approvals),
    questions: array(payload?.questions),
    events: array(payload?.events),
    registeredAgents: array(payload?.registeredAgents),
    leaderAgent: payload?.leaderAgent && typeof payload.leaderAgent === 'object' ? payload.leaderAgent : null,
  };
}
