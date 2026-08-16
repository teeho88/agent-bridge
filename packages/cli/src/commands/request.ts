import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import type { AgentInvocation } from "@agent-bridge/adapters";
import { chatOpenAICompatible, resolveOpenAICompatibleConfig } from "@agent-bridge/adapters";
import type { AgentKind, AgentRequest, AgentRequestStatus, AgentRequestType, Assignment } from "@agent-bridge/memory";
import { getActiveTaskId, openStore, redactIfEnabled } from "../workspace.js";

export type ExecuteSpawnRequestResult = {
  status: "dry-run" | "approved" | "done" | "failed";
  request: AgentRequest;
  assignment?: Assignment;
  preview?: AgentInvocation;
  summary: string;
};

type SpawnApprovalPayload = {
  assignmentId?: string;
  dispatchRunId?: string;
  promptArtifactPath?: string;
  preview?: AgentInvocation;
};

type ExecuteSpawnRequestOptions = {
  dryRun?: boolean;
  timeoutMs?: number;
  json?: boolean;
  credentialLookup?: (envName: string) => string | undefined;
  fetchImpl?: typeof fetch;
};

export function registerRequest(program: Command): void {
  const request = program.command("request").description("Manage agent approval/request inbox");

  request
    .command("create")
    .description("Create an agent request")
    .argument("<title>", "request title")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .option("--type <type>", "approval | command | merge | question", "question")
    .option("--agent <agent>", "agent source", "codex")
    .option("--session <sessionId>", "session id")
    .option("--payload <jsonOrText>", "request payload")
    .action((title: string, options: { task?: string; type: string; agent: AgentKind; session?: string; payload?: string }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.agent);
        const created = store.createAgentRequest({
          taskId,
          type: parseRequestType(options.type),
          agent: options.agent,
          sessionId: options.session,
          title,
          payload: options.payload
        });
        store.recordSessionEvent({
          sessionId: options.session ?? `${options.agent}-request`,
          taskId,
          agent: options.agent,
          kind: "request_created",
          summary: title
        });
        console.log(JSON.stringify(created, null, 2));
      } finally {
        store.close();
      }
    });

  request
    .command("list")
    .description("List agent requests")
    .option("--task <taskId>", "task id")
    .option("--status <status>", "pending | accepted | rejected | resolved")
    .action((options: { task?: string; status?: string }) => {
      const store = openStore();
      try {
        console.log(JSON.stringify(store.listAgentRequests({
          taskId: options.task,
          status: options.status ? parseRequestStatus(options.status) : undefined,
          limit: 200
        }), null, 2));
      } finally {
        store.close();
      }
    });

  request
    .command("resolve")
    .description("Resolve an agent request")
    .argument("<requestId>", "request id")
    .option("--status <status>", "accepted | rejected | resolved", "resolved")
    .option("--response <text>", "human response")
    .action((requestId: string, options: { status: string; response?: string }) => {
      const store = openStore();
      try {
        const resolved = store.resolveAgentRequest(requestId, parseRequestStatus(options.status), options.response);
        if (!resolved) throw new Error(`Request not found: ${requestId}`);
        store.recordSessionEvent({
          sessionId: resolved.sessionId ?? `${resolved.agent ?? "generic"}-request`,
          taskId: resolved.taskId,
          agent: resolved.agent,
          kind: "request_resolved",
          summary: `${resolved.title}: ${resolved.status}`
        });
        console.log(JSON.stringify(resolved, null, 2));
      } finally {
        store.close();
      }
    });

  request
    .command("delete")
    .description("Delete a request from the inbox (no history is kept, unlike resolve)")
    .argument("<requestId>", "request id")
    .action((requestId: string) => {
      const store = openStore();
      try {
        console.log(JSON.stringify({ deleted: store.deleteAgentRequest(requestId) }, null, 2));
      } finally {
        store.close();
      }
    });

  request
    .command("clear")
    .description("Delete every request matching the given filters (defaults to all pending requests)")
    .option("--task <taskId>", "task id")
    .option("--status <status>", "pending | accepted | rejected | resolved", "pending")
    .action((options: { task?: string; status?: string }) => {
      const store = openStore();
      try {
        const matches = store.listAgentRequests({
          taskId: options.task,
          status: options.status ? parseRequestStatus(options.status) : undefined,
          limit: 1000,
        });
        const deleted = store.deleteAgentRequests(matches.map((request) => request.id));
        console.log(JSON.stringify({ deleted }, null, 2));
      } finally {
        store.close();
      }
    });

  request
    .command("execute")
    .description("Execute an accepted spawn approval request")
    .argument("<requestId>", "request id")
    .option("--dry-run", "print the execution plan without updating assignment state")
    .option("--json", "request JSON object output from API-mode providers")
    .option("--timeout-ms <ms>", "CLI execution timeout", "300000")
    .action(async (requestId: string, options: { dryRun?: boolean; json?: boolean; timeoutMs: string }) => {
      const store = openStore();
      try {
        const result = await executeSpawnRequest(store, requestId, {
          dryRun: Boolean(options.dryRun),
          json: Boolean(options.json),
          timeoutMs: Number(options.timeoutMs),
        });
        console.log(JSON.stringify(result, null, 2));
      } finally {
        store.close();
      }
    });
}

