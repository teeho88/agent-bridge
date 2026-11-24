import type Database from "better-sqlite3";
import type { MemoryStore } from "./memory-store.js";
import { randomUUID } from "node:crypto";

import type {
  CreateMemoryCandidateInput,
  MemoryCandidate,
  RecordSessionEventInput,
  SessionEvent,
} from "./types.js";
import { now, toSessionEvent, toMemoryCandidate } from "./sqlite-codecs.js";
type Row = Record<string, unknown>;

export class SessionRepository {
  constructor(
    private db: Database.Database,
    private host: Pick<MemoryStore, "addMemory">,
  ) {}

  recordSessionEvent(input: RecordSessionEventInput): SessionEvent {
    const event: SessionEvent = {
      id: `event-${randomUUID()}`,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agent: input.agent,
      kind: input.kind,
      summary: input.summary,
      createdAt: input.createdAt ?? now(),
    };
    this.db
      .prepare(
        `INSERT INTO session_events (id, session_id, task_id, agent, kind, summary, created_at)
         VALUES (@id, @sessionId, @taskId, @agent, @kind, @summary, @createdAt)`,
      )
      .run({
        ...event,
        taskId: event.taskId ?? null,
        agent: event.agent ?? null,
        summary: event.summary ?? null,
      });
    return event;
  }

  listSessionEvents(
    options: { taskId?: string; sessionId?: string; limit?: number } = {},
  ): SessionEvent[] {
    const filters: string[] = [];
    if (options.taskId) filters.push("task_id = @taskId");
    if (options.sessionId) filters.push("session_id = @sessionId");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM session_events ${where} ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
        )
        .all({
          taskId: options.taskId,
          sessionId: options.sessionId,
          limit: options.limit ?? 100,
        }) as Row[]
    ).map(toSessionEvent);
  }

  listActiveSessionEvents(limit = 100): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM session_events e
         WHERE e.id = (
           SELECT latest.id FROM session_events latest
           WHERE latest.session_id = e.session_id
           ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
         )
         AND e.kind NOT IN ('session_ended', 'session_paused', 'stop_requested', 'task_cancelled')
         ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map(toSessionEvent);
  }

  listSessionHistory(): SessionEvent[] {
    return (this.db.prepare(`SELECT e.* FROM session_events e
      WHERE e.rowid = (SELECT latest.rowid FROM session_events latest
        WHERE latest.session_id = e.session_id
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
      ORDER BY e.created_at DESC, e.rowid DESC`).all() as Row[]).map(toSessionEvent);
  }

  createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidate {
    const candidate: MemoryCandidate = {
      id: `candidate-${randomUUID()}`,
      taskId: input.taskId,
      sessionEventId: input.sessionEventId,
      type: input.type,
      content: input.content,
      importance: input.importance,
      tags: input.tags,
      sourceAgent: input.sourceAgent,
      status: "pending",
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO memory_candidates
         (id, task_id, session_event_id, type, content, importance, tags, source_agent, status, created_at)
         VALUES (@id, @taskId, @sessionEventId, @type, @content, @importance, @tags, @sourceAgent, @status, @createdAt)`,
      )
      .run({
        ...candidate,
        taskId: candidate.taskId ?? null,
        sessionEventId: candidate.sessionEventId ?? null,
        sourceAgent: candidate.sourceAgent ?? null,
        tags: JSON.stringify(candidate.tags),
      });
    return candidate;
  }

  listMemoryCandidates(
    status: MemoryCandidate["status"] = "pending",
    limit = 100,
  ): MemoryCandidate[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(status, limit) as Row[]
    ).map(toMemoryCandidate);
  }

  reviewMemoryCandidate(
    id: string,
    action: "promote" | "reject",
  ): MemoryCandidate | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_candidates WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return undefined;
    const candidate = toMemoryCandidate(row);
    if (candidate.status !== "pending") return candidate;
    const reviewedAt = now();
    const status = action === "promote" ? "promoted" : "rejected";
    const tx = this.db.transaction(() => {
      if (action === "promote") {
        this.host.addMemory({
          type: candidate.type,
          content: candidate.content,
          importance: candidate.importance,
          tags: Array.from(
            new Set([...candidate.tags, "repo-memory", "promoted"]),
          ),
          sourceAgent: candidate.sourceAgent,
        });
      }
      this.db
        .prepare(
          "UPDATE memory_candidates SET status = ?, reviewed_at = ? WHERE id = ?",
        )
        .run(status, reviewedAt, id);
    });
    tx();
    return toMemoryCandidate(
      this.db
        .prepare("SELECT * FROM memory_candidates WHERE id = ?")
        .get(id) as Row,
    );
  }
}
