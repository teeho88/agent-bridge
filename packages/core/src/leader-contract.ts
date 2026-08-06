// The leader (whichever CLI/API model the user picked as project lead) must
// reply with exactly one fenced ```json block matching one of these shapes.
// Free-form prose plans are not machine-actionable — the orchestrator needs
// structured subtasks/reviewers/decisions to drive spawning and adjudication.

export type LeaderAgentPreference = {
  provider: string;
  mode?: "cli" | "api" | "manual";
  model?: string;
  reasoningEffort?: string;
  reason?: string;
};

export type LeaderPlanSubtask = {
  key: string;
  title: string;
  goal?: string;
  priority?: number;
  dependsOn: string[];
  acceptanceCriteria: string[];
  role?: string;
  parallelSafe?: boolean;
  files: string[];
  agentPreference?: LeaderAgentPreference;
};

export type LeaderPlanReviewer = {
  key: string;
  scope: string[];
  role?: string;
  agentPreference?: LeaderAgentPreference;
};

// A question the leader needs the user to settle. `options` turns it into a
// pick-one instead of a free-text prompt — far less friction, and it keeps the
// answer inside a set the leader already knows how to plan around. Empty
// options means "answer in your own words".
export type LeaderQuestion = {
  question: string;
  options: string[];
};

export type LeaderPlanTurn = {
  version: 1;
  phase: "plan";
  complexity: "small" | "medium" | "large";
  planMarkdown: string;
  subtasks: LeaderPlanSubtask[];
  reviewers: LeaderPlanReviewer[];
  questions: LeaderQuestion[];
};

export type LeaderAdjudicateVerdict = "accept" | "rework" | "block";

export type LeaderAdjudicateRework = {
  title: string;
  goal?: string;
  acceptanceCriteria: string[];
  agentPreference?: LeaderAgentPreference;
};

export type LeaderAdjudicateDecision = {
  subtaskKey: string;
  verdict: LeaderAdjudicateVerdict;
  rework?: LeaderAdjudicateRework;
};

export type LeaderAdjudicateTurn = {
  version: 1;
  phase: "adjudicate";
  decisions: LeaderAdjudicateDecision[];
  projectComplete: boolean;
  questions: LeaderQuestion[];
};

export type LeaderTurn = LeaderPlanTurn | LeaderAdjudicateTurn;

export type ParseLeaderTurnResult =
  | { ok: true; turn: LeaderTurn }
  | { ok: false; error: string };

export type ParseLeaderPlanResult =
  | { ok: true; turn: LeaderPlanTurn }
  | { ok: false; error: string };

export type ParseLeaderAdjudicateResult =
  | { ok: true; turn: LeaderAdjudicateTurn }
  | { ok: false; error: string };

// Walks the text from the first `{` at or after `from` and returns the
// complete, brace-balanced object literal. String contents (and escapes
// inside them) are skipped, so a nested ```js sample or a stray brace inside
// planMarkdown cannot terminate the object early — the reason this is a
// scanner rather than a regex.
function extractBalancedObject(text: string, from: number): string | undefined {
  const start = text.indexOf("{", from);
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  // Never balanced: hand back the remainder anyway so the caller's JSON.parse
  // reports the actual syntax error instead of a misleading "no JSON found".
  return text.slice(start);
}

// Returns the leader's reply object, anchored on the LAST ```json fence.
//
// A run log is not just the model's answer: the codex CLI echoes the whole
// prompt back to stdout, and our own plan/adjudicate prompts embed a ```json
// schema example — a retry prompt then embeds a second copy. A real log
// therefore holds three ```json fences of which only the last is the reply,
// so anchoring on the first (or spanning first-to-last) yields garbage and
// stalls the orchestration at `planning` forever.
//
// Deliberately no fallback to an earlier fence when the last one is broken:
// the earlier ones are the echoed schema example, and "successfully" planning
// from placeholder subtasks is far worse than reporting a parse failure and
// letting the leader retry.
export function extractJsonBlock(text: string): string | undefined {
  const fence = /```json/gi;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) start = match.index + match[0].length;
  return extractBalancedObject(text, start);
}

export function parseLeaderTurn(text: string, expectedPhase: "plan"): ParseLeaderPlanResult;
export function parseLeaderTurn(text: string, expectedPhase: "adjudicate"): ParseLeaderAdjudicateResult;
export function parseLeaderTurn(
  text: string,
  expectedPhase: "plan" | "adjudicate",
): ParseLeaderTurnResult {
  const block = extractJsonBlock(text);
  if (!block) {
    return {
      ok: false,
      error: "No JSON found in the reply. Reply with a single ```json fenced block matching the required schema.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return {
      ok: false,
      error: `The JSON block did not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "The JSON block must be an object, not an array or scalar." };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.phase !== expectedPhase) {
    return {
      ok: false,
      error: `Expected "phase": "${expectedPhase}", got ${JSON.stringify(obj.phase)}.`,
    };
  }
  return expectedPhase === "plan" ? validatePlanTurn(obj) : validateAdjudicateTurn(obj);
}

export function buildRetryPrompt(error: string): string {
  return [
    "Your previous reply could not be parsed as the required JSON contract.",
    `Parse error: ${error}`,
    "Reply again with ONLY a single fenced ```json block matching the schema. Do not include any prose before or after it.",
  ].join("\n");
}

