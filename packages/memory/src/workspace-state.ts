import Database from "better-sqlite3";

export type StateObject = Record<string, unknown>;

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function mergeState(base: unknown, desired: unknown, latest: unknown, path = ""): unknown {
  if (equal(base, desired)) return latest;
  if (equal(base, latest) || equal(desired, latest)) return desired;
  const object = (value: unknown): value is StateObject => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (object(desired) && object(latest) && (base === undefined || object(base))) {
    const result: StateObject = {};
    for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(desired), ...Object.keys(latest)])) {
      const value = mergeState((base as StateObject | undefined)?.[key], desired[key], latest[key], path ? `${path}.${key}` : key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  if (path === "currentTaskId" || /^current(Tasks|Sessions)\.[^.]+$/.test(path)) return desired;
  if (path === "workflow.promotedSessions" && Array.isArray(desired) && Array.isArray(latest)) {
    const removed = new Set((Array.isArray(base) ? base : []).filter((item) => !desired.includes(item)));
    return [...new Set([...latest.filter((item) => !removed.has(item)), ...desired])];
  }
  throw new Error(`config_conflict: concurrent changes to ${path || "config"}; reload and retry`);
}

export class WorkspaceStateStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, revision INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS context_publications (
      locator TEXT PRIMARY KEY, generation INTEGER NOT NULL, manifest TEXT NOT NULL
    )`);
  }

  close(): void { this.db.close(); }

  transaction<T>(action: () => T): T { return this.db.transaction(action).immediate(); }

  initialize(initial: StateObject): void {
    this.db.prepare("INSERT OR IGNORE INTO workspace_runtime(id, payload, revision) VALUES (1, ?, 0)").run(JSON.stringify(initial));
  }

  read(): { state: StateObject; revision: number } {
    const row = this.db.prepare("SELECT payload, revision FROM workspace_runtime WHERE id = 1").get() as { payload: string; revision: number } | undefined;
    if (!row) throw new Error("Workspace runtime has not been imported");
    return { state: JSON.parse(row.payload), revision: row.revision };
  }

  write(state: StateObject): void {
    this.db.prepare("UPDATE workspace_runtime SET payload = ?, revision = revision + 1 WHERE id = 1").run(JSON.stringify(state));
  }

  publication(locator: string): { generation: number; manifest: string } | undefined {
    return this.db.prepare("SELECT generation, manifest FROM context_publications WHERE locator = ?").get(locator) as { generation: number; manifest: string } | undefined;
  }

  listPublications(): Array<{ locator: string; generation: number; manifest: string }> {
    return this.db.prepare("SELECT locator, generation, manifest FROM context_publications").all() as Array<{ locator: string; generation: number; manifest: string }>;
  }

  commitPublication(locator: string, expectedGeneration: number, expectedRuntimeRevision: number,
    taskId: string, sessionId: string | undefined, manifest: string): number {
    return this.transaction(() => {
      const runtime = this.read();
      if (runtime.revision !== expectedRuntimeRevision || (sessionId && (runtime.state.sessionTasks as Record<string, string> | undefined)?.[sessionId] !== taskId)) {
        throw new Error("context_publication_conflict: session state changed; refresh and retry");
      }
      const current = this.publication(locator);
      if ((current?.generation ?? 0) !== expectedGeneration) throw new Error("context_publication_conflict: a newer generation exists; refresh and retry");
      const generation = expectedGeneration + 1;
      this.db.prepare(`INSERT INTO context_publications(locator, generation, manifest) VALUES (?, ?, ?)
        ON CONFLICT(locator) DO UPDATE SET generation = excluded.generation, manifest = excluded.manifest`).run(locator, generation, manifest);
      return generation;
    });
  }
}
