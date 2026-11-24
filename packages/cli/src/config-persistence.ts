import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mergeState, WorkspaceStateStore, type StateObject } from "@agent-bridge/memory";
import type { BridgeConfig } from "./workspace-config.js";

const snapshot = Symbol("configSnapshot");
const runtimeKeys = new Set(["currentTaskId", "currentTasks", "currentSessions", "activeSessions", "sessionTasks",
  "terminalNativeSessions", "sessionWindows", "pendingNewTasks", "deletedSessionIds"]);
type ConfigSnapshot = BridgeConfig & { [snapshot]?: { base: StateObject; runtimeRevision: number } };

function split(config: StateObject) {
  const stable: StateObject = {};
  const runtime: StateObject = {};
  for (const [key, value] of Object.entries(config)) (runtimeKeys.has(key) ? runtime : stable)[key] = value;
  const workflow = stable.workflow as StateObject | undefined;
  if (workflow && "promotedSessions" in workflow) {
    runtime.workflow = { promotedSessions: workflow.promotedSessions };
    stable.workflow = Object.fromEntries(Object.entries(workflow).filter(([key]) => key !== "promotedSessions"));
  }
  return { stable, runtime };
}

function combine(stable: StateObject, runtime: StateObject): StateObject {
  return { ...stable, ...runtime, ...(stable.workflow || runtime.workflow ? { workflow: {
    ...(stable.workflow as StateObject ?? {}), ...(runtime.workflow as StateObject ?? {}),
  } } : {}) };
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, value, { encoding: "utf8", flag: "wx", flush: true }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function openWorkspaceState(cwd: string): WorkspaceStateStore {
  const directory = join(cwd, ".agent-memory");
  mkdirSync(directory, { recursive: true });
  return new WorkspaceStateStore(join(directory, "runtime.db"));
}

function importRuntime(store: WorkspaceStateStore, path: string, legacy: StateObject): void {
  const backup = `${path}.runtime-import.backup`;
  if (existsSync(path) && !existsSync(backup)) {
    try { writeFileSync(backup, readFileSync(path), { flag: "wx", flush: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  store.initialize(split(legacy).runtime);
}

export function readPersistedConfig(cwd: string, defaults: BridgeConfig): BridgeConfig {
  const path = join(cwd, ".agent-memory", "config.json");
  if (!existsSync(path)) return defaults;
  const store = openWorkspaceState(cwd);
  try {
    return store.transaction(() => {
      const legacy = JSON.parse(readFileSync(path, "utf8")) as StateObject;
      importRuntime(store, path, legacy);
      const runtime = store.read();
      const result = combine(split(legacy).stable, runtime.state) as ConfigSnapshot;
      result[snapshot] = { base: JSON.parse(JSON.stringify(result)), runtimeRevision: runtime.revision };
      return result;
    });
  } finally { store.close(); }
}

export function writePersistedConfig(cwd: string, desired: BridgeConfig): void {
  const path = join(cwd, ".agent-memory", "config.json");
  const store = openWorkspaceState(cwd);
  try {
    store.transaction(() => {
      const legacy = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as StateObject : desired as StateObject;
      importRuntime(store, path, legacy);
      const runtime = store.read();
      const latest = combine(split(legacy).stable, runtime.state);
      const base = (desired as ConfigSnapshot)[snapshot]?.base ?? latest;
      const merged = mergeState(base, desired, latest) as StateObject;
      const parts = split(merged);
      if (JSON.stringify(parts.runtime) !== JSON.stringify(runtime.state)) store.write(parts.runtime);
      const text = `${JSON.stringify(parts.stable, null, 2)}\n`;
      if (!existsSync(path) || readFileSync(path, "utf8") !== text) atomicWrite(path, text);
    });
  } finally { store.close(); }
}

export function configRuntimeRevision(config: BridgeConfig): number {
  const value = (config as ConfigSnapshot)[snapshot];
  if (!value) throw new Error("Config snapshot is required for context publication");
  return value.runtimeRevision;
}