// `complexity` is a display label — it drives nothing in the state machine.
// Rejecting a whole, otherwise-perfect plan because the leader wrote "low"
// instead of "small" costs a full retry cycle and then pauses the run for the
// user (observed live: codex answered "low" twice in a row, even after the
// retry prompt quoted the exact error). Map the obvious synonyms; anything
// genuinely unrecognised still fails.
const COMPLEXITY_SYNONYMS: Record<string, LeaderPlanTurn["complexity"]> = {
  small: "small",
  low: "small",
  simple: "small",
  trivial: "small",
  tiny: "small",
  xs: "small",
  s: "small",
  medium: "medium",
  moderate: "medium",
  mid: "medium",
  m: "medium",
  large: "large",
  high: "large",
  complex: "large",
  big: "large",
  xl: "large",
  l: "large",
};

export function normalizeComplexity(value: unknown): LeaderPlanTurn["complexity"] | undefined {
  if (typeof value !== "string") return undefined;
  return COMPLEXITY_SYNONYMS[value.trim().toLowerCase()];
}

function validatePlanTurn(obj: Record<string, unknown>): ParseLeaderTurnResult {
  const errors: string[] = [];

  const complexity = normalizeComplexity(obj.complexity);
  if (!complexity) {
    errors.push('"complexity" must be one of "small" | "medium" | "large".');
  }
  if (typeof obj.planMarkdown !== "string" || !obj.planMarkdown.trim()) {
    errors.push('"planMarkdown" must be a non-empty string.');
  }

  // An empty array is structurally valid: on a re-plan the leader may
  // legitimately conclude the change request is already satisfied and there is
  // nothing left to build (observed live — it answered that twice, and the
  // contract threw both plans away and paused the run). Whether "no subtasks"
  // is an answer or a failure depends on context the orchestrator has and this
  // layer does not, so it decides.
  const subtasks: LeaderPlanSubtask[] = [];
  if (!Array.isArray(obj.subtasks)) {
    errors.push('"subtasks" must be an array.');
  } else {
    obj.subtasks.forEach((raw, index) => {
      const result = validateSubtask(raw, index);
      if (typeof result === "string") errors.push(result);
      else subtasks.push(result);
    });
  }

  const subtaskKeys = subtasks.map((subtask) => subtask.key);
  const reviewers: LeaderPlanReviewer[] = [];
  if (obj.reviewers !== undefined) {
    if (!Array.isArray(obj.reviewers)) {
      errors.push('"reviewers" must be an array when present.');
    } else {
      obj.reviewers.forEach((raw, index) => {
        const result = validateReviewer(raw, index, subtaskKeys);
        if (typeof result === "string") errors.push(result);
        else reviewers.push(result);
      });
    }
  }

  if (errors.length) return { ok: false, error: errors.join(" ") };
  return {
    ok: true,
    turn: {
      version: 1,
      phase: "plan",
      complexity: complexity as LeaderPlanTurn["complexity"],
      planMarkdown: obj.planMarkdown as string,
      subtasks,
      reviewers,
      questions: asQuestionArray(obj.questions),
    },
  };
}

function validateSubtask(raw: unknown, index: number): LeaderPlanSubtask | string {
  if (typeof raw !== "object" || raw === null) return `subtasks[${index}] must be an object.`;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.key !== "string" || !obj.key) return `subtasks[${index}].key must be a non-empty string.`;
  if (typeof obj.title !== "string" || !obj.title) return `subtasks[${index}].title must be a non-empty string.`;
  const agentPreference = validateAgentPreference(obj.agentPreference);
  if (typeof agentPreference === "string") return `subtasks[${index}].${agentPreference}`;
  return {
    key: obj.key,
    title: obj.title,
    goal: typeof obj.goal === "string" ? obj.goal : undefined,
    priority: typeof obj.priority === "number" ? obj.priority : undefined,
    dependsOn: asStringArray(obj.dependsOn) ?? [],
    acceptanceCriteria: asStringArray(obj.acceptanceCriteria) ?? [],
    role: typeof obj.role === "string" ? obj.role : undefined,
    parallelSafe: typeof obj.parallelSafe === "boolean" ? obj.parallelSafe : undefined,
    files: asStringArray(obj.files) ?? [],
    agentPreference,
  };
}

