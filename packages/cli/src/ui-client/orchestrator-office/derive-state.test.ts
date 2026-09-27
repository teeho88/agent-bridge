import { describe, expect, it } from 'vitest';
import { deriveOfficeState } from './derive-state.js';
import { normalizeBoardSnapshot, normalizeOfficeOrchestrationStatus } from './normalize.js';
import { diffOfficeState, MAX_QUEUED_TRANSITIONS } from './transitions.js';

function board(overrides: Record<string, any> = {}): any {
  return {
    orchestration: { id: 'orch-1', taskId: 'task-1', leaderAgentId: 'leader-1', status: 'executing', cycle: 0, ...overrides.orchestration },
    leaderAgent: { id: 'leader-1', name: 'Ada', provider: 'codex', model: 'gpt-5' },
    registeredAgents: [
      { id: 'worker-1', name: 'Lin', provider: 'codex', model: 'gpt-5' },
      { id: 'reviewer-1', name: 'Rae', provider: 'claude', model: 'opus' },
      { id: 'worker-2', name: 'Mo', provider: 'codex', model: 'gpt-5' },
    ],
    runs: [],
    subtasks: [],
    reviews: [],
    approvals: [],
    questions: [],
    events: [],
    ...overrides,
  };
}

describe('Pixel Office state', () => {
  it('renders an idle office without an orchestration', () => {
    expect(deriveOfficeState({ orchestration: null })).toMatchObject({
      orchestrationId: null,
      globalStatus: 'idle',
      dominantActivity: 'idle',
      actors: [],
    });
  });

  it('normalizes legacy global review and rework statuses to executing', () => {
    expect(normalizeOfficeOrchestrationStatus('reviewing')).toBe('executing');
    expect(normalizeOfficeOrchestrationStatus('reworking')).toBe('executing');
    expect(normalizeBoardSnapshot(board({ orchestration: { status: 'reviewing' } })).orchestration?.status).toBe('executing');
  });

  it('derives concurrent implementing, reviewing, and reworking activities', () => {
    const state = deriveOfficeState(board({
      runs: [
        { id: 'run-1', agentId: 'worker-1', subtaskId: 'sub-1', phase: 'implement', status: 'running', planKey: 's1' },
        { id: 'run-2', agentId: 'reviewer-1', subtaskId: 'sub-2', phase: 'review', status: 'running', planKey: 'r1' },
        { id: 'run-3', agentId: 'worker-2', subtaskId: 'sub-3', phase: 'implement', status: 'running', planKey: 's3-rework-1', cycle: 1 },
      ],
      subtasks: [
        { id: 'sub-1', title: 'Build parser', status: 'in_progress' },
        { id: 'sub-2', title: 'Review parser', status: 'review' },
        { id: 'sub-3', title: 'Rework parser', status: 'in_progress' },
      ],
    }));
    expect(state.globalStatus).toBe('executing');
    expect(state.actors.map(actor => actor.activity)).toEqual(['reviewing', 'implementing', 'reworking']);
    expect(state.actors.find(actor => actor.activity === 'reworking')?.reworkCycle).toBe(1);
  });

  it.each([
    ['planning', 'planning'],
    ['adjudicating', 'adjudicating'],
    ['reporting', 'reporting'],
    ['failed', 'failed'],
    ['done', 'done'],
  ])('maps %s lifecycle to leader activity %s', (status, activity) => {
    const state = deriveOfficeState(board({ orchestration: { status } }));
    expect(state.leader?.activity).toBe(activity);
  });

  it('prioritizes user gates and preserves text notifications', () => {
    const questionState = deriveOfficeState(board({ questions: [{ id: 'q1' }] }));
    expect(questionState.dominantActivity).toBe('waiting_user');
    expect(questionState.leader?.zone).toBe('gate');
    expect(questionState.notifications[0]).toMatchObject({ kind: 'question', count: 1 });

    const approvalState = deriveOfficeState(board({ approvals: [{ id: 'a1' }] }));
    expect(approvalState.dominantActivity).toBe('waiting_approval');
  });

  it('keeps actor identity and desk assignment stable when input order changes', () => {
    const runs = [
      { id: 'run-1', agentId: 'worker-1', phase: 'implement', status: 'running' },
      { id: 'run-2', agentId: 'worker-2', phase: 'implement', status: 'running' },
    ];
    const first = deriveOfficeState(board({ runs }));
    const second = deriveOfficeState(board({ runs: runs.slice().reverse() }));
    expect(second.actors.map(actor => [actor.id, actor.deskId])).toEqual(first.actors.map(actor => [actor.id, actor.deskId]));
  });

  it('places adopted and detached sessions at the entrance', () => {
    const state = deriveOfficeState(board({
      runs: [{ id: 'run-1', agentId: 'worker-1', phase: 'implement', status: 'detached', origin: 'adopted' }],
    }));
    expect(state.actors[0]).toMatchObject({ zone: 'entrance', origin: 'adopted' });
  });

  it('emits verdict and activity transitions without replaying a first snapshot', () => {
    const previous = deriveOfficeState(board({
      runs: [{ id: 'run-1', agentId: 'worker-1', subtaskId: 'sub-1', phase: 'implement', status: 'running' }],
    }));
    const current = deriveOfficeState(board({
      runs: [{ id: 'run-1', agentId: 'worker-1', subtaskId: 'sub-1', phase: 'review', status: 'running' }],
      reviews: [{ id: 'review-1', subtaskId: 'sub-1', verdict: 'rework' }],
    }));
    expect(diffOfficeState(null, current)).toEqual([]);
    expect(diffOfficeState(previous, current).map(item => item.type)).toEqual(expect.arrayContaining(['REVIEW_HANDOFF', 'VERDICT_REWORK']));
  });

  it('names snapshot-skip transitions for review handoff and rework return', () => {
    const previous = deriveOfficeState(board());
    const review = deriveOfficeState(board({
      runs: [{ id: 'review-run', agentId: 'reviewer-1', phase: 'review', status: 'running' }],
    }));
    const rework = deriveOfficeState(board({
      runs: [{ id: 'rework-run', agentId: 'worker-1', phase: 'implement', status: 'running', cycle: 2 }],
    }));
    expect(diffOfficeState(previous, review)[0]?.type).toBe('REVIEW_HANDOFF');
    expect(diffOfficeState(previous, rework)[0]?.type).toBe('REWORK_RETURN');
  });

  it('bounds transition backlog while retaining critical events first', () => {
    const previous = deriveOfficeState(board());
    const runs = Array.from({ length: 30 }, (_, index) => ({
      id: `run-${index}`,
      agentId: `worker-${index}`,
      phase: 'implement',
      status: 'running',
    }));
    const current = deriveOfficeState(board({ runs }));
    expect(diffOfficeState(previous, current)).toHaveLength(MAX_QUEUED_TRANSITIONS);
  });
});
