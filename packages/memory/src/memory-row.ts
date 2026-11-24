import type { Memory } from "./types.js";
type Row = Record<string, unknown>;
function parseList(value: unknown): string[] {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

export function toMemory(row: Row): Memory {
  return {
    evidence: row.evidence ? JSON.parse(String(row.evidence)) : undefined,
    stale: Boolean(row.stale),
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    type: String(row.type) as Memory["type"],
    content: String(row.content),
    summary: row.summary ? String(row.summary) : undefined,
    importance: Number(row.importance ?? 3),
    tags: parseList(row.tags),
    sourceAgent: row.source_agent
      ? (String(row.source_agent) as Memory["sourceAgent"])
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supersededBy: row.superseded_by ? String(row.superseded_by) : undefined,
  };
}

