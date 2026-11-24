import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const start = "<!-- agent-bridge:start -->";
const end = "<!-- agent-bridge:end -->";

export function temporaryArtifactCleanupSection(): string {
  return `## Temporary Artifact Cleanup

- Put disposable scratch files, caches, and test outputs in the system temp directory when practical. If they must live inside the repository, keep them under one clearly temporary path such as \`.agent-tmp/<agent-or-task>/\` instead of scattering them through project folders.
- Keep track of temporary files and directories you create during the task.
- Before finishing or handing off the task, remove temporary caches, scratch files, test outputs, and ad-hoc fixtures that you created solely for the work, then check the working tree for leftovers.
- Delete only artifacts you created for this task and have confirmed are no longer needed. Never remove pre-existing files, user-created untracked files, shared caches, or another agent's artifacts merely because they look temporary.
- Keep generated artifacts only when the user requested them or they are needed to reproduce/continue the work. Report any intentionally retained temporary-looking path and why it remains.
- If ownership or necessity is uncertain, leave the path in place and report it rather than deleting it.`;
}

export function permissionEscalationSection(): string {
  return `## Permission Escalation Rules

- If a required command or tool action is blocked by sandboxing, filesystem permissions, or an approval gate, use the available approval/escalation mechanism to ask the user for the minimum permission needed, then retry the blocked action after approval.
- Do not silently skip a required action, downgrade the requested outcome, or finish the task merely because the first attempt was permission-blocked while an approval path is available.
- Before requesting permission, resolve the exact command/action and target, and briefly explain why that permission is needed.
- If the platform rejects the escalation before it reaches the user, or the user denies it, continue every safe in-scope step that remains possible and report the exact blocked action and reason.`;
}

// Every rule above this block — start a task, compile context, open a session,
// write a handoff — addresses the agent a human is driving in a terminal. An
// agent spawned by an orchestration runs in the same workspace and reads the
// same file, and following those rules puts its work in the wrong layer:
// handoffs addressed to nobody, a compiled-context.md that parallel implementers
// overwrite mid-turn, and the active-task slot taken from the orchestration that
// spawned it. The orchestrator's own prompts say this too, but the agent reads
// CLAUDE.md/AGENTS.md first — this is where it needs to be told.
export function orchestratedRunSection(): string {
  return `## If You Were Spawned By An Orchestration

If the environment variable \`AGENT_BRIDGE_SPAWNED_RUN\` is set, you are a
sub-agent of an orchestration, not a terminal agent, and **none of the task,
session, handoff, compiled-context or memory rules above apply to you**. Do not
run \`agent-bridge task|session|handoff|context|memory\` write commands — they are
refused for spawned runs — and do not edit \`.handoff/CURRENT.md\`,
\`.handoff/INDEX.md\`, \`current-task.md\` or \`compiled-context.md\`. Your memory is the orchestration
context folder your prompt names (\`.agent-memory/context/<orchestrationId>/\`),
and your prompt names the one file in it you own. File leases still apply:
parallel implementers rely on them. The watcher maintains file briefs when
source content changes; do not run brief commands after tool use.`;
}

export function patchManagedSection(filePath: string, section: string): "created" | "updated" {
  const absolute = resolve(filePath);
  const normalizedSection = section.includes(start) ? section.trim() : `${start}\n\n${section.trim()}\n\n${end}`;

  if (!existsSync(absolute)) {
    writeFileSync(absolute, `${normalizedSection}\n`, "utf8");
    return "created";
  }

  const current = readFileSync(absolute, "utf8");
  copyFileSync(absolute, `${absolute}.bak`);
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, normalizedSection)
    : `${current.trimEnd()}\n\n${normalizedSection}\n`;
  writeFileSync(absolute, next, "utf8");
  return "updated";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compactWorkflowSection(agent: string, options: { hooked?: boolean } = {}): string {
  const hooked = options.hooked !== false;
  return `# Agent Bridge Context

User instructions take precedence. ${hooked ? (agent === "codex" ? "Codex lifecycle hooks already create or restore the task and live session." : "Lifecycle hooks own task/session startup.") : `Hooks are disabled: use manual lifecycle. For an existing task without an active session, run \`agent-bridge session start --agent ${agent} --task <taskId>\` once; if there is no task, run \`agent-bridge task start\` first.`} ${hooked ? "Do not run `agent-bridge task start`, `agent-bridge session start`, or `agent-bridge session end` during hooked work." : "Do not create a duplicate task/session; end only the manual session you own when the task is finished."} Do not start a new task just because the user sends a new prompt inside an active task/session; switch only when explicitly requested.

## Agent Startup Rules
Use Agent Bridge history only when the request needs it. Start with the prompt, retained conversation, and current source. Do not load compiled context automatically on session start, resume, or compaction.

