// The orchestration context store: the on-disk `.md` layout that carries an
// orchestration's *narrative* context (why, what was found, what was decided)
// between turns.
//
// The problem it solves: context used to be pushed into every prompt, rebuilt
// from the store each turn and truncated to fit (ASSIGNMENT_SUMMARY_CHARS,
// truncateReason, priorReviewsForSubtask). Every hop through
// plan → implement → review → adjudicate → rework shaved another layer off, so
// the second rework no longer knew why the first one failed. Here the context
// is written once to a stable path and *pulled* by whoever needs it: prompts
// carry paths, not payloads, and cost stops growing with the number of rounds.
//
// Division of truth, deliberately strict:
//   - SQLite owns state (subtask status, dependsOn, run ids, cycle, approvals).
//   - These files own narrative. No status is written here, or the two drift
//     and an agent believes the stale one.
//
// Core stays free of filesystem access (same reason `writePlanFile` is
// injected), so this module builds *workspace-relative* paths and renders
// markdown; the caller supplies a `ContextStoreIO` that resolves those paths
// against the workspace root.

export const CONTEXT_ROOT = ".agent-memory/context";

// The workspace an orchestration runs in usually has its own CLAUDE.md /
// AGENTS.md telling an agent to start a task, compile context and update the
// handoff. Those rules address a human's terminal agent, and a spawned
// sub-agent obeying them writes into the wrong layer: handoffs addressed to
// nobody, a compiled-context.md that parallel implementers overwrite mid-turn,
// and the active-task slot taken from the orchestration itself. Every prompt
// that hands out context paths also carries this. `installSpawnedRunGuard` in
// the CLI enforces it; this is what makes the agent not try.
export const WORKBOARD_BOUNDARY_LINES: readonly string[] = [
  "The `.agent-memory/context/` files named above are this orchestration's memory,",
  "and the only memory you write. Leave the terminal workboard alone: no",
  "`agent-bridge task|session|handoff|context|memory` write commands, and no edits to",
  "`.handoff/CURRENT.md`, `.handoff/INDEX.md`, `current-task.md` or `compiled-context.md`. Those belong",
  "to the human working this repo; this workspace's CLAUDE.md/AGENTS.md rules about",
  "them are not addressed to you, and the commands are refused for spawned runs.",
];

// Every turn document must open with this, holding the ten-line version of
// what it says. Readers are told to take the summary and stop unless they need
// more — without it the files grow until reading them costs what the old
// inlined prompts cost, and nothing has been gained.
export const SUMMARY_HEADING = "## Summary";
export const DETAIL_HEADING = "## Detail";

// Separates the plan body (rewritten on every revision) from the revision log
// (append-only). Losing the log loses *why* the plan changed, which is what
// lets the next revision undo the previous one and loop.
const REVISION_LOG_MARKER = "<!-- revision-log -->";

export type ContextStoreIO = {
  // All paths are workspace-relative; the implementation resolves them.
  exists(path: string): boolean;
  read(path: string): string | undefined;
  write(path: string, content: string): void;
  append(path: string, content: string): void;
};

export type TurnKind = "report" | "review" | "adjudication";

export type AssignmentLogEntry = {
  contextKey: string;
  round: number;
  role: string;
  agent: string;
  subtaskTitle: string;
};

export type BriefInput = {
  contextKey: string;
  title: string;
  goal?: string;
  acceptanceCriteria: string[];
  files: string[];
  // Dependencies are named by the only file a downstream task may read from
  // them: their summary. Handing over the whole upstream folder is what makes
  // reading cost grow with rounds × tasks instead of tasks.
  dependencies: Array<{ title: string; summaryPath: string }>;
};

export type IndexInput = {
  taskTitle: string;
  goal?: string;
  status: string;
  cycle: number;
  maxCycles: number;
  tasks: Array<{ contextKey: string; title: string; status: string }>;
};

export type ContextStore = {
  // Workspace-relative directory holding this orchestration's context.
  root: string;
  planPath: string;
  reportPath: string;
  assignmentLogPath: string;
  indexPath: string;
  taskDir(contextKey: string): string;
  briefPath(contextKey: string): string;
  turnPath(kind: TurnKind, contextKey: string, round: number): string;
  summaryPath(contextKey: string): string;

  writePlan(markdown: string, revision?: { trigger: string; change: string }): string;
  writeReport(markdown: string): string;
  writeBrief(input: BriefInput): string;
  appendAssignment(entry: AssignmentLogEntry): void;
  writeIndex(input: IndexInput): void;
  writeSummary(contextKey: string, markdown: string): string;

  // The gate: a turn may only advance the state machine once its document
  // exists and carries a Summary. Prompts alone do not get files written.
  checkTurn(kind: TurnKind, contextKey: string, round: number): TurnCheck;
  // Paths that already exist, for a prompt to hand an agent as "read these".
  existingPaths(paths: string[]): string[];
};

