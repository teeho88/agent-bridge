import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInvocation } from "@agent-bridge/adapters";
import { openStore } from "../workspace.js";
import { executeSpawnRequest } from "./request.js";

async function withStore<T>(fn: (cwd: string, store: ReturnType<typeof openStore>) => T | Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-request-"));
  const store = openStore(cwd);
  try {
    return await fn(cwd, store);
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function createCliSpawnFixture(store: ReturnType<typeof openStore>, cwd: string, args: string[]) {
  const task = store.createTask({ title: "Spawn request", ownerAgent: "codex" });
  const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
  const role = store.createWorkforceRole({ name: "implementer", permissions: ["spawn"] });
  const assignment = store.createAssignment({
    taskId: task.id,
    agentId: agent.id,
    roleId: role.id,
    status: "queued",
    prompt: "Run the approved command.",
  });
  const preview: AgentInvocation = {
    adapter: "generic",
    mode: "cli",
    provider: "generic",
    agentId: agent.id,
    agentName: agent.name,
    executable: process.execPath,
    args,
    command: `${process.execPath} ${args.join(" ")}`,
    description: "Node test spawn preview.",
    promptArtifactPath: join(cwd, "assignment.md"),
    cwd,
  };
  const request = store.createAgentRequest({
    taskId: task.id,
    agent: "codex",
    type: "approval",
    title: "Approve spawn",
    payload: JSON.stringify({ assignmentId: assignment.id, preview }, null, 2),
  });
  return { assignment, request, task };
}

function createApiSpawnFixture(store: ReturnType<typeof openStore>, cwd: string, credentialRef = "DEEPSEEK_API_KEY") {
  const task = store.createTask({ title: "API spawn request", ownerAgent: "codex" });
  const agent = store.createRegisteredAgent({
    name: "deepseek-api",
    provider: "deepseek",
    mode: "api",
    credentialRef,
    capabilities: ["json"],
  });
  const role = store.createWorkforceRole({ name: "tester", permissions: ["spawn", "test"] });
  const assignment = store.createAssignment({
    taskId: task.id,
    agentId: agent.id,
    roleId: role.id,
    status: "queued",
    prompt: "Return a JSON result.",
  });
  const preview: AgentInvocation = {
    adapter: "deepseek",
    mode: "api",
    provider: "deepseek",
    agentId: agent.id,
    agentName: agent.name,
    description: "API test spawn preview.",
    promptArtifactPath: join(cwd, "missing-assignment.md"),
    cwd,
  };
  const request = store.createAgentRequest({
    taskId: task.id,
    agent: "codex",
    type: "approval",
    title: "Approve API spawn",
    payload: JSON.stringify({ assignmentId: assignment.id, preview }, null, 2),
  });
  return { assignment, request, task };
}

describe("executeSpawnRequest", () => {
  it("does not execute pending spawn requests in dry-run mode", () => withStore(async (cwd, store) => {
    const { assignment, request } = createCliSpawnFixture(store, cwd, ["-e", "console.log('ok')"]);

    const result = await executeSpawnRequest(store, request.id, { dryRun: true });

    expect(result.status).toBe("dry-run");
    expect(store.listAssignments({ limit: 10 }).find((item) => item.id === assignment.id)?.status).toBe("queued");
    expect(store.listAgentRequests({ limit: 10 }).find((item) => item.id === request.id)?.status).toBe("pending");
  }));

  it("runs an accepted CLI spawn and records assignment memory and handoff", () => withStore(async (cwd, store) => {
    const { assignment, request, task } = createCliSpawnFixture(store, cwd, ["-e", "console.log('spawn ok')"]);
    store.resolveAgentRequest(request.id, "accepted", "approved");

    const result = await executeSpawnRequest(store, request.id);

    expect(result.status).toBe("done");
    const updated = store.listAssignments({ limit: 10 }).find((item) => item.id === assignment.id);
    expect(updated?.status).toBe("done");
    expect(updated?.resultSummary).toContain("spawn ok");
    expect(store.listMemoriesForTask(task.id, 10)[0]?.content).toContain("Assignment completed");
    expect(store.getLatestHandoff(task.id)?.summary).toContain("Assignment completed");
    expect(store.listAgentRequests({ limit: 10 }).find((item) => item.id === request.id)?.status).toBe("resolved");
  }));

  it("records failed CLI spawn output on the assignment", () => withStore(async (cwd, store) => {
    const { assignment, request } = createCliSpawnFixture(store, cwd, ["-e", "process.stderr.write('spawn failed'); process.exit(7)"]);
    store.resolveAgentRequest(request.id, "accepted", "approved");

    const result = await executeSpawnRequest(store, request.id);

    expect(result.status).toBe("failed");
    const updated = store.listAssignments({ limit: 10 }).find((item) => item.id === assignment.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.resultSummary).toContain("spawn failed");
  }));

  it("runs an accepted API spawn with a mocked OpenAI-compatible response", () => withStore(async (cwd, store) => {
    const { assignment, request } = createApiSpawnFixture(store, cwd);
    store.resolveAgentRequest(request.id, "accepted", "approved");

    const result = await executeSpawnRequest(store, request.id, {
      json: true,
      credentialLookup: () => "sk-test",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string } };
        expect(body.response_format?.type).toBe("json_object");
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200 });
      },
    });

    expect(result.status).toBe("done");
    const updated = store.listAssignments({ limit: 10 }).find((item) => item.id === assignment.id);
    expect(updated?.resultSummary).toBe('{"ok":true}');
  }));

  it("creates a question request when an API credential is missing", () => withStore(async (cwd, store) => {
    const { assignment, request } = createApiSpawnFixture(store, cwd, "MISSING_TEST_API_KEY");
    store.resolveAgentRequest(request.id, "accepted", "approved");

    const result = await executeSpawnRequest(store, request.id, { credentialLookup: () => undefined });

    expect(result.status).toBe("approved");
    expect(store.listAssignments({ limit: 10 }).find((item) => item.id === assignment.id)?.status).toBe("waiting");
    const pending = store.listAgentRequests({ status: "pending", limit: 10 });
    expect(pending.some((item) => item.type === "question" && item.title.includes("Set API credential"))).toBe(true);
  }));
});

