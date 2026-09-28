import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const updateRoutes = vi.hoisted(() => ({
  status: vi.fn(() => {
    throw new Error("simulated updater failure");
  }),
  apply: vi.fn(() => {
    throw new Error("simulated updater failure");
  }),
  progress: vi.fn(() => {
    throw new Error("simulated updater failure");
  }),
}));

vi.mock("./routes/application-update.js", () => ({
  routeGetApplicationUpdateStatus: updateRoutes.status,
  routePostApplicationUpdateApply: updateRoutes.apply,
  routeGetApplicationUpdateProgress: updateRoutes.progress,
}));

import { prepareUiWorkspace, serveRequest } from "./ui.js";
import { callRoute } from "./ui-route-harness.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.clearAllMocks();
});

describe("update route isolation", () => {
  it("keeps /api/state independent from updater failures", async () => {
    root = mkdtempSync(join(tmpdir(), "agent-bridge-update-isolation-"));
    prepareUiWorkspace(root);

    const response = await callRoute(serveRequest, "GET", "/api/state");

    expect(response.status).toBe(200);
    expect(updateRoutes.status).not.toHaveBeenCalled();
    expect(updateRoutes.apply).not.toHaveBeenCalled();
    expect(updateRoutes.progress).not.toHaveBeenCalled();
  });
});
