import type { PixelOfficeSceneState, PixelTransition } from './types.js';

export const MAX_QUEUED_TRANSITIONS = 20;

export function diffOfficeState(previous: PixelOfficeSceneState | null, current: PixelOfficeSceneState): PixelTransition[] {
  if (!previous || previous.orchestrationId !== current.orchestrationId) return [];
  const transitions: PixelTransition[] = [];
  const previousActors = new Map(previous.actors.map(actor => [actor.id, actor]));
  for (const actor of current.actors) {
    const before = previousActors.get(actor.id);
    if (!before) {
      const type = actor.activity === 'reviewing'
        ? 'REVIEW_HANDOFF'
        : actor.activity === 'reworking'
          ? 'REWORK_RETURN'
          : actor.activity === 'reporting'
            ? 'REPORTING'
            : actor.origin === 'adopted' || actor.origin === 'manual' ? 'EXTERNAL_ARRIVAL' : 'DISPATCH';
      transitions.push({ key: `run:${actor.runId}:started`, type, actorId: actor.id, critical: actor.activity === 'reworking', label: `${actor.name} received ${actor.taskLabel || 'a task'}` });
    } else if (before.activity !== actor.activity || before.status !== actor.status) {
      const critical = actor.activity === 'failed' || actor.activity === 'done' || actor.activity === 'reworking';
      const type = actor.activity === 'reviewing' ? 'REVIEW_HANDOFF' : actor.activity === 'reworking' ? 'REWORK_RETURN' : actor.activity.toUpperCase();
      transitions.push({ key: `run:${actor.runId}:${actor.activity}:${actor.status}`, type, actorId: actor.id, critical, label: `${actor.name}: ${before.activity} → ${actor.activity}` });
    }
  }
  const previousVerdicts = new Map(previous.verdicts.map(verdict => [verdict.id, verdict]));
  for (const verdict of current.verdicts) {
    if (!previousVerdicts.has(verdict.id)) transitions.push({
      key: `review:${verdict.id}:${verdict.verdict}`,
      type: `VERDICT_${verdict.verdict.toUpperCase()}`,
      critical: true,
      label: `Review verdict: ${verdict.verdict}`,
    });
  }
  if (previous.globalStatus !== current.globalStatus) transitions.push({
    key: `orchestration:${current.orchestrationId}:${current.globalStatus}`,
    type: `STATUS_${current.globalStatus.toUpperCase()}`,
    critical: current.globalStatus === 'failed' || current.globalStatus === 'done',
    label: `Orchestration: ${previous.globalStatus} → ${current.globalStatus}`,
  });
  if (transitions.length <= MAX_QUEUED_TRANSITIONS) return transitions;
  const critical = transitions.filter(transition => transition.critical);
  const cosmetic = transitions.filter(transition => !transition.critical);
  return [...critical, ...cosmetic].slice(0, MAX_QUEUED_TRANSITIONS);
}