function validateReviewer(
  raw: unknown,
  index: number,
  subtaskKeys: string[],
): LeaderPlanReviewer | string {
  if (typeof raw !== "object" || raw === null) return `reviewers[${index}] must be an object.`;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.key !== "string" || !obj.key) return `reviewers[${index}].key must be a non-empty string.`;
  const scope = asStringArray(obj.scope);
  if (!scope?.length) return `reviewers[${index}].scope must be a non-empty array of subtask keys.`;
  const unknownKeys = scope.filter((key) => !subtaskKeys.includes(key));
  if (unknownKeys.length) {
    return `reviewers[${index}].scope references unknown subtask key(s): ${unknownKeys.join(", ")}.`;
  }
  const agentPreference = validateAgentPreference(obj.agentPreference);
  if (typeof agentPreference === "string") return `reviewers[${index}].${agentPreference}`;
  return {
    key: obj.key,
    scope,
    role: typeof obj.role === "string" ? obj.role : undefined,
    agentPreference,
  };
}

function validateAdjudicateTurn(obj: Record<string, unknown>): ParseLeaderTurnResult {
  const errors: string[] = [];
  const decisions: LeaderAdjudicateDecision[] = [];

  // An empty array is legitimate: the orchestrator also asks the leader to
  // adjudicate when execution simply ran out of work, and in that case there
  // are no pending reviews to decide on. Rejecting it burned two leader turns
  // and paused the run (observed live). `projectComplete` carries the answer.
  if (!Array.isArray(obj.decisions)) {
    errors.push('"decisions" must be an array.');
  } else {
    obj.decisions.forEach((raw, index) => {
      const result = validateDecision(raw, index);
      if (typeof result === "string") errors.push(result);
      else decisions.push(result);
    });
  }
  if (typeof obj.projectComplete !== "boolean") {
    errors.push('"projectComplete" must be a boolean.');
  }

  if (errors.length) return { ok: false, error: errors.join(" ") };
  return {
    ok: true,
    turn: {
      version: 1,
      phase: "adjudicate",
      decisions,
      projectComplete: obj.projectComplete as boolean,
      questions: asQuestionArray(obj.questions),
    },
  };
}

function validateDecision(raw: unknown, index: number): LeaderAdjudicateDecision | string {
  if (typeof raw !== "object" || raw === null) return `decisions[${index}] must be an object.`;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.subtaskKey !== "string" || !obj.subtaskKey) {
    return `decisions[${index}].subtaskKey must be a non-empty string.`;
  }
  const verdict = obj.verdict;
  if (verdict !== "accept" && verdict !== "rework" && verdict !== "block") {
    return `decisions[${index}].verdict must be "accept" | "rework" | "block".`;
  }
  if (verdict !== "rework") {
    return { subtaskKey: obj.subtaskKey, verdict };
  }
  if (typeof obj.rework !== "object" || obj.rework === null) {
    return `decisions[${index}].rework is required when verdict is "rework".`;
  }
  const reworkObj = obj.rework as Record<string, unknown>;
  if (typeof reworkObj.title !== "string" || !reworkObj.title) {
    return `decisions[${index}].rework.title must be a non-empty string.`;
  }
  const agentPreference = validateAgentPreference(reworkObj.agentPreference);
  if (typeof agentPreference === "string") return `decisions[${index}].rework.${agentPreference}`;
  return {
    subtaskKey: obj.subtaskKey,
    verdict,
    rework: {
      title: reworkObj.title,
      goal: typeof reworkObj.goal === "string" ? reworkObj.goal : undefined,
      acceptanceCriteria: asStringArray(reworkObj.acceptanceCriteria) ?? [],
      agentPreference,
    },
  };
}

function validateAgentPreference(raw: unknown): LeaderAgentPreference | undefined | string {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) return "agentPreference must be an object when present.";
  const obj = raw as Record<string, unknown>;
  if (typeof obj.provider !== "string" || !obj.provider) {
    return "agentPreference.provider must be a non-empty string.";
  }
  const mode = obj.mode;
  if (mode !== undefined && mode !== "cli" && mode !== "api" && mode !== "manual") {
    return 'agentPreference.mode must be "cli" | "api" | "manual" when present.';
  }
  return {
    provider: obj.provider,
    mode: mode as LeaderAgentPreference["mode"],
    model: typeof obj.model === "string" ? obj.model : undefined,
    reasoningEffort: typeof obj.reasoningEffort === "string" ? obj.reasoningEffort : undefined,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
  };
}

// Accepts both shapes the leader may emit: a bare string, or an object with
// `question` plus optional `options`. Older prompts (and models that ignore
// the option syntax) keep working as plain strings.
function asQuestionArray(value: unknown): LeaderQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: LeaderQuestion[] = [];
  for (const raw of value) {
    if (typeof raw === "string" && raw.trim()) {
      questions.push({ question: raw.trim(), options: [] });
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const question = typeof obj.question === "string" ? obj.question.trim() : "";
    if (!question) continue;
    questions.push({ question, options: asStringArray(obj.options)?.filter(Boolean) ?? [] });
  }
  return questions;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}
