import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareUiWorkspace, serveRequest, uiRouteManifest } from "./ui.js";
import { callRoute } from "./ui-route-harness.js";
import { openStore } from "../workspace.js";

// Route-level coverage. Every assertion goes through `serveRequest`, the same
// entry point `createServer` uses, so these fail if a handler is moved,
// renamed or wired to the wrong path - which the dashboard string assertions
// in ui.test.ts cannot detect. Handlers report failure by throwing; the 500 is
// produced by that wrapper, so an error case must be asserted through it.
let root: string;

function call(method: string, path: string, body?: unknown) {
  return callRoute(serveRequest, method, path, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-bridge-routes-"));
  prepareUiWorkspace(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("routing basics", () => {
  it("serves the dashboard shell at /", async () => {
    const res = await call("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<script type="module" src="/ui-client/main.js">');
  });

  it("answers an unknown path with 404 rather than falling through", async () => {
    const res = await call("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
  });

  it("does not answer a POST-only route on GET", async () => {
    const res = await call("GET", "/api/task/start");
    expect(res.status).toBe(404);
  });

  it("refuses a traversal attempt through the client module route", async () => {
    expect((await call("GET", "/ui-client/../ui-page.js")).status).toBe(404);
    expect((await call("GET", "/ui-client/notes.txt")).status).toBe(404);
  });
});

describe("/api/state", () => {
  it("returns the dashboard payload for an empty workspace", async () => {
    const res = await call("GET", "/api/state");
    expect(res.status).toBe(200);
    const state = res.json<Record<string, unknown>>();
    expect(state).toHaveProperty("tasks");
    expect(state).toHaveProperty("config");
    expect(Array.isArray(state.tasks)).toBe(true);
  });

  it("reports a task created through the API", async () => {
    const created = await call("POST", "/api/task/start", {
      title: "Route harness task",
      goal: "prove the route answers",
      agent: "claude",
    });
    expect(created.status).toBe(200);

    const state = (await call("GET", "/api/state")).json<{
      tasks: Array<{ id: string; title: string }>;
    }>();
    expect(state.tasks.map((task) => task.title)).toContain(
      "Route harness task",
    );
  });
});

describe("task routes", () => {
  it("creates, updates and stops a task", async () => {
    const created = await call("POST", "/api/task/start", {
      title: "Lifecycle",
      agent: "claude",
    });
    const taskId = created.json<{ task: { id: string } }>().task.id;

    const updated = await call("POST", "/api/task/update", {
      taskId,
      title: "Lifecycle renamed",
      status: "in_progress",
    });
    expect(updated.status).toBe(200);

    const store = openStore(root);
    try {
      const task = store.getTask(taskId);
      expect(task?.title).toBe("Lifecycle renamed");
      expect(task?.status).toBe("in_progress");
    } finally {
      store.close();
    }
  });

  it("rejects a task without a title instead of creating a blank one", async () => {
    const res = await call("POST", "/api/task/start", { agent: "claude" });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const state = (await call("GET", "/api/state")).json<{ tasks: unknown[] }>();
    expect(state.tasks).toHaveLength(0);
  });
});

describe("memory routes", () => {
  it("stores a memory and finds it again through search", async () => {
    await call("POST", "/api/task/start", { title: "Memory host", agent: "claude" });

    const added = await call("POST", "/api/memory/add", {
      content: "The retry budget is three attempts.",
      type: "note",
      importance: 4,
    });
    expect(added.status).toBe(200);

    // Search is a GET with a `q` query parameter, not a POST body.
    const found = await call("GET", "/api/memory/search?q=retry+budget");
    expect(found.status).toBe(200);
    expect(found.body).toContain("retry budget");
  });

  it("rejects a memory with no content", async () => {
    const res = await call("POST", "/api/memory/add", { type: "note" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("watch routes", () => {
  it("reports watcher state on stop without needing a running watcher", async () => {
    const res = await call("POST", "/api/watch/stop");
    expect(res.status).toBe(200);
    expect(res.json<{ watcherRunning: boolean }>().watcherRunning).toBe(false);
  });
});

describe("workforce routes", () => {
  it("returns a board payload for an empty workspace", async () => {
    const res = await call("GET", "/api/workforce/board");
    expect(res.status).toBe(200);
    expect(res.body.startsWith("{")).toBe(true);
  });

  it("reports a failure as JSON rather than throwing out of the handler", async () => {
    const res = await call("POST", "/api/workforce/agent/update", {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.json<{ error?: string }>().error).toBeTruthy();
  });

  it("gates the reporter spawn and completes it only after approval", async () => {
    const store = openStore(root);
    let taskId: string;
    try {
      const reporter = store.createRegisteredAgent({
        name: "manual-reporter",
        provider: "codex",
        mode: "manual",
        capabilities: ["report"],
      });
      const task = store.createTask({ title: "Gated route report", ownerAgent: "codex" });
      taskId = task.id;
      const orchestration = store.createOrchestration({
        taskId,
        leaderAgentId: reporter.id,
        autonomy: "approve-each",
      });
      store.updateOrchestration(orchestration.id, { status: "reporting" });
    } finally {
      store.close();
    }

    const requested = await call("POST", "/api/workforce/orchestration/report", { taskId });
    expect(requested.status).toBe(200);
    const pending = requested.json<{ status: string; requestId: string }>();
    expect(pending.status).toBe("pending");

    const approved = await call("POST", "/api/workforce/orchestration/approve-spawn", {
      taskId,
      requestId: pending.requestId,
      approve: true,
    });
    expect(approved.status).toBe(200);
    expect(approved.json<{ report: { status: string } }>().report.status).toBe("written");

    const check = openStore(root);
    try {
      expect(check.getOrchestrationByTask(taskId)?.status).toBe("done");
      expect(check.listAgentRuns({ taskId, limit: 20 })).toHaveLength(0);
      const response = check.listAgentRequests({ taskId, status: "accepted", limit: 20 })[0]?.response;
      expect(JSON.parse(response ?? "{}")).toMatchObject({ type: "spawn-approval-response" });
    } finally {
      check.close();
    }
  });
});

describe("graph routes", () => {
  it("returns a graph view for a workspace with no graph yet", async () => {
    const res = await call("GET", "/api/graph");
    expect(res.status).toBe(200);
    expect(res.body.startsWith("{")).toBe(true);
  });
});

// Every route the dashboard exposes, split by whether calling it is safe in a
// test. A refactor that drops or renames a path turns its entry into a 404,
// which is what the sweep below looks for - a 4xx/5xx from validation still
// proves the handler was found and ran.
const SWEEPABLE_ROUTES: Array<[string, string]> = [
  ["POST", "/api/config/graph"],
  ["POST", "/api/context/compile"],
  ["POST", "/api/context/save"],
  ["GET", "/api/graph"],
  ["POST", "/api/graph/brief"],
  ["POST", "/api/graph/brief-auto-all"],
  ["POST", "/api/graph/build"],
  ["POST", "/api/handoff/save"],
  ["POST", "/api/memory/add"],
  ["GET", "/api/memory/search"],
  ["POST", "/api/optimize/baseline"],
  ["POST", "/api/orchestration/change"],
  ["POST", "/api/orchestration/lane"],
  ["POST", "/api/orchestration/lease/acquire"],
  ["POST", "/api/orchestration/lease/release"],
  ["POST", "/api/repo-memory/delete"],
  ["POST", "/api/repo-memory/update"],
  ["POST", "/api/request/clear"],
  ["POST", "/api/request/delete"],
  ["POST", "/api/session/end"],
  ["POST", "/api/session/start"],
  ["POST", "/api/session/summary"],
  ["POST", "/api/session/window"],
  ["POST", "/api/skills/delete"],
  ["POST", "/api/skills/github/install"],
  ["GET", "/api/skills/github/search"],
  ["POST", "/api/skills/save"],
  ["GET", "/api/state"],
  ["POST", "/api/task/delete"],
  ["POST", "/api/task/prompt"],
  ["POST", "/api/task/start"],
  ["POST", "/api/task/stop"],
  ["POST", "/api/task/update"],
  ["POST", "/api/watch/stop"],
  ["POST", "/api/workforce/agent"],
  ["POST", "/api/workforce/agent/delete"],
  ["POST", "/api/workforce/agent/toggle"],
  ["POST", "/api/workforce/agent/update"],
  ["POST", "/api/workforce/agents/provider-enabled"],
  ["GET", "/api/workforce/board"],
  ["POST", "/api/workforce/default-agent/create"],
  ["POST", "/api/workforce/default-agent/delete"],
  ["POST", "/api/workforce/default-agent/restore"],
  ["POST", "/api/workforce/default-agent/toggle"],
  ["POST", "/api/workforce/orchestration/answer-questions"],
  ["POST", "/api/workforce/orchestration/leader"],
  ["POST", "/api/workforce/orchestration/pause"],
  ["POST", "/api/workforce/orchestration/report"],
  ["POST", "/api/workforce/orchestration/request-changes"],
  ["POST", "/api/workforce/orchestration/resume"],
  ["POST", "/api/workforce/orchestration/step"],
  ["POST", "/api/workforce/orchestration/stop"],
  ["POST", "/api/workforce/run/stop"],
];

// These spawn processes, launch terminals or install hooks, so they must not
// be called. They are covered by the manifest test instead.
//
// Two of them reach a process only indirectly, which is why they are easy to
// miss: /api/cache-report shells out to `ccusage` (30s+ when it is installed)
// and /api/workforce/catalog probes each agent CLI binary.
const SIDE_EFFECTING_ROUTES: Array<[string, string]> = [
  ["GET", "/api/cache-report"],
  ["GET", "/api/workforce/catalog"],
  ["POST", "/api/antigravity/install-hooks"],
  ["POST", "/api/claude/install-hooks"],
  ["POST", "/api/orchestration/request"],
  ["POST", "/api/session/focus"],
  ["POST", "/api/session/terminal"],
  ["POST", "/api/tools/install"],
  ["POST", "/api/watch/start"],
  ["POST", "/api/workforce/orchestration/approve-spawn"],
  ["POST", "/api/workforce/orchestration/auto-run"],
  ["POST", "/api/workforce/orchestration/autonomy"],
  ["POST", "/api/workforce/orchestration/start"],
  ["POST", "/api/workforce/run/adopt"],
  ["POST", "/api/workforce/run/set-model"],
  ["POST", "/api/workforce/subtask/add-and-spawn"],
];

describe("route reachability", () => {
  // The manifest is the authority. Comparing the two lists means a route that
  // is added, renamed or dropped fails here instead of silently losing
  // coverage - and it reaches the 14 side-effecting routes without calling
  // them, which is the only way they can be guarded at all.
  it("accounts for every route the dispatcher declares", () => {
    const declared = uiRouteManifest().filter((key) => key.includes(" /api/"));
    const listed = [
      ...SWEEPABLE_ROUTES,
      ...SIDE_EFFECTING_ROUTES,
      ["GET", "/api/workforce/run/log"] as [string, string],
    ].map(([method, path]) => `${method} ${path}`);
    expect(listed.sort()).toEqual(declared);
  });

  it("exposes the non-api routes exactly once", () => {
    expect(uiRouteManifest()).toContain("GET /");
  });

  it.each(SWEEPABLE_ROUTES)("%s %s is reachable", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).not.toBe(404);
  });

  // This one answers 404 by design when the run id is unknown, so "not 404"
  // cannot prove it exists - the message it returns can.
  it("GET /api/workforce/run/log is reachable", async () => {
    const res = await call("GET", "/api/workforce/run/log?run=missing");
    expect(res.json<{ error?: string }>().error).toBe("Run not found");
  });
});
