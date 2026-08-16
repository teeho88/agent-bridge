import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshBriefs } from "./graph-brief.js";
import { openStore } from "./workspace.js";

let root: string;
let store: ReturnType<typeof openStore>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-bridge-brief-"));
  mkdirSync(join(root, "src"), { recursive: true });
  store = openStore(root);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function writeSource(body: string): void {
  writeFileSync(join(root, "src/session.ts"), body, "utf8");
}

describe("refreshBriefs content-hash reuse", () => {
  it("builds a brief on first sight and reuses it while the file is unchanged", () => {
    writeSource("// Session helpers.\nexport function restore() {}\n");

    const first = refreshBriefs(store, root, { paths: ["src/session.ts"] });
    expect(first[0]?.reused).toBe(false);
    const summary = store.getFileSummary("src/session.ts")?.summary;
    expect(summary).toBeTruthy();

    const second = refreshBriefs(store, root, { paths: ["src/session.ts"] });
    expect(second[0]?.reused).toBe(true);
    expect(store.getFileSummary("src/session.ts")?.summary).toBe(summary);
  });

  it("rebuilds once the file content changes", () => {
    writeSource("// Session helpers.\nexport function restore() {}\n");
    refreshBriefs(store, root, { paths: ["src/session.ts"] });

    writeSource("// Rewritten: cookie parsing.\nexport function parseCookie() {}\n");
    const rebuilt = refreshBriefs(store, root, { paths: ["src/session.ts"] });

    expect(rebuilt[0]?.reused).toBe(false);
    expect(store.getFileSummary("src/session.ts")?.summary).toContain("cookie");
  });

  // A reused brief must still record that this task touched the file - the
  // Work-Git lease flow and the "recently edited" ordering both read it.
  it("still applies task metadata when the brief is reused", () => {
    writeSource("// Session helpers.\nexport function restore() {}\n");
    refreshBriefs(store, root, { paths: ["src/session.ts"] });

    const task = store.createTask({ title: "Fix session", ownerAgent: "claude" });
    const result = refreshBriefs(store, root, {
      paths: ["src/session.ts"],
      taskId: task.id,
      taskEdited: true
    });

    expect(result[0]?.reused).toBe(true);
    const stored = store.getFileSummary("src/session.ts");
    expect(stored?.lastTaskId).toBe(task.id);
    expect(stored?.lastTaskEditedAt).toBeTruthy();
    expect(store.getTask(task.id)?.status).toBe("in_progress");
  });

  // `graph build` moves the imports and dependents a brief is composed from,
  // so an explicit whole-repo refresh must not be short-circuited by the hash.
  it("ignores the hash when forced", () => {
    writeSource("// Session helpers.\nexport function restore() {}\n");
    refreshBriefs(store, root, { paths: ["src/session.ts"] });

    const forced = refreshBriefs(store, root, { paths: ["src/session.ts"], force: true });
    expect(forced[0]?.reused).toBe(false);
  });

  it("does not treat a deleted file as a cache hit", () => {
    writeSource("// Session helpers.\nexport function restore() {}\n");
    refreshBriefs(store, root, { paths: ["src/session.ts"] });

    rmSync(join(root, "src/session.ts"));
    const afterDelete = refreshBriefs(store, root, { paths: ["src/session.ts"] });
    expect(afterDelete[0]?.reused).toBe(false);
  });
});
