import { posix } from "node:path";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import type { AgentKind } from "./types.js";

import type {
  AcquireFileLeaseInput,
  AcquireFileLeaseResult,
  AgentRequest,
  AgentRequestStatus,
  CreateAgentRequestInput,
  FileLease,
  RecordSessionEventInput,
  SessionEvent,
  TaskChange,
  TaskLane,
  UpsertTaskChangeInput,
  UpsertTaskLaneInput,
} from "./types.js";
import {
  now,
  toTaskLane,
  toFileLease,
  toTaskChange,
  toAgentRequest,
} from "./sqlite-codecs.js";
type Row = Record<string, unknown>;

export class LeaseRepository {
  constructor(
    private db: Database.Database,
    private host: {
      recordSessionEvent(input: RecordSessionEventInput): SessionEvent;
    },
  ) {}

  upsertTaskLane(input: UpsertTaskLaneInput): TaskLane {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO task_lanes
         (task_id, mode, base_ref, base_commit, worktree_path, status, created_at, updated_at)
         VALUES (@taskId, @mode, @baseRef, @baseCommit, @worktreePath, @status, @createdAt, @updatedAt)
         ON CONFLICT(task_id) DO UPDATE SET
           mode = excluded.mode,
           base_ref = excluded.base_ref,
           base_commit = excluded.base_commit,
           worktree_path = excluded.worktree_path,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run({
        taskId: input.taskId,
        mode: input.mode,
        baseRef: input.baseRef ?? null,
        baseCommit: input.baseCommit ?? null,
        worktreePath: input.worktreePath ?? null,
        status: input.status ?? "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare("SELECT * FROM task_lanes WHERE task_id = ?")
      .get(input.taskId) as Row;
    return toTaskLane(row);
  }

  getTaskLane(taskId: string): TaskLane | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_lanes WHERE task_id = ?")
      .get(taskId) as Row | undefined;
    return row ? toTaskLane(row) : undefined;
  }

  listTaskLanes(status?: TaskLane["status"], limit = 50): TaskLane[] {
    const statusFilter = status ? "WHERE status = @status" : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM task_lanes ${statusFilter} ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all({ status, limit }) as Row[]
    ).map(toTaskLane);
  }

  acquireFileLease(input: AcquireFileLeaseInput): AcquireFileLeaseResult {
    return this.db
      .transaction(() => this.acquireFileLeaseInTransaction(input))
      .immediate();
  }