export type TurnCheck = { ok: true; path: string } | { ok: false; path: string; reason: string };

export function createContextStore(
  io: ContextStoreIO,
  orchestrationId: string,
): ContextStore {
  const root = `${CONTEXT_ROOT}/${sanitizeSegment(orchestrationId)}`;
  const taskDir = (contextKey: string) => `${root}/tasks/${sanitizeSegment(contextKey)}`;
  const briefPath = (contextKey: string) => `${taskDir(contextKey)}/brief.md`;
  const summaryPath = (contextKey: string) => `${taskDir(contextKey)}/summary.md`;
  const turnPath = (kind: TurnKind, contextKey: string, round: number) =>
    `${taskDir(contextKey)}/${kind}-r${Math.max(1, round)}.md`;
  const planPath = `${root}/plan.md`;
  const reportPath = `${root}/report.md`;
  const assignmentLogPath = `${root}/assignment-log.md`;
  const indexPath = `${root}/index.md`;

  return {
    root,
    planPath,
    reportPath,
    assignmentLogPath,
    indexPath,
    taskDir,
    briefPath,
    turnPath,
    summaryPath,

    writePlan(markdown, revision) {
      // The body is replaced wholesale — the leader re-emits the whole plan —
      // but the revision log below the marker is carried forward and only ever
      // appended to.
      const previousLog = extractRevisionLog(io.read(planPath));
      const entry = revision
        ? [
            `## Revision ${countRevisions(previousLog) + 1} — ${new Date().toISOString()}`,
            `Trigger: ${oneLine(revision.trigger)}`,
            `Change: ${oneLine(revision.change)}`,
            "",
          ].join("\n")
        : "";
      const log = `${previousLog}${entry}`;
      const body = markdown.trimEnd();
      io.write(
        planPath,
        log
          ? `${body}\n\n${REVISION_LOG_MARKER}\n\n${log.trimEnd()}\n`
          : `${body}\n`,
      );
      return planPath;
    },

    writeReport(markdown) {
      io.write(reportPath, `${markdown.trimEnd()}\n`);
      return reportPath;
    },

    writeBrief(input) {
      const path = briefPath(input.contextKey);
      io.write(path, renderBrief(input));
      return path;
    },

    appendAssignment(entry) {
      // Append-only, and one line per assignment: two implementers dispatched
      // in the same step must not clobber each other's record.
      if (!io.exists(assignmentLogPath)) {
        io.write(
          assignmentLogPath,
          "# Assignment log\n\nAppend-only. `timestamp | task | round | role | agent | title`\n\n",
        );
      }
      io.append(
        assignmentLogPath,
        `${new Date().toISOString()} | ${entry.contextKey} | r${entry.round} | ${entry.role} | ${entry.agent} | ${oneLine(entry.subtaskTitle)}\n`,
      );
    },

    writeIndex(input) {
      io.write(indexPath, renderIndex(input, taskDir));
    },

    writeSummary(contextKey, markdown) {
      const path = summaryPath(contextKey);
      io.write(path, `${markdown.trimEnd()}\n`);
      return path;
    },

    checkTurn(kind, contextKey, round) {
      const path = turnPath(kind, contextKey, round);
      if (!io.exists(path)) {
        return { ok: false, path, reason: `it never wrote its ${kind} document at ${path}` };
      }
      const problem = summaryProblem(io.read(path));
      if (problem) return { ok: false, path, reason: `${path} ${problem}` };
      return { ok: true, path };
    },

    existingPaths(paths) {
      return paths.filter((path) => io.exists(path));
    },
  };
}

// ---------------------------------------------------------------------------
// Keys and rounds
// ---------------------------------------------------------------------------

// One folder per *original* subtask, not per subtask row. Adjudication answers
// a rework by cancelling the subtask and creating a new one keyed
// `<origin>-rework-<cycle>`, so a folder per row would put every attempt in its
// own directory, each holding a lone `report-r1.md`, and the chain that
// adjudication most needs to read would be scattered across them. Stripping the
// suffixes keeps one folder per piece of work with its attempts numbered inside.
export function contextKeyFor(
  subtaskKey: string | undefined,
  fallbackId: string,
  planCycle?: number,
): string {
  const key = subtaskKey?.trim();
  if (!key) return sanitizeSegment(fallbackId);
  const origin = sanitizeSegment(originKeyOf(key));
  // Leaders reuse `s1`, `s2`, … in every plan, so without the cycle the second
  // plan's `s2` lands in the first plan's folder: same `brief.md`, same
  // `report-r1.md`, and a `summary.md` describing entirely different work. The
  // cycle is the one the key was *planned* in, so a rework raised three cycles
  // later still joins its original as round 2 in the same folder.
  // Metas recorded before this existed carry no cycle and keep their old
  // unprefixed folder — nothing already on disk moves.
  return planCycle == null ? origin : `c${Math.max(0, Math.trunc(planCycle))}-${origin}`;
}

