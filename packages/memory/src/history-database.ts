import Database from "better-sqlite3";

export function readHistoryRows(path: string, query: string, parameters: unknown[] = []): Record<string, unknown>[] {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 200 });
  try {
    db.pragma("query_only = ON");
    return db.prepare(query).all(...parameters) as Record<string, unknown>[];
  } finally { db.close(); }
}
