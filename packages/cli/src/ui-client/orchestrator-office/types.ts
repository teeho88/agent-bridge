export type CanonicalOrchestrationStatus =
  | 'planning'
  | 'executing'
  | 'adjudicating'
  | 'reporting'
  | 'paused'
  | 'done'
  | 'failed';

export type WorkflowActivity =
  | 'idle'
  | 'planning'
  | 'dispatching'
  | 'implementing'
  | 'reviewing'
  | 'adjudicating'
  | 'reworking'
  | 'reporting'
  | 'waiting_approval'
  | 'waiting_user'
  | 'stopping'
  | 'failed'
  | 'done';

export type OfficeZone =
  | 'leader'
  | 'dispatch'
  | 'implement'
  | 'review'
  | 'decision'
  | 'report'
  | 'gate'
  | 'entrance';

export interface NormalizedBoardSnapshot {
  orchestration: Record<string, any> | null;
  runs: Array<Record<string, any>>;
  subtasks: Array<Record<string, any>>;
  reviews: Array<Record<string, any>>;
  approvals: Array<Record<string, any>>;
  questions: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
  registeredAgents: Array<Record<string, any>>;
  leaderAgent: Record<string, any> | null;
}

export interface PixelActorState {
  id: string;
  agentId: string;
  name: string;
  role: string;
  model: string;
  activity: WorkflowActivity;
  pose: string;
  zone: OfficeZone;
  deskId?: string;
  runId?: string;
  taskLabel?: string;
  progressPercent?: number;
  progressNote?: string;
  status?: string;
  origin?: string;
  reworkCycle?: number;
  verdict?: string;
  run?: Record<string, any>;
}

export interface PixelActivityState {
  key: string;
  actorId?: string;
  activity: WorkflowActivity;
  label: string;
}

export interface PixelOfficeSceneState {
  orchestrationId: string | null;
  globalStatus: CanonicalOrchestrationStatus | 'idle';
  dominantActivity: WorkflowActivity;
  leader: PixelActorState | null;
  actors: PixelActorState[];
  activities: PixelActivityState[];
  notifications: Array<{ kind: string; label: string; count: number }>;
  verdicts: Array<{ id: string; subtaskId?: string; verdict: string }>;
}

export interface PixelTransition {
  key: string;
  type: string;
  actorId?: string;
  critical: boolean;
  label: string;
}
