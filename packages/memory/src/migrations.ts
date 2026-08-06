import type Database from "better-sqlite3";
import {
  agentArchiveColumnStatements,
  antigravityCommandRepointStatements,
  agentRunCycleColumnStatements,
  agentRunSchemaStatements,
  autoHandoffColumnStatements,
  embeddingColumnStatements,
  fileBriefColumnStatements,
  ftsFoldStatements,
  ftsStatements,
  graphSchemaStatements,
  legacyFileImportanceRemovalStatements,
  manualFilePriorityColumnStatements,
  orchestrationSchemaStatements,
  orchestrationTeamProvidersColumnStatements,
  reviewSchemaStatements,
  schemaStatements,
  supersededColumnStatements,
  taskOrchestrationSchemaStatements,
  workspaceEventSchemaStatements,
  workforceSchemaStatements,
  workforceAgentReasoningColumnStatements,
  workforceRoleArchiveColumnStatements
} from "./schema.js";
import { foldDiacritics } from "./text-normalize.js";

type Migration = {
  version: number;
  statements: string[];
};

// Ordered list of schema versions. Each migration runs exactly once; the applied
// version is tracked in SQLite's `user_version` pragma. Base schema uses
// `IF NOT EXISTS`, so re-running it against a pre-versioning database is safe.
const migrations: Migration[] = [
  { version: 1, statements: schemaStatements },
  { version: 2, statements: ftsStatements },
  { version: 3, statements: ftsFoldStatements },
  { version: 4, statements: supersededColumnStatements },
  { version: 5, statements: embeddingColumnStatements },
  { version: 6, statements: autoHandoffColumnStatements },
  { version: 7, statements: graphSchemaStatements },
  { version: 8, statements: fileBriefColumnStatements },
  { version: 9, statements: workspaceEventSchemaStatements },
  { version: 10, statements: manualFilePriorityColumnStatements },
  { version: 11, statements: legacyFileImportanceRemovalStatements },
  { version: 12, statements: taskOrchestrationSchemaStatements },
  { version: 13, statements: workforceSchemaStatements },
  { version: 14, statements: workforceAgentReasoningColumnStatements },
  { version: 15, statements: workforceRoleArchiveColumnStatements },
  { version: 16, statements: agentRunSchemaStatements },
  { version: 17, statements: orchestrationSchemaStatements },
  { version: 18, statements: reviewSchemaStatements },
  { version: 19, statements: agentArchiveColumnStatements },
  { version: 20, statements: agentRunCycleColumnStatements },
  { version: 21, statements: orchestrationTeamProvidersColumnStatements },
  { version: 22, statements: antigravityCommandRepointStatements }
];

// Register custom SQL functions on a connection. The `fold` function is called
// by the FTS triggers and the v3 backfill, so EVERY connection that may write
// to `memories` (the store, the encoding-repair tool) must register it —
// SQLite functions are per-connection and not persisted in the database file.
export function registerSqlFunctions(db: Database.Database): void {
  db.function("fold", { deterministic: true }, (value: unknown) =>
    value == null ? "" : foldDiacritics(String(value))
  );
}

export function runMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The dashboard refreshes every ~2s while Claude hooks write concurrently;
  // wait up to 5s for a lock instead of failing fast with "database is locked".
  db.pragma("busy_timeout = 5000");

  registerSqlFunctions(db);

  const currentVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  const pending = migrations.filter((migration) => migration.version > currentVersion);
  if (!pending.length) return;

  const migrate = db.transaction(() => {
    for (const migration of pending) {
      for (const statement of migration.statements) {
        db.prepare(statement).run();
      }
      db.pragma(`user_version = ${migration.version}`);
    }
  });
  migrate();
}

