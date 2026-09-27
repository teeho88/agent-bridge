import { normalizeBoardSnapshot } from './normalize.js';
import type {
  NormalizedBoardSnapshot,
  OfficeZone,
  PixelActivityState,
  PixelActorState,
  PixelOfficeSceneState,
  WorkflowActivity,
} from './types.js';

const ACTIVE_RUN_STATUSES = new Set(['starting', 'running', 'waiting', 'stopping']);

function stableNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isRework(run: Record<string, any>, subtask?: Record<string, any>): boolean {
  const evidence = [run.planKey, run.planTitle, subtask?.title, subtask?.goal]
    .filter(Boolean).join(' ').toLowerCase();
  return /(^|[-_\s])rework([\s_-]|$)/.test(evidence) || Number(run.cycle || 0) > 0;
}

function runActivity(run: Record<string, any>, subtask?: Record<string, any>): WorkflowActivity {
  if (run.status === 'failed') return 'failed';
  if (run.status === 'stopping' || run.status === 'stopped') return 'stopping';
  if (run.status === 'done') return 'done';
  if (run.phase === 'plan') return 'planning';
  if (run.phase === 'review') return 'reviewing';
  if (run.phase === 'adjudicate') return 'adjudicating';
  if (run.phase === 'report') return 'reporting';
  if (run.phase === 'implement') return isRework(run, subtask) ? 'reworking' : 'implementing';
  return 'idle';
}

function zoneFor(activity: WorkflowActivity, run: Record<string, any>): OfficeZone {
  if (run.origin === 'adopted' || run.origin === 'manual' || run.status === 'detached') return 'entrance';
  if (activity === 'planning') return 'leader';
  if (activity === 'reviewing') return 'review';
  if (activity === 'adjudicating') return 'decision';
  if (activity === 'reporting' || activity === 'done') return 'report';
  if (activity === 'idle') return 'dispatch';
  return 'implement';
}

function poseFor(run: Record<string, any>, activity: WorkflowActivity): string {
  if (run.status === 'waiting') return 'wait';
  if (activity === 'failed') return 'error';
  if (activity === 'stopping') return 'stop';
  if (activity === 'reviewing') return 'inspect';
  if (activity === 'planning') return 'think';
  if (activity === 'reporting') return 'read';
  if (activity === 'done') return 'celebrate';
  return activity === 'implementing' || activity === 'reworking' ? 'type' : 'idle';
}

