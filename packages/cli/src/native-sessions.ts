import { closeSync, createReadStream, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readHistoryRows } from "@agent-bridge/memory";
import type { BridgeConfig } from "./workspace-config.js";
import { repositoryIdentity } from "./runtime-identity.js";

type Row = Record<string, unknown>;
type Provider = "claude" | "codex" | "antigravity";
export interface NativeSession {
  sessionId: string;
  nativeSessionId: string;
  agent: Provider;
  title: string;
  summary?: string;
  cwd: string;
  createdAt: string;
  lastActivityAt: string;
  kind: string;
  liveness: "running" | "unknown";
  source: "native";
  nativePath?: string;
  historyDatabase?: string;
}
export interface HistoryRoots { claude: string; codex: string; antigravity: string }
export function nativeHistoryRoots(): HistoryRoots {
  return {
    claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    codex: process.env.CODEX_HOME || join(homedir(), ".codex"),
    antigravity: join(homedir(), ".gemini", "antigravity-cli"),
  };
}
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const parsed = (value: string): Row => { try { return object(JSON.parse(value)); } catch { return {}; } };
const files = (path: string): string[] => { try { return readdirSync(path); } catch { return []; } };
const rows = (path: string, sql: string, args: unknown[] = []): Row[] => {
  try { return existsSync(path) ? readHistoryRows(path, sql, args) : []; } catch { return []; }
};
function canonical(path: string): string {
  try { if (path.startsWith("file:")) path = fileURLToPath(path); } catch { return ""; }
  try { path = realpathSync.native(path); } catch {}
  if (/^[a-z]:[\\/]/i.test(path)) return win32.normalize(path).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
export function sessionBelongsToRepository(path: string, repo: string): boolean {
  if (!path || (!path.startsWith("file:") && !isAbsolute(path) && !win32.isAbsolute(path))) return false;
  const candidate = canonical(path), root = canonical(repo);
  return Boolean(candidate && root && (candidate === root || candidate.startsWith(`${root}/`)));
}
function timestamp(value: unknown, fallback: string): string {
  const date = typeof value === "number" ? new Date(value < 100000000000 ? value * 1000 : value) : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => text(object(part).text)).filter(Boolean).join("\n");
  return "";
}
function session(agent: Provider, id: string, cwd: string, title: string, time: string): NativeSession {
  return { sessionId: `native:${agent}:${id}`, nativeSessionId: id, agent, cwd, title: title.trim().split(/\r?\n/)[0].slice(0, 180) || `${agent} session`,
    createdAt: time, lastActivityAt: time, kind: "session_resumed", liveness: "unknown", source: "native" };
}
function sampleLines(path: string): Row[] {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const read = (start: number, length: number) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, readSync(fd!, buffer, 0, length, start)).toString("utf8");
    };
    const head = read(0, Math.min(size, 65536));
    const tail = size > 65536 ? read(Math.max(0, size - 65536), Math.min(size, 65536)).split("\n").slice(1).join("\n") : "";
    return `${head}\n${tail}`.split(/\r?\n/).map(parsed).filter((row) => Object.keys(row).length);
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}
const fileCache = new Map<string, { signature: string; value?: NativeSession }>();
function fromFile(path: string, provider: "claude" | "codex", repo: string): NativeSession | undefined {
  try {
    const stat = statSync(path), signature = `${repo}:${stat.mtimeMs}:${stat.size}`;
    const cached = fileCache.get(path);
    if (cached?.signature === signature) return cached.value;
    const data = sampleLines(path);
    const meta = provider === "codex" ? object(data.find((row) => row.type === "session_meta")?.payload) : data.find((row) => typeof row.cwd === "string");
    let result: NativeSession | undefined;
    if (meta && typeof meta.cwd === "string" && sessionBelongsToRepository(meta.cwd, repo) && !meta.isSidechain &&
      !JSON.stringify(meta.source ?? "").includes("subagent")) {
      const id = String(meta.id ?? meta.session_id ?? meta.sessionId ?? basename(path, ".jsonl"));
      const first = data.find((row) => row.type === "user" && !row.isMeta);
      const title = [...data].reverse().find((row) => row.type === "custom-title" || row.type === "ai-title" || row.type === "summary");
      result = { ...session(provider, id, meta.cwd, String(title?.customTitle ?? title?.aiTitle ?? title?.summary ?? text(object(first?.message).content)), stat.mtime.toISOString()), nativePath: path };
      result.createdAt = timestamp(meta.timestamp, stat.birthtime.toISOString());
    }
    fileCache.set(path, { signature, value: result });
    return result;
  } catch { return undefined; }
}
function claudeSessions(repo: string, root: string): NativeSession[] {
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const projects = join(root, "projects"), result: NativeSession[] = [];
  for (const folder of files(projects)) {
    if (folder.toLowerCase() !== slug && !folder.toLowerCase().startsWith(`${slug}-`)) continue;
    for (const file of files(join(projects, folder))) {
      if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
      const row = fromFile(join(projects, folder, file), "claude", repo);
      if (row) result.push(row);
    }
  }
  return result;
}
function walk(path: string): string[] {
  const result: string[] = [];
  for (const name of files(path)) {
    const full = join(path, name);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) result.push(...walk(full));
      else if (name.endsWith(".jsonl")) result.push(full);
    } catch {}
  }
  return result;
}
function codexSessions(repo: string, root: string): NativeSession[] {
  const result = new Map<string, NativeSession>();
  const indexedIds = new Set<string>();
  const databases = files(root).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
  for (const database of databases) {
    for (const row of rows(join(root, database), "SELECT * FROM threads")) {
      indexedIds.add(String(row.id));
      if (typeof row.cwd !== "string" || !sessionBelongsToRepository(row.cwd, repo) ||
        JSON.stringify(row.source ?? "").includes("subagent") || row.thread_source === "subagent") continue;
      const id = String(row.id);
      if (result.has(id)) continue;
      const updated = timestamp(row.updated_at_ms ?? row.updated_at, new Date(0).toISOString());
      result.set(id, { ...session("codex", id, row.cwd, String(row.title || row.first_user_message || "Codex session"), updated),
        createdAt: timestamp(row.created_at_ms ?? row.created_at, updated), nativePath: typeof row.rollout_path === "string" ? row.rollout_path : undefined,
        historyDatabase: join(root, "thread_history_1.sqlite") });
    }
  }
  for (const directory of ["sessions", "archived_sessions"]) for (const path of walk(join(root, directory))) {
    const id = basename(path).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1];
    if (id && indexedIds.has(id)) continue;
    const item = fromFile(path, "codex", repo);
    if (item) result.set(item.nativeSessionId, item);
  }
  if (process.platform === "win32") for (const item of result.values()) {
    const lock = join(root, "thread-writer-locks", `${item.nativeSessionId}.lock`);
    if (!existsSync(lock)) continue;
    let fd: number | undefined;
    try { fd = openSync(lock, "r"); }
    catch (error) { if (["EBUSY", "EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) item.liveness = "running"; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return [...result.values()];
}
function agySessions(repo: string, root: string): NativeSession[] {
  const result = new Map<string, NativeSession>();
  const database = join(root, "conversation_summaries.db");
  for (const row of rows(database, "SELECT * FROM conversation_summaries")) {
    let paths: unknown;
    try { paths = JSON.parse(String(row.workspace_uris)); } catch { continue; }
    const cwd = Array.isArray(paths) ? paths.find((path) => typeof path === "string" && sessionBelongsToRepository(path, repo)) : undefined;
    if (!cwd || row.parent_conversation_id || Number(row.nesting_depth) > 0) continue;
    const id = String(row.conversation_id), time = timestamp(row.last_modified_time, new Date(0).toISOString());
    result.set(id, { ...session("antigravity", id, cwd, String(row.title || row.preview || "AGY session"), time),
      summary: String(row.preview ?? ""), nativePath: join(root, "conversations", `${id}.db`), historyDatabase: database,
      liveness: !row.killed && (row.not_fully_idle === 1 || /(?:^|_)RUNNING$/.test(String(row.status))) ? "running" : "unknown" });
  }
  try {
    const metadata = object(parsed(readFileSync(join(root, "cache", "conversation_metadata.json"), "utf8")).conversations);
    for (const [id, value] of Object.entries(metadata)) {
      if (result.has(id)) continue;
      const entry = object(value), summary = object(entry.summary), paths = summary.WorkspaceURIs;
      const cwd = Array.isArray(paths) ? paths.find((path) => typeof path === "string" && sessionBelongsToRepository(path, repo)) : undefined;
      if (!cwd || entry.is_internal || summary.Internal || summary.ParentConversationID) continue;
      const time = timestamp(summary.UpdatedAt ?? entry.last_modified_time, new Date(0).toISOString());
      result.set(id, { ...session("antigravity", id, cwd, String(summary.Title || summary.Preview || "AGY session"), time),
        summary: String(summary.Preview ?? ""), nativePath: join(root, "conversations", `${id}.db`), historyDatabase: database });
    }
  } catch {}
  return [...result.values()];
}
export function listNativeSessions(cwd: string, roots = nativeHistoryRoots()): NativeSession[] {
  const repo = repositoryIdentity(cwd).repositoryId;
  return [...claudeSessions(repo, roots.claude), ...codexSessions(repo, roots.codex), ...agySessions(repo, roots.antigravity)]
    .sort((a, b) => Number(b.liveness === "running") - Number(a.liveness === "running") || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}
export function mergeSessionHistory(bridge: Row[], native: NativeSession[], config: BridgeConfig): Row[] {
  const merged = new Map<string, Row>();
  const key = (agent: unknown, id: unknown) => `${agent}:${id}`;
  for (const row of native) merged.set(key(row.agent, row.nativeSessionId), { ...row });
  for (const row of bridge) {
    const id = String(row.sessionId), nativeId = config.terminalNativeSessions?.[id] ?? id.replace(/^native:(?:claude|codex|antigravity):/, "");
    const identity = key(row.agent, nativeId), previous = merged.get(identity);
    const previousIsBridge = previous && previous.source !== "native";
    if (previousIsBridge && (previous.liveness === "running" || Date.parse(String(previous.createdAt)) > Date.parse(String(row.createdAt)))) continue;
    const lastActivityAt = [previous?.lastActivityAt, row.createdAt].filter((v): v is string => typeof v === "string").sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    merged.set(identity, { ...previous, ...row, source: previous?.nativeSessionId ? "native+bridge" : "bridge", lastActivityAt,
      title: previous?.title ?? row.title, nativeSessionId: previous?.nativeSessionId,
      liveness: row.liveness === "running" ? "running" : previous?.liveness ?? row.liveness });
  }
  return [...merged.entries()].filter(([identity, row]) =>
    !config.deletedSessionIds?.[identity] && !config.deletedSessionIds?.[String(row.sessionId)],
  ).map(([, row]) => row);
}

function protobufFields(data: Buffer): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>();
  let offset = 0;
  const varint = () => {
    let value = 0, shift = 0;
    for (let count = 0; count < 10 && offset < data.length; count++) {
      const byte = data[offset++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error("Invalid conversation payload");
  };
  while (offset < data.length) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (wire === 0) varint();
    else if (wire === 2) {
      const size = varint();
      if (size < 0 || offset + size > data.length) throw new Error("Truncated conversation payload");
      fields.set(field, [...(fields.get(field) ?? []), data.subarray(offset, offset + size)]);
      offset += size;
    } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new Error("Unsupported conversation payload");
  }
  return fields;
}
export async function readNativeSessionContext(session: NativeSession, maxChars = 80000): Promise<string> {
  const messages: string[] = [];
  const add = (role: string, content: string) => { if (content.trim()) { messages.push(`${role}:\n${content.trim()}`); if (messages.length > 120) messages.shift(); } };
  if (session.agent === "antigravity" && session.nativePath) {
    for (const row of rows(session.nativePath, "SELECT step_type, step_payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx DESC LIMIT 120").reverse()) {
      try {
        const payload = Buffer.isBuffer(row.step_payload) ? row.step_payload : Buffer.from(String(row.step_payload));
        const body = protobufFields(payload).get(row.step_type === 14 ? 19 : 20)?.[0];
        if (!body) continue;
        const content = protobufFields(body).get(row.step_type === 14 ? 2 : 1)?.[0];
        if (content) add(row.step_type === 14 ? "User" : "Assistant", content.toString("utf8"));
      } catch {}
    }
  } else {
    if (session.agent === "codex" && session.historyDatabase) {
      for (const row of rows(session.historyDatabase, "SELECT item_json FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT 120", [session.nativeSessionId]).reverse()) {
        const item = parsed(String(row.item_json));
        add(item.type === "userMessage" ? "User" : "Assistant", text(item.content) || text(item.text));
      }
    }
    if (!messages.length && session.nativePath && existsSync(session.nativePath)) {
      const stream = createReadStream(session.nativePath, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const row = parsed(line), message = object(row.message), payload = object(row.payload);
          if (session.agent === "claude" && !row.isMeta && !row.isSidechain && ["user", "assistant"].includes(String(row.type))) add(String(row.type), text(message.content));
          if (session.agent === "codex" && row.type === "response_item" && payload.type === "message" && ["user", "assistant"].includes(String(payload.role))) add(String(payload.role), text(payload.content));
          if (session.agent === "codex" && row.type === "event_msg" && payload.type === "user_message") add("user", text(payload.message));
        }
      } finally { lines.close(); stream.destroy(); }
    }
  }
  const content = messages.join("\n\n");
  return [`Native ${session.agent} conversation ${session.nativeSessionId}`, `Repository: ${session.cwd}`, `Title: ${session.title}`,
    content.length > maxChars ? `[Earlier messages omitted]\n${content.slice(-maxChars)}` : content || session.summary || "No saved conversation text is available."].join("\n\n");
}
