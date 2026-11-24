import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import type { AgentKind, Handoff, Task } from "@agent-bridge/memory";
import { readResumePacket } from "../task-resume.js";
import {
  getActiveTaskId,
  openStore,
  parseList,
  readStdinUtf8,
  redactIfEnabled,
  syncCurrentTaskArtifact
} from "../workspace.js";

export function registerHandoff(program: Command): void {
  const handoff = program.command("handoff").description("Create handoff packets");
  handoff.command("inspect").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .requiredOption("--revision <revision>").option("--agent <agent>", "receiving agent", "codex")
    .action((options: { task: string; session: string; revision: string; agent: AgentKind }) => {
      const store = openStore();
      try {
        const packet = readResumePacket(store, process.cwd(), options);
        console.log(JSON.stringify({ handoffContractVersion: 1, checkpointId: packet.checkpoint.id, ...packet }, null, 2));
      } finally { store.close(); }
    });

  handoff
    .command("create")
    .option("--summary <summary>", "handoff summary (omit when using --stdin)")
    .option("--from <agent>", "source agent")
    .option("--task <taskId>", "task id")
    .option("--done <items>", "done items")
    .option("--next <items>", "next actions")
    .option("--risks <items>", "risks")
    .option("--files-changed <items>", "files changed")
    .option("--payload-file <path>", "UTF-8 JSON handoff with structured evidence and decisions")
    .option("--stdin", "read summary from stdin as raw UTF-8 (safe for non-ASCII)")
    .action(
      async (options: {
        summary?: string;
        from?: AgentKind;
        task?: string;
        done?: string;
        next?: string;
        risks?: string;
        filesChanged?: string;
        payloadFile?: string;
        stdin?: boolean;
      }) => {
        if (options.payloadFile && (options.stdin || options.summary !== undefined || options.done !== undefined || options.next !== undefined || options.risks !== undefined || options.filesChanged !== undefined)) {
          throw new Error("--payload-file cannot be combined with inline handoff fields or --stdin");
        }
        const payload = options.payloadFile ? redactHandoffPayload(readHandoffPayload(options.payloadFile)) : undefined;
        const rawSummary = payload?.summary ?? (options.stdin ? await readStdinUtf8() : options.summary);
        if (!rawSummary) {
          throw new Error("No handoff summary. Provide --summary or pipe text with --stdin.");
        }
        const redactList = (value?: string) => parseList(value).map((item) => redactIfEnabled(item));
        const store = openStore();
        try {
          const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.from);
          syncCurrentTaskArtifact(store, taskId);
          const activeDecisions = store.listDecisions(taskId);
          const incomingScopes = new Set<string>();
          for (const decision of payload?.decisions ?? []) {
            if (!decision.scope) continue;
            if (incomingScopes.has(decision.scope)) throw new Error(`Duplicate decision scope in handoff: ${decision.scope}`);
            incomingScopes.add(decision.scope);
            const current = activeDecisions.filter((item) => item.scope === decision.scope);
            if (current.length && (!decision.supersedes || current.length !== 1 || current[0].id !== decision.supersedes)) {
              throw new Error(`Active decision in scope ${decision.scope}; specify its id as supersedes`);
            }
            if (decision.supersedes && !current.length) throw new Error(`Cannot supersede an inactive or mismatched decision: ${decision.supersedes}`);
          }
          const recordedDecisions = (payload?.decisions ?? []).filter((item) => item.scope).map((item) => store.recordDecision({
            taskId, decision: item.decision, reason: item.reason, scope: item.scope!,
            supersedes: item.supersedes, relatedFiles: item.relatedFiles,
            sourceAgent: options.from
          }));
          const created = store.upsertTaskHandoff({
            taskId,
            fromAgent: options.from,
            summary: redactIfEnabled(rawSummary),
            done: payload ? [
              ...payload.done,
              ...payload.decisions.filter((item) => !item.scope).map((item) => `Decision: ${item.decision}; reason: ${item.reason}`),
              ...(payload.evidence.length ? ["Test evidence: see portable handoff artifact reference"] : [])
            ] : redactList(options.done),
            next: payload ? payload.next : redactList(options.next),
            risks: payload ? [...payload.risks, ...payload.unresolved.map((item) => `Unresolved: ${item}`)] : redactList(options.risks),
            filesChanged: payload ? payload.filesChanged : redactList(options.filesChanged)
          });
          writeHandoffArtifacts(process.cwd(), created, {
            archive: true,
            task: store.getTask(taskId),
            details: payload
          });
          store.addMemory({
            taskId,
            type: "handoff",
            content: created.summary,
            summary: created.summary,
            importance: 5,
            sourceAgent: options.from
          });
          console.log(`Created handoff ${created.id}`);
          if (recordedDecisions.length) console.log(`Recorded decisions: ${recordedDecisions.map((item) => item.id).join(", ")}`);
        } finally {
          store.close();
        }
      }
    );
}