export async function executeSpawnRequest(
  store: ReturnType<typeof openStore>,
  requestId: string,
  options: ExecuteSpawnRequestOptions = {},
): Promise<ExecuteSpawnRequestResult> {
  const request = findRequest(store.listAgentRequests({ limit: 500 }), requestId);
  if (!request) throw new Error(`Request not found: ${requestId}`);
  if (request.type !== "approval") throw new Error(`Request is not an approval request: ${requestId}`);

  const payload = parseSpawnPayload(request.payload);
  if (!payload.assignmentId) throw new Error(`Request payload missing assignmentId: ${requestId}`);
  const assignment = findAssignment(store.listAssignments({ taskId: request.taskId, limit: 500 }), payload.assignmentId);
  if (!assignment) throw new Error(`Assignment not found: ${payload.assignmentId}`);
  const preview = payload.preview;
  if (!preview) throw new Error(`Request payload missing spawn preview: ${requestId}`);

  if (options.dryRun) return { status: "dry-run", request, assignment, preview, summary: preview.description };
  if (request.status !== "accepted") throw new Error(`Request must be accepted before execution: ${requestId}`);

  if (preview.mode === "api") return executeApiSpawn(store, request, assignment, preview, options);
  if (preview.mode !== "cli" || !preview.executable) {
    const summary = `Approved ${preview.mode} spawn for ${preview.agentName}; execution is waiting for a provider adapter or manual runner.`;
    const updated = store.updateAssignment(assignment.id, { status: "approved", resultSummary: summary }) ?? assignment;
    store.resolveAgentRequest(request.id, "resolved", summary);
    recordAssignmentOutcome(store, updated, request, summary, "note", ["assignment", "approved"]);
    return { status: "approved", request, assignment: updated, preview, summary };
  }

  store.updateAssignment(assignment.id, { status: "running" });
  if (assignment.subtaskId) store.updateSubtask(assignment.subtaskId, { status: "in_progress" });

  try {
    const output = execFileSync(preview.executable, preview.args ?? [], {
      cwd: preview.cwd || process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: options.timeoutMs ?? 300000,
      windowsHide: true,
      input: preview.stdinFilePath ? readFileSync(preview.stdinFilePath, "utf8") : undefined,
    });
    return recordSuccessfulExecution(store, request, assignment, preview, summarizeOutput(output) || "Command completed without output.");
  } catch (error) {
    return recordFailedExecution(store, request, assignment, preview, summarizeExecutionError(error));
  }
}

async function executeApiSpawn(
  store: ReturnType<typeof openStore>,
  request: AgentRequest,
  assignment: Assignment,
  preview: AgentInvocation,
  options: ExecuteSpawnRequestOptions,
): Promise<ExecuteSpawnRequestResult> {
  const agent = store.getRegisteredAgent(preview.agentId);
  if (!agent) throw new Error(`Registered agent not found: ${preview.agentId}`);
  const credentialLookup = credentialLookupFor(store, agent.credentialRef, options.credentialLookup);
  const config = resolveOpenAICompatibleConfig(agent, { credentialLookup });
  if (!config.ok) {
    const updated = store.updateAssignment(assignment.id, { status: "waiting", resultSummary: config.reason }) ?? assignment;
    store.createAgentRequest({
      taskId: assignment.taskId,
      agent: request.agent,
      type: "question",
      title: config.questionTitle,
      payload: JSON.stringify({ assignmentId: assignment.id, credentialEnv: config.credentialEnv, reason: config.reason }, null, 2),
    });
    return { status: "approved", request, assignment: updated, preview, summary: config.reason };
  }

  store.updateAssignment(assignment.id, { status: "running" });
  if (assignment.subtaskId) store.updateSubtask(assignment.subtaskId, { status: "in_progress" });
  try {
    const prompt = preview.promptArtifactPath && existsSync(preview.promptArtifactPath)
      ? readFileSync(preview.promptArtifactPath, "utf8")
      : assignment.prompt;
    const result = await chatOpenAICompatible(agent, [{ role: "user", content: prompt }], {
      credentialLookup,
      fetchImpl: options.fetchImpl,
      json: options.json,
    });
    return recordSuccessfulExecution(store, request, assignment, preview, result.content);
  } catch (error) {
    return recordFailedExecution(store, request, assignment, preview, summarizeExecutionError(error));
  }
}

