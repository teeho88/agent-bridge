export const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);

// "detached" (process died without a normal exit event, e.g. reaped after a
// crash) and "stopped" (user cancelled it) are just as final as "failed" —
// without them here a dead run is neither active nor finished, so the
// orchestrator step logic stalls forever instead of reading the log and
// surfacing the failure.
export const TERMINAL_RUN_STATUSES = new Set([
  "done",
  "failed",
  "detached",
  "stopped",
]);

// How much of an implementer's log is kept as its assignment summary.
export const ASSIGNMENT_SUMMARY_CHARS = 800;

// The change request (and the prior plan/report text the caller captured for
// it) is recorded as an orchestration event rather than a column: it is a
// point-in-time user action, and core stays free of filesystem access by
// having the caller pass the file contents in.
export const CHANGE_REQUEST_EVENT_PREFIX = "change-request:";

// The most times the leader may park the run on questions. A ceiling, never a
// quota: a leader that has nothing left to ask should plan on turn one. It
// exists only to stop the plan/answer loop a leader falls into when it re-asks
// settled ground in new words. Set per orchestration at start; the env var is
// the fallback for callers that do not expose the field.
export const DEFAULT_PLAN_QUESTION_ROUND_LIMIT = 4;

export const PLAN_QUESTION_EVENT_PREFIX = "Leader raised";

// ---------------------------------------------------------------------------
// Adjudicating phase
// ---------------------------------------------------------------------------

// The completion guard asks this when the leader calls the project done with
// subtasks still open. The first option is carried out here, not by the leader:
// answering it in prose only ever produced another leader turn, which marked
// the project complete again and landed straight back on the guard.
export const OPEN_SUBTASKS_QUESTION_KIND = "open-subtasks";

export const DROP_OPEN_SUBTASKS_OPTION =
  "Drop the open subtasks and finish the orchestration";

export const SEND_OPEN_SUBTASKS_BACK_OPTION =
  "Send them back to the leader to finish properly";

// Why a subtask is sitting in `blocked`. Two things put it there — a reviewer
// or leader block verdict, and an implementer run that failed or was refused by
// the machine — and both records are otherwise invisible at adjudication: the
// review has been consumed, and the assignment summary is only ever replayed to
// reviewers. Without the reason the leader is told to clear a blocked subtask
// while being given no idea what stopped it.
export const BLOCK_REASON_CHARS = 600;

export const SUBTASK_META_PREFIX = "subtask-meta:";

export const REVIEWER_META_PREFIX = "reviewer-meta:";

// Plan metas are the join between the database and the context folders, so the
// lookup has to be total: an orchestration that ran for cycles accumulates
// thousands of events, and a plain newest-N window silently drops the oldest
// keys, which sends their reworks into a brand-new empty folder.
export const META_SCAN_LIMIT = 20000;

// ---------------------------------------------------------------------------
// Context store wiring
// ---------------------------------------------------------------------------

// A turn that finished without writing its context document gets exactly one
// short, code-free retry that asks only for the file. Then the orchestration
// moves on regardless: the file is how the *next* turn avoids re-deriving what
// this one learnt, and losing that is a real cost — but stalling the whole run
// on a document is a worse one, and an agent that ignored the instruction twice
// will ignore it a third time.
export const CONTEXT_RETRY_EVENT_PREFIX = "context-file-retry:";

export const CONTEXT_FILE_RETRY_BUDGET = 1;