function bullets(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None recorded.";
}

export type HandoffArtifactOptions = {
  // Manual handoffs are durable checkpoints. Auto handoffs refresh CURRENT but
  // deliberately skip history so every Stop hook does not create another file.
  archive?: boolean;
  task?: Task;
  details?: StructuredHandoff;
};

export type StructuredHandoff = {
  summary: string;
  done: string[];
  next: string[];
  risks: string[];
  filesChanged: string[];
  evidence: Array<{ command: string; result: string; cases: number; artifact: string }>;
  decisions: Array<{ decision: string; reason: string; scope?: string; supersedes?: string; relatedFiles?: string[] }>;
  unresolved: string[];
};

function readHandoffPayload(path: string): StructuredHandoff {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Handoff payload must be an object");
  const value = parsed as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const field = value[key] ?? [];
    if (!Array.isArray(field) || !field.every((item) => typeof item === "string" && item.trim())) throw new Error(`Invalid handoff ${key}`);
    return field;
  };
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Invalid handoff summary");
  const evidence = value.evidence ?? [];
  if (!Array.isArray(evidence) || !evidence.every((entry) => entry && typeof entry === "object" && typeof entry.command === "string" && typeof entry.result === "string" && Number.isInteger(entry.cases) && entry.cases >= 0 && typeof entry.artifact === "string" && entry.artifact.trim())) throw new Error("Invalid handoff evidence");
  const decisions = value.decisions ?? [];
  if (!Array.isArray(decisions) || !decisions.every((entry) => entry && typeof entry === "object" && typeof entry.decision === "string" && entry.decision.trim() && typeof entry.reason === "string" && entry.reason.trim() &&
    (entry.scope === undefined || (typeof entry.scope === "string" && entry.scope.trim())) &&
    (entry.supersedes === undefined || (typeof entry.supersedes === "string" && entry.supersedes.trim() && entry.scope)) &&
    (entry.relatedFiles === undefined || (Array.isArray(entry.relatedFiles) && entry.relatedFiles.every((path: unknown) => typeof path === "string" && path.trim()))))) throw new Error("Invalid handoff decisions");
  return { summary: value.summary, done: strings("done"), next: strings("next"), risks: strings("risks"), filesChanged: strings("filesChanged"), evidence, decisions, unresolved: strings("unresolved") };
}

function redactHandoffPayload(payload: StructuredHandoff): StructuredHandoff {
  const strings = (items: string[]) => items.map((item) => redactIfEnabled(item));
  return {
    ...payload,
    summary: redactIfEnabled(payload.summary),
    done: strings(payload.done), next: strings(payload.next), risks: strings(payload.risks),
    filesChanged: strings(payload.filesChanged), unresolved: strings(payload.unresolved),
    evidence: payload.evidence.map((item) => ({ ...item, command: redactIfEnabled(item.command), result: redactIfEnabled(item.result), artifact: redactIfEnabled(item.artifact) })),
    decisions: payload.decisions.map((item) => ({ ...item, decision: redactIfEnabled(item.decision), reason: redactIfEnabled(item.reason), relatedFiles: item.relatedFiles?.map((path) => redactIfEnabled(path)) }))
  };
}

function numbered(items: string[]): string {
  return items.length
    ? items.map((item, index) => `${index + 1}. **P${index}** ${item}`).join("\n")
    : "1. **P0** Review the live repository state and continue the task.";
}

function portableSlug(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "handoff"
  );
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function evidencePreview(value: string, limit = 200): string {
  const compact = singleLine(value);
  return compact.length > limit ? `${compact.slice(0, limit)}… [truncated; see full evidence artifact]` : compact;
}

