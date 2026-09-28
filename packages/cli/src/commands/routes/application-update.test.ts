import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationUpdateProgress,
  ApplicationUpdateStatus,
} from "../../application-update.js";
import type { RouteContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  readProgress: vi.fn(),
  startUpdate: vi.fn(),
}));

vi.mock("../../application-update.js", () => ({
  getApplicationUpdateStatus: mocks.getStatus,
  readApplicationUpdateProgress: mocks.readProgress,
  startApplicationUpdate: mocks.startUpdate,
}));

import {
  routeGetApplicationUpdateProgress,
  routeGetApplicationUpdateStatus,
  routePostApplicationUpdateApply,
  sanitizeApplicationUpdateProgress,
} from "./application-update.js";

function status(
  state: ApplicationUpdateStatus["state"],
  overrides: Partial<ApplicationUpdateStatus> = {},
): ApplicationUpdateStatus {
  return {
    installationMode: "git-source",
    state,
    currentVersion: "0.1.0",
    canApply: state === "available",
    ...overrides,
  };
}

function context(path: string, cwd = "D:/workspace", port = 4783) {
  let responseStatus = 0;
  let responseBody = "";
  const res = {
    writeHead(code: number) {
      responseStatus = code;
      return this;
    },
    end(body?: string) {
      responseBody = body ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  const ctx: RouteContext = {
    req: {} as IncomingMessage,
    res,
    url: parse(path, true),
    method: path.includes("apply") ? "POST" : "GET",
    cwd,
    port,
  };
  return {
    ctx,
    result: () => ({ status: responseStatus, body: JSON.parse(responseBody) as unknown }),
  };
}

describe("application update routes", () => {
  it.each([
    status("current"),
    status("available", { latestVersion: "0.2.0", latestTag: "v0.2.0" }),
    status("dirty", { canApply: false, reason: "Working tree is dirty." }),
    status("offline", { canApply: false, reason: "Remote fetch failed." }),
  ])("returns status payload for $state", async (payload) => {
    mocks.getStatus.mockResolvedValueOnce(payload);
    const call = context("/api/update/status?refresh=1");
    await routeGetApplicationUpdateStatus(call.ctx);
    expect(mocks.getStatus).toHaveBeenLastCalledWith({ force: true });
    expect(call.result()).toEqual({ status: 200, body: payload });
  });

  it("returns 202 and starts the worker with the active UI workspace and port", async () => {
    const started = {
      id: "update-1",
      status: status("updating", { canApply: false }),
      progress: { id: "update-1", state: "starting", step: "Starting" },
    };
    mocks.startUpdate.mockResolvedValueOnce(started);
    const call = context("/api/update/apply", "D:/my-workspace", 5111);
    await routePostApplicationUpdateApply(call.ctx);
    expect(mocks.startUpdate).toHaveBeenLastCalledWith({
      workspace: "D:/my-workspace",
      port: 5111,
      uiPid: process.pid,
    });
    expect(call.result()).toEqual({ status: 202, body: started });
  });

  it.each([
    status("dirty", { canApply: false, reason: "Working tree is dirty." }),
    status("diverged", { canApply: false, reason: "Checkout cannot fast-forward." }),
    status("available", { canApply: false, reason: "An active agent run blocks update." }),
  ])("returns 409 when apply is blocked: $state", async (payload) => {
    const error = Object.assign(new Error(payload.reason), { status: payload });
    mocks.startUpdate.mockRejectedValueOnce(error);
    const call = context("/api/update/apply");
    await routePostApplicationUpdateApply(call.ctx);
    expect(call.result()).toEqual({ status: 409, body: payload });
  });

  it("sanitizes progress log paths before returning them", () => {
    const base = {
      id: "update-1",
      state: "building",
      step: "Build",
    } as ApplicationUpdateProgress;
    expect(
      sanitizeApplicationUpdateProgress({ ...base, logFile: ".agent-memory/update/update-1.log" }),
    ).toMatchObject({ logFile: ".agent-memory/update/update-1.log" });
    expect(
      sanitizeApplicationUpdateProgress({ ...base, logFile: "D:/secret/update.log" }),
    ).toMatchObject({ logFile: undefined });

    mocks.readProgress.mockReturnValueOnce({ ...base, logFile: "../../secret.log" });
    const call = context("/api/update/progress");
    routeGetApplicationUpdateProgress(call.ctx);
    expect(call.result()).toEqual({
      status: 200,
      body: { progress: { ...base, logFile: undefined } },
    });
  });
});