For a clear repository reference that needs past work, run \`agent-bridge context find "<term>" --limit 3\`. Inspect only a relevant result with \`agent-bridge context query "<term>" --task <id>\`, \`agent-bridge context expand <memory-id> --task <id>\`, or \`agent-bridge context handoff --task <id>\`. If the repository reference is unclear, ask one focused question before searching history. If several results plausibly match, ask which one before opening details. A lookup does not switch the active task. Verify historical details against current source.

${hooked ? "When hooks are unavailable and no task exists, start one manually if task tracking is needed." : "task start already opens the initial session; reuse its task/session IDs."}

## Protected Workflow
- Full is default; single never disables leases and concurrent sessions promote it to full.
- Before edits: \`agent-bridge file lease-batch <paths...> --agent ${agent} --compact\`. Continue only when \"acquired\": true; retain lease ids. Include --session when leases are session-owned. On conflict inspect the blocking owner and coordinate; do not edit.
- When graph navigation is enabled, use graph search, neighbors or symbols on demand to locate relevant files before reading or editing. Verify hints against source; use scoped rg when the index is disabled, missing or stale.
- Search before reading: use \`rg --files -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/build/**' -g '!**/coverage/**' -g '!**/generated/**'\` to locate candidate files, then \`rg -n 'symbol' <relevant-path>\` to locate exact definitions and references. Scope searches to the relevant directory and exclude vendor/generated paths by default. Read only matching line ranges and direct imports/callers needed for the change. Briefs are navigation hints; do not load every brief, entire files unrelated to the task, or the global repo map.
- For verbose tool output, save the full stdout/stderr to an inspectable log file first; summarize with \`agent-bridge optimize logs <log-file> --max-lines 40 --max-chars 4000 --output <preview-file>\`. Show brief results while preserving failures and stack traces. If preview is truncated, report omitted diagnostic count, full original log path, and exact \`Get-Content -LiteralPath '<log-file>'\` or \`rg -n\` command to retrieve the evidence. Keep the original artifact until it is no longer needed for review/handoff.
- Reuse a source read only with its path, line range, content SHA-256, task/session, request revision and active decisions recorded. At the same revision reuse the retained result; validate its hash before editing or concluding. Source changes invalidate dependent reads and briefs; request or decision changes require checking their relevance again. After context loss or missing provenance, read the needed ranges again. The watcher refreshes briefs only when source content changes; check it has processed edited files before relying on their briefs. Reading files does not refresh briefs or mark edits. Do not run brief commands after tool use; manual brief refresh is only for an explicit user request. A matching hash validates retained bytes, not a test result.
- At a tested milestone, blocker, handoff, compaction or stop: \`agent-bridge task checkpoint --agent ${agent} --summary "..." --tests "actual results or not run" --files <edited paths...> --next "next action"\`. Include --session for session-owned leases. This saves state without completing the task or committing. Reported tests stay unverified unless runtime collected command evidence.
- Release only your leases after recording edits: \`agent-bridge file release-batch <leaseIds...> --agent ${agent} --compact\`.
- Before compact/clear or a provider switch, checkpoint completed work, actual checks, blockers and next step. Use only compaction controls supported by the current provider; a new session is the portable fallback. In the receiving session run \`agent-bridge task resume --task <taskId> --session <sessionId> --agent ${agent} --revision <checkpointRevision>\`, then retrieve only the prior details needed to continue. For cross-agent handoff use \`agent-bridge handoff inspect\` with those same arguments. Reconcile reported source/state changes before editing; the previous owner releases its own claim/leases and the receiver claims the same task and acquires write leases. Run completion is not task acceptance.
- For managed tasks, choose checks with \`agent-bridge task check-plan --task <taskId> --files <paths...> --rules <rules.json>\`; run the related checks first and record a dependency, failure or repository-rule reason before expanding. Reuse passing evidence only while its source hashes and contract remain valid. Collect actual command evidence through checkpoint --run-test; an agent exit code is not a quality check.
- Before the first managed attempt set \`agent-bridge task attempt policy --task <taskId> --session <sessionId> --kind <small|debug|multi|handoff>\`. Begin each attempt with task attempt begin, recording operation and hypothesis. Checkpoint actual evidence, blockers and next step before task attempt end. On repeated failure or an attempt/token/time limit choose change_direction, escalate or blocked; preserve acceptance and never retry the same operation indefinitely. Missing provider usage stays null.
- Before managed completion, review acceptance, diff, actual checks and limitations, then submit \`agent-bridge task review --task <taskId> --session <ownerSession> --file <review.json>\` with pass/rework/blocked, reason, diffRef, limitations, reviewerSession and current checkpointId. Use an independent reviewer session for multiple scopes or complex work. Rework stays on the same task; completion requires a current passing verdict and all required evidence.
- Run relevant checks after changes; repeat only after further changes or failures. Commit meaningful verified changes according to repository/user rules, staging only your files.
- Save durable decisions without repeating each turn. Repository Memory must go through Inbox unless the user requests direct persistence. Report results and blockers.
- Keep output concise. Put disposable artifacts in system temp; remove only artifacts created for this task before finishing. Preserve user files and unrelated changes.
- If an action is permission-blocked, use available escalation for that exact action; if escalation is unavailable/rejected, report the blocker without claiming completion.

${orchestratedRunSection()}`;
}