export function renderPortableHandoffMarkdown(
  handoff: Handoff,
  task?: Task,
  details?: StructuredHandoff
): string {
  const title = task?.title ?? (singleLine(handoff.summary).slice(0, 80) || handoff.taskId);
  const readFirst = handoff.filesChanged.slice(0, 5);
  return [
    `# Handoff — ${title}`,
    "",
    `Date: ${handoff.createdAt}`,
    `Task: ${handoff.taskId}`,
    `From: ${handoff.fromAgent ?? "unknown"}`,
    `State: ${task?.status ?? "active"}`,
    "",
    "## Goal",
    task?.goal ?? handoff.summary,
    "",
    "## Current state",
    handoff.summary,
    "",
    "## Completed",
    bullets(handoff.done),
    "",
    "## Open loops",
    numbered(handoff.next),
    "",
    "## Decisions & gotchas",
    bullets(handoff.risks),
    ...(details?.decisions.length ? ["", "## Decisions & Reasons", ...details.decisions.map((item) => `- ${item.decision} — ${item.reason}${item.scope ? ` (scope: ${item.scope}${item.supersedes ? `; supersedes: ${item.supersedes}` : ""})` : ""}`)] : []),
    ...(details?.unresolved.length ? ["", "## Unresolved Issues", bullets(details.unresolved)] : []),
    ...(details?.evidence.length ? ["", "## Test Evidence", ...details.evidence.map((item) => `- ${evidencePreview(item.command)}: ${evidencePreview(item.result)}; cases: ${item.cases}; artifact: ${item.artifact}`), "", `Full evidence: .handoff/evidence/${handoff.id}.json`] : []),
    ...(readFirst.length
      ? [
          "",
          "## Read first",
          ...readFirst.map((path, index) => `${index + 1}. \`${path}\``)
        ]
      : []),
    "",
    "## Start here",
    handoff.next[0] ?? "Verify live repository state, then continue the current task.",
    ""
  ].join("\n");
}

function updatePortableIndex(
  indexPath: string,
  handoff: Handoff,
  historyRelativePath: string,
  task?: Task
): void {
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const entries = existing
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- ") && !line.includes(`| ${historyRelativePath}`));
  const label = singleLine(task?.title ?? handoff.summary).replace(/\|/g, "-");
  const timestamp = handoff.createdAt.replace("T", " ").slice(0, 16);
  const entry = `- ${timestamp} | ${label} | ${task?.status ?? "active"} | ${historyRelativePath}`;
  writeFileSync(indexPath, ["# Handoff Index", "", entry, ...entries.slice(0, 19), ""].join("\n"), "utf8");
}

export function writeHandoffArtifacts(
  cwd: string,
  handoff: Handoff,
  options: HandoffArtifactOptions = {}
): void {
  const portableDir = join(cwd, ".handoff");
  const historyDir = join(portableDir, "history");
  mkdirSync(historyDir, { recursive: true });
  const portable = renderPortableHandoffMarkdown(handoff, options.task, options.details);
  if (options.details) {
    const evidenceDir = join(portableDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `${handoff.id}.json`), JSON.stringify({ evidence: options.details.evidence, decisions: options.details.decisions, unresolved: options.details.unresolved }, null, 2) + "\n", "utf8");
  }
  writeFileSync(join(portableDir, "CURRENT.md"), portable, "utf8");
  const registryPath = join(cwd, ".agent-memory", "artifact-registry.json");
  mkdirSync(join(cwd, ".agent-memory"), { recursive: true });
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : {};
  registry[".handoff/CURRENT.md"] = {
    kind: "runtime_handoff_note", producer: "writeHandoffArtifacts", handoffId: handoff.id,
    taskId: handoff.taskId, sha256: createHash("sha256").update(portable).digest("hex"),
  };
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  if (options.archive) {
    const timestamp = handoff.createdAt
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 13);
    const suffix = handoff.id.replace(/^handoff-/, "").slice(-8);
    const filename = `${timestamp}-${portableSlug(options.task?.title ?? handoff.summary)}-${suffix}.md`;
    writeFileSync(join(historyDir, filename), portable, "utf8");
    updatePortableIndex(
      join(portableDir, "INDEX.md"),
      handoff,
      `.handoff/history/${filename}`,
      options.task
    );
  }
}