// The plan key with every `-rework-<n>` suffix stripped: the piece of work a
// run belongs to, independent of which attempt it is.
export function planOriginKey(subtaskKey: string): string {
  return originKeyOf(subtaskKey.trim());
}

// Attempt number: the original is round 1, each `-rework-<n>` suffix is one
// more. This is what keeps `report-r2.md` from overwriting `report-r1.md` —
// and the r1 documents are exactly what the r2 implementer and the adjudicator
// have to read to avoid re-deriving the same defect.
export function roundFor(subtaskKey: string | undefined): number {
  if (!subtaskKey) return 1;
  let current = subtaskKey.trim();
  let round = 1;
  for (;;) {
    const origin = current.match(/^(.+)-rework-\d+$/)?.[1];
    if (!origin) return round;
    current = origin;
    round += 1;
  }
}

function originKeyOf(key: string): string {
  let current = key;
  for (;;) {
    const origin = current.match(/^(.+)-rework-\d+$/)?.[1];
    if (!origin) return current;
    current = origin;
  }
}

// Leader-authored keys land in path segments, so anything that could escape the
// directory or break on a filesystem is folded away. Keys are also the join
// between the database and these folders, so the mapping must be total: an
// empty result still has to produce a usable segment.
function sanitizeSegment(value: string): string {
  // Leading dots are stripped too, so a key like `../../etc/passwd` cannot
  // leave a `..` segment behind once the separators are folded to dashes.
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 80) || "unnamed";
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function renderBrief(input: BriefInput): string {
  const lines = [
    `# ${input.title}`,
    "",
    SUMMARY_HEADING,
    input.goal ? oneLine(input.goal) : oneLine(input.title),
    "",
    DETAIL_HEADING,
    "",
    `Context key: \`${input.contextKey}\``,
  ];
  if (input.acceptanceCriteria.length) {
    lines.push("", "### Acceptance criteria");
    for (const criterion of input.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  if (input.files.length) {
    lines.push("", "### Likely files");
    for (const file of input.files) lines.push(`- ${file}`);
  }
  if (input.dependencies.length) {
    lines.push(
      "",
      "### Depends on",
      "Read the summary of each — and only the summary. The other documents in a",
      "dependency's folder are for its own reviewer and adjudicator, not for you.",
    );
    for (const dependency of input.dependencies) {
      lines.push(`- ${dependency.title} → \`${dependency.summaryPath}\``);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderIndex(input: IndexInput, taskDir: (key: string) => string): string {
  const lines = [
    `# ${input.taskTitle}`,
    "",
    SUMMARY_HEADING,
    `Status: ${input.status} · cycle ${input.cycle}/${input.maxCycles} · ${input.tasks.length} task(s).`,
  ];
  if (input.goal) lines.push(oneLine(input.goal));
  lines.push(
    "",
    DETAIL_HEADING,
    "",
    "Generated by the orchestrator — do not edit. Statuses live in the database;",
    "this is a map, not a source of truth.",
    "",
    "| task | title | status | folder |",
    "| --- | --- | --- | --- |",
  );
  for (const task of input.tasks) {
    lines.push(`| \`${task.contextKey}\` | ${oneLine(task.title)} | ${task.status} | \`${taskDir(task.contextKey)}\` |`);
  }
  return `${lines.join("\n")}\n`;
}

// What is wrong with a turn document, or undefined if it is usable. Existence
// alone is not enough: an empty file, or one with no Summary, forces the next
// reader back to the full detail and defeats the point of the layout.
function summaryProblem(text: string | undefined): string | undefined {
  if (!text || !text.trim()) return "is empty";
  const index = text.indexOf(SUMMARY_HEADING);
  if (index < 0) return `has no \`${SUMMARY_HEADING}\` section`;
  // Only the lines up to the next heading count. Without that stop, a document
  // whose Summary is empty passes on the strength of its Detail section — which
  // is exactly the document the layout exists to prevent.
  const body: string[] = [];
  for (const line of text.slice(index + SUMMARY_HEADING.length).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) break;
    if (trimmed) body.push(trimmed);
  }
  return body.length ? undefined : `has an empty \`${SUMMARY_HEADING}\` section`;
}

function extractRevisionLog(plan: string | undefined): string {
  if (!plan) return "";
  const index = plan.indexOf(REVISION_LOG_MARKER);
  if (index < 0) return "";
  const log = plan.slice(index + REVISION_LOG_MARKER.length).trim();
  return log ? `${log}\n\n` : "";
}

function countRevisions(log: string): number {
  return (log.match(/^## Revision \d+/gm) ?? []).length;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