  private acquireFileLeaseInTransaction(
    input: AcquireFileLeaseInput,
  ): AcquireFileLeaseResult {
    const path = posix.normalize(input.path.replace(/\\/g, "/"));
    if (!input.path.trim() || path === "." || path === ".." || path.startsWith("../") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0"))
      throw new Error("Lease path must be repository relative");
    if (!Number.isFinite(input.ttlSeconds ?? 3600) || (input.ttlSeconds ?? 3600) <= 0)
      throw new Error("Lease TTL must be positive");
    if (input.mode !== "read" && input.mode !== "write") throw new Error("Invalid lease mode");
    input = { ...input, path: process.platform === "win32" ? path.toLowerCase() : path };
    const timestamp = now();
    const expiresAt = new Date(
      Date.parse(timestamp) + (input.ttlSeconds ?? 3600) * 1000,
    ).toISOString();
    const blockingRow = this.db
      .prepare(
        `SELECT * FROM file_leases
         WHERE (path = @path OR substr(path,1,length(@path)+1) = @path || '/' OR substr(@path,1,length(path)+1) = path || '/')
           AND (task_id != @taskId OR session_id IS NOT @sessionId OR agent IS NOT @agent)
           AND released_at IS NULL
           AND (mode = 'write' OR @mode = 'write')
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get({
        path: input.path,
        taskId: input.taskId,
        sessionId: input.sessionId ?? null,
        agent: input.agent ?? null,
        mode: input.mode,
        timestamp,
      }) as Row | undefined;
    if (blockingRow) {
      return { acquired: false, blockingLease: toFileLease(blockingRow) };
    }

    const existing = this.db
      .prepare(
        `SELECT * FROM file_leases
         WHERE path = @path
           AND task_id = @taskId
           AND session_id IS @sessionId
           AND agent IS @agent
           AND mode = @mode
           AND released_at IS NULL
           AND expires_at > @timestamp
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get({
        path: input.path,
        taskId: input.taskId,
        sessionId: input.sessionId ?? null,
        agent: input.agent ?? null,
        mode: input.mode,
        timestamp,
      }) as Row | undefined;

    if (existing) {
      const id = String(existing.id);
      this.db
        .prepare(
          `UPDATE file_leases
           SET session_id = @sessionId, agent = @agent, base_hash = @baseHash,
               current_hash = @currentHash, expires_at = @expiresAt, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id,
          sessionId: input.sessionId ?? null,
          agent: input.agent ?? null,
          baseHash: input.baseHash ?? null,
          currentHash: input.currentHash ?? null,
          expiresAt,
          updatedAt: timestamp,
        });
      return { acquired: true, lease: this.getFileLease(id) };
    }

    const lease: FileLease = {
      id: `lease-${randomUUID()}`,
      taskId: input.taskId,
      sessionId: input.sessionId,
      agent: input.agent,
      path: input.path,
      mode: input.mode,
      baseHash: input.baseHash,
      currentHash: input.currentHash,
      expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO file_leases
         (id, task_id, session_id, agent, path, mode, base_hash, current_hash, expires_at, released_at, created_at, updated_at)
         VALUES (@id, @taskId, @sessionId, @agent, @path, @mode, @baseHash, @currentHash, @expiresAt, @releasedAt, @createdAt, @updatedAt)`,
      )
      .run({
        ...lease,
        sessionId: lease.sessionId ?? null,
        agent: lease.agent ?? null,
        baseHash: lease.baseHash ?? null,
        currentHash: lease.currentHash ?? null,
        releasedAt: null,
      });
    return { acquired: true, lease };
  }

  acquireFileLeases(inputs: AcquireFileLeaseInput[]): {
    acquired: boolean;
    leases?: FileLease[];
    blockingLease?: FileLease;
  } {
    const conflict = Symbol("lease-conflict");
    let blockingLease: FileLease | undefined;
    try {
      return this.db
        .transaction(() => {
          const leases: FileLease[] = [];
          for (const input of inputs) {
            const result = this.acquireFileLeaseInTransaction(input);
            if (!result.acquired || !result.lease) {
              blockingLease = result.blockingLease;
              throw conflict;
            }
            leases.push(result.lease);
          }
          return { acquired: true, leases };
        })
        .immediate();
    } catch (error) {
      if (error !== conflict) throw error;
      return { acquired: false, blockingLease };
    }
  }

  releaseFileLeases(
    ids: string[],
    owner: { taskId: string; agent?: string; sessionId?: string },
  ): FileLease[] {
    return this.db
      .transaction(() => {
        const leases = [...new Set(ids)].map((id) => {
          const lease = this.getFileLease(id);
          if (!lease) throw new Error(`Lease not found: ${id}`);
          if (
            lease.taskId !== owner.taskId ||
            (lease.agent && lease.agent !== owner.agent) ||
            (lease.sessionId && lease.sessionId !== owner.sessionId)
          ) {
            throw new Error(
              `Lease ownership conflict: ${id} belongs to task ${lease.taskId}, agent ${lease.agent}, session ${lease.sessionId}`,
            );
          }
          return lease;
        });
        return leases.map((lease) => this.releaseFileLease(lease.id, owner)!);
      })
      .immediate();
  }

  releaseSessionFileLeases(
    owner: { taskId: string; agent: string; sessionId: string },
    reason: string,
  ): FileLease[] {
    if (
      !owner.taskId?.trim() ||
      !owner.agent?.trim() ||
      !owner.sessionId?.trim() ||
      !reason.trim()
    ) {
      throw new Error(
        "Session lease cleanup requires task, agent, session and audit reason",
      );
    }
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            "SELECT * FROM file_leases WHERE session_id = ? AND released_at IS NULL",
          )
          .all(owner.sessionId) as Row[];
        const leases = rows.map(toFileLease);
        if (
          leases.some(
            (lease) =>
              lease.taskId !== owner.taskId || lease.agent !== owner.agent,
          )
        ) {
          throw new Error("Session lease ownership conflict");
        }
        const released = this.releaseFileLeases(
          leases.map((lease) => lease.id),
          owner,
        );
        if (released.length)
          this.host.recordSessionEvent({
            sessionId: owner.sessionId,
            taskId: owner.taskId,
            agent: owner.agent as AgentKind,
            kind: "assistant_summary",
            summary: JSON.stringify({
              kind: "session_lease_cleanup",
              reason,
              released: released.map((lease) => lease.id),
            }),
          });
        return released;
      })
      .immediate();
  }

