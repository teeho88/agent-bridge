import { callRoute } from "../commands/ui-route-harness.js";
import { dispatchUiRequest } from "../commands/ui.js";
import type { Action } from "./actions.js";

export type Data = Record<string, unknown>;
export function object(value: unknown): Data {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}
export function array(value: unknown): Data[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export async function request(project: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await callRoute((req, res) => dispatchUiRequest(project, req, res), method, path, body);
  const data: unknown = response.json();
  if (response.status >= 400) {
    const detail = object(data);
    throw new Error(String(detail.error ?? detail.reason ?? detail.state ?? `Action failed (${response.status})`));
  }
  return data;
}

export function performAction(project: string, action: Action, values: Data): Promise<unknown> {
  if (action.method === "GET") {
    const query = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]));
    return request(project, "GET", `${action.path}?${query}`);
  }
  return request(project, "POST", action.path, values);
}

export async function loadDashboard(project: string, taskId?: string, loadedState?: Data): Promise<{ state: Data; board: Data }> {
  const state = loadedState ?? object(await request(project, "GET", `/api/state/details${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`));
  if (state.dbError) throw new Error(String(state.dbError));
  const board = object(await request(project, "GET", `/api/workforce/board?runs=all${taskId ? `&task=${encodeURIComponent(taskId)}` : ""}`));
  return { state, board };
}

export async function loadGraph(project: string, focus = "", limit = 120): Promise<Data> {
  return object(await request(project, "GET", `/api/graph?${new URLSearchParams({ focus, limit: String(limit) })}`));
}