function latestReviewFor(reviews: Array<Record<string, any>>, subtaskId?: string): Record<string, any> | undefined {
  if (!subtaskId) return undefined;
  return reviews
    .filter(review => review.subtaskId === subtaskId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
}

function dominantActivity(snapshot: NormalizedBoardSnapshot, actors: PixelActorState[]): WorkflowActivity {
  if (!snapshot.orchestration) return 'idle';
  if (snapshot.orchestration.status === 'failed') return 'failed';
  if (snapshot.questions.length) return 'waiting_user';
  if (snapshot.approvals.length) return 'waiting_approval';
  const priorities: WorkflowActivity[] = [
    'stopping', 'adjudicating', 'reworking', 'reviewing', 'implementing', 'reporting', 'planning', 'done'
  ];
  for (const activity of priorities) if (actors.some(actor => actor.activity === activity)) return activity;
  if (snapshot.orchestration.status === 'paused') return 'idle';
  return snapshot.orchestration.status as WorkflowActivity;
}

export function deriveOfficeState(payload: any): PixelOfficeSceneState {
  const snapshot = normalizeBoardSnapshot(payload);
  if (!snapshot.orchestration) {
    return { orchestrationId: null, globalStatus: 'idle', dominantActivity: 'idle', leader: null, actors: [], activities: [], notifications: [], verdicts: [] };
  }
  const agents = new Map(snapshot.registeredAgents.map(agent => [agent.id, agent]));
  const subtasks = new Map(snapshot.subtasks.map(subtask => [subtask.id, subtask]));
  const activeByAgent = new Map<string, number>();
  snapshot.runs.filter(run => ACTIVE_RUN_STATUSES.has(run.status)).forEach(run => {
    activeByAgent.set(run.agentId, (activeByAgent.get(run.agentId) || 0) + 1);
  });
  const actors = snapshot.runs.map(run => {
    const agent = agents.get(run.agentId) || {};
    const subtask = subtasks.get(run.subtaskId);
    const activity = runActivity(run, subtask);
    const review = latestReviewFor(snapshot.reviews, run.subtaskId);
    const actorId = (activeByAgent.get(run.agentId) || 0) > 1 ? `${run.agentId}:${run.id}` : String(run.agentId || run.id);
    return {
      id: actorId,
      agentId: String(run.agentId || run.id),
      name: String(agent.name || run.agentId || 'agent'),
      role: String(run.phase || run.roleId || 'worker'),
      model: [run.provider || agent.provider, run.model || agent.model].filter(Boolean).join(' · '),
      activity,
      pose: poseFor(run, activity),
      zone: zoneFor(activity, run),
      deskId: `desk-${stableNumber(String(run.agentId || run.id)) % 12}`,
      runId: run.id,
      taskLabel: [run.planKey, run.planTitle || subtask?.title].filter(Boolean).join(': '),
      progressPercent: run.progressPercent,
      progressNote: run.progressNote,
      status: run.status,
      origin: run.origin,
      reworkCycle: isRework(run, subtask) ? Number(run.cycle || snapshot.orchestration.cycle || 1) : undefined,
      verdict: review?.verdict,
      run,
    } as PixelActorState;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const leaderActivity: WorkflowActivity = snapshot.questions.length
    ? 'waiting_user'
    : snapshot.approvals.length
      ? 'waiting_approval'
      : snapshot.orchestration.status === 'adjudicating'
        ? 'adjudicating'
        : snapshot.orchestration.status === 'reporting'
          ? 'reporting'
          : snapshot.orchestration.status === 'planning'
            ? 'planning'
            : snapshot.orchestration.status === 'failed'
              ? 'failed'
              : snapshot.orchestration.status === 'done' ? 'done' : 'dispatching';
  const leaderZone: OfficeZone = leaderActivity === 'waiting_user' || leaderActivity === 'waiting_approval'
    ? 'gate'
    : leaderActivity === 'adjudicating' ? 'decision' : leaderActivity === 'reporting' || leaderActivity === 'done' ? 'report' : 'leader';
  const leaderAgent = snapshot.leaderAgent || { id: snapshot.orchestration.leaderAgentId, name: 'Leader' };
  const leader: PixelActorState = {
    id: `leader:${leaderAgent.id}`,
    agentId: String(leaderAgent.id),
    name: String(leaderAgent.name || 'Leader'),
    role: 'leader',
    model: [leaderAgent.provider, leaderAgent.model].filter(Boolean).join(' · '),
    activity: leaderActivity,
    pose: leaderActivity === 'planning' ? 'think' : leaderActivity === 'failed' ? 'error' : leaderActivity === 'done' ? 'celebrate' : 'talk',
    zone: leaderZone,
    status: snapshot.orchestration.status,
  };
  const queued = snapshot.subtasks.filter(subtask => subtask.status === 'todo' || subtask.status === 'assigned');
  const activities: PixelActivityState[] = [leader, ...actors].map(actor => ({ key: actor.id, actorId: actor.id, activity: actor.activity, label: `${actor.name}: ${actor.activity}` }));
  if (queued.length) activities.push({ key: 'dispatch-queue', activity: 'dispatching', label: `${queued.length} task(s) waiting for dispatch` });
  return {
    orchestrationId: String(snapshot.orchestration.id),
    globalStatus: snapshot.orchestration.status,
    dominantActivity: dominantActivity(snapshot, actors),
    leader,
    actors,
    activities,
    notifications: [
      ...(snapshot.approvals.length ? [{ kind: 'approval', label: 'Approval required', count: snapshot.approvals.length }] : []),
      ...(snapshot.questions.length ? [{ kind: 'question', label: 'Leader question', count: snapshot.questions.length }] : []),
      ...(queued.length ? [{ kind: 'dispatch', label: 'Dispatch queue', count: queued.length }] : []),
    ],
    verdicts: snapshot.reviews.map(review => ({ id: String(review.id), subtaskId: review.subtaskId, verdict: String(review.verdict) })),
  };
}