  releaseFileLease(id: string, owner?: { taskId: string; agent?: string; sessionId?: string }): FileLease | undefined {
    const current = this.getFileLease(id);
    if (!current) return undefined;
    if (current.releasedAt) return current;
    if ((current.agent || current.sessionId) && (!owner || current.taskId !== owner.taskId ||
        current.agent !== owner.agent || current.sessionId !== owner.sessionId))
      throw new Error("Lease ownership conflict");
    const timestamp = now();
    this.db
      .prepare(
        "UPDATE file_leases SET released_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(timestamp, timestamp, id);
    return this.getFileLease(id);
  }

  listFileLeases(
    options: {
      taskId?: string;
      path?: string;
      activeOnly?: boolean;
      limit?: number;
    } = {},
  ): FileLease[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = {
      limit: options.limit ?? 100,
      timestamp: now(),
    };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.path) {
      filters.push("path = @path");
      const path = posix.normalize(options.path.replace(/\\/g, "/"));
      params.path = process.platform === "win32" ? path.toLowerCase() : path;
    }
    if (options.activeOnly)
      filters.push("released_at IS NULL AND expires_at > @timestamp");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM file_leases ${where} ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toFileLease);
  }

  private getFileLease(id: string): FileLease | undefined {
    const row = this.db
      .prepare("SELECT * FROM file_leases WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toFileLease(row) : undefined;
  }

  upsertTaskChange(input: UpsertTaskChangeInput): TaskChange {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO task_changes
         (id, task_id, path, change_type, base_hash, current_hash, diff_summary, status, created_at, updated_at)
         VALUES (@id, @taskId, @path, @changeType, @baseHash, @currentHash, @diffSummary, @status, @createdAt, @updatedAt)
         ON CONFLICT(task_id, path) DO UPDATE SET
           change_type = excluded.change_type,
           base_hash = excluded.base_hash,
           current_hash = excluded.current_hash,
           diff_summary = excluded.diff_summary,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: `change-${randomUUID()}`,
        taskId: input.taskId,
        path: input.path,
        changeType: input.changeType,
        baseHash: input.baseHash ?? null,
        currentHash: input.currentHash ?? null,
        diffSummary: input.diffSummary ?? null,
        status: input.status ?? "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare("SELECT * FROM task_changes WHERE task_id = ? AND path = ?")
      .get(input.taskId, input.path) as Row;
    return toTaskChange(row);
  }

  listTaskChanges(taskId: string, limit = 100): TaskChange[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM task_changes WHERE task_id = ? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(taskId, limit) as Row[]
    ).map(toTaskChange);
  }

  createAgentRequest(input: CreateAgentRequestInput): AgentRequest {
    const request: AgentRequest = {
      id: `request-${randomUUID()}`,
      taskId: input.taskId,
      sessionId: input.sessionId,
      agent: input.agent,
      type: input.type,
      title: input.title,
      payload: input.payload,
      status: "pending",
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_requests
         (id, task_id, session_id, agent, type, title, payload, status, response, created_at, resolved_at)
         VALUES (@id, @taskId, @sessionId, @agent, @type, @title, @payload, @status, @response, @createdAt, @resolvedAt)`,
      )
      .run({
        ...request,
        taskId: request.taskId ?? null,
        sessionId: request.sessionId ?? null,
        agent: request.agent ?? null,
        payload: request.payload ?? null,
        response: null,
        resolvedAt: null,
      });
    return request;
  }

  resolveAgentRequest(
    id: string,
    status: AgentRequestStatus,
    response?: string,
  ): AgentRequest | undefined {
    const current = this.getAgentRequest(id);
    if (!current) return undefined;
    const resolvedAt = now();
    this.db
      .prepare(
        "UPDATE agent_requests SET status = ?, response = ?, resolved_at = ? WHERE id = ?",
      )
      .run(status, response ?? null, resolvedAt, id);
    return this.getAgentRequest(id);
  }

  listAgentRequests(
    options: {
      taskId?: string;
      status?: AgentRequestStatus;
      limit?: number;
    } = {},
  ): AgentRequest[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.status) {
      filters.push("status = @status");
      params.status = options.status;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM agent_requests ${where} ORDER BY created_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toAgentRequest);
  }

  private getAgentRequest(id: string): AgentRequest | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_requests WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toAgentRequest(row) : undefined;
  }

  deleteAgentRequest(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM agent_requests WHERE id = ?").run(id)
        .changes > 0
    );
  }

  deleteAgentRequests(ids: string[]): number {
    if (!ids.length) return 0;
    const stmt = this.db.prepare("DELETE FROM agent_requests WHERE id = ?");
    const tx = this.db.transaction((values: string[]) => {
      let count = 0;
      for (const value of values) count += stmt.run(value).changes;
      return count;
    });
    return tx(ids);
  }
}