function parseRequestType(value: string): AgentRequestType {
  const allowed: AgentRequestType[] = ["approval", "command", "merge", "question"];
  if (allowed.includes(value as AgentRequestType)) return value as AgentRequestType;
  throw new Error(`Invalid request type "${value}". Use one of: ${allowed.join(", ")}.`);
}

function parseRequestStatus(value: string): AgentRequestStatus {
  const allowed: AgentRequestStatus[] = ["pending", "accepted", "rejected", "resolved"];
  if (allowed.includes(value as AgentRequestStatus)) return value as AgentRequestStatus;
  throw new Error(`Invalid request status "${value}". Use one of: ${allowed.join(", ")}.`);
}

function parseSpawnPayload(payload: string | undefined): SpawnApprovalPayload {
  if (!payload) throw new Error("Request payload is empty.");
  return JSON.parse(payload) as SpawnApprovalPayload;
}

function findRequest(requests: AgentRequest[], requestId: string): AgentRequest | undefined {
  return requests.find((request) => request.id === requestId);
}

function findAssignment(assignments: Assignment[], assignmentId: string): Assignment | undefined {
  return assignments.find((assignment) => assignment.id === assignmentId);
}

function summarizeOutput(output: string): string {
  return output.trim().replace(/\s+/g, " ").slice(0, 1000);
}

function summarizeExecutionError(error: unknown): string {
  if (typeof error === "object" && error) {
    const maybe = error as { message?: string; status?: number; stdout?: unknown; stderr?: unknown };
    const parts = [
      maybe.status === undefined ? undefined : `exit ${maybe.status}`,
      typeof maybe.stderr === "string" ? maybe.stderr.trim() : undefined,
      typeof maybe.stdout === "string" ? maybe.stdout.trim() : undefined,
      maybe.message,
    ].filter(Boolean);
    return summarizeOutput(parts.join(" ")) || "Command failed.";
  }
  return String(error || "Command failed.").slice(0, 1000);
}

function recordSuccessfulExecution(
  store: ReturnType<typeof openStore>,
  request: AgentRequest,
  assignment: Assignment,
  preview: AgentInvocation,
  summary: string,
): ExecuteSpawnRequestResult {
  const updated = store.updateAssignment(assignment.id, { status: "done", resultSummary: summary }) ?? assignment;
  if (assignment.subtaskId) store.updateSubtask(assignment.subtaskId, { status: "done" });
  store.resolveAgentRequest(request.id, "resolved", `Executed approved spawn: ${summary}`);
  recordAssignmentOutcome(store, updated, request, `Assignment completed: ${summary}`, "note", ["assignment", "done"]);
  return { status: "done", request, assignment: updated, preview, summary };
}

function recordFailedExecution(
  store: ReturnType<typeof openStore>,
  request: AgentRequest,
  assignment: Assignment,
  preview: AgentInvocation,
  summary: string,
): ExecuteSpawnRequestResult {
  const updated = store.updateAssignment(assignment.id, { status: "failed", resultSummary: summary }) ?? assignment;
  if (assignment.subtaskId) store.updateSubtask(assignment.subtaskId, { status: "blocked" });
  store.resolveAgentRequest(request.id, "resolved", `Approved spawn failed: ${summary}`);
  recordAssignmentOutcome(store, updated, request, `Assignment failed: ${summary}`, "bug", ["assignment", "failed"]);
  return { status: "failed", request, assignment: updated, preview, summary };
}

function recordAssignmentOutcome(
  store: ReturnType<typeof openStore>,
  assignment: Assignment,
  request: AgentRequest,
  content: string,
  type: "note" | "bug",
  tags: string[],
): void {
  const safeContent = redactIfEnabled(content);
  store.addMemory({
    taskId: assignment.taskId,
    type,
    content: safeContent,
    importance: 4,
    tags,
    sourceAgent: request.agent,
    dedupe: false,
  });
  store.upsertTaskHandoff({
    taskId: assignment.taskId,
    fromAgent: request.agent,
    summary: safeContent,
    done: [safeContent],
    next: [assignment.status === "done" ? "Review assignment result and merge if appropriate." : "Inspect assignment failure before retrying."],
  });
  store.recordSessionEvent({
    sessionId: request.sessionId ?? `${request.agent ?? "generic"}-request`,
    taskId: assignment.taskId,
    agent: request.agent,
    kind: "assistant_summary",
    summary: safeContent,
  });
}

function credentialLookupFor(
  store: ReturnType<typeof openStore>,
  credentialRef: string | undefined,
  override: ((envName: string) => string | undefined) | undefined,
): (envName: string) => string | undefined {
  return (envName: string) => {
    if (override) return override(envName);
    const credential = credentialRef
      ? store.listCredentialRefs().find((item) => item.id === credentialRef || item.ref === credentialRef)
      : undefined;
    if (credential?.kind === "env" && (envName === credential.id || envName === credential.ref || envName === credentialRef)) {
      return process.env[credential.ref];
    }
    return process.env[envName];
  };
}

