import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientModulePath } from "./http.js";

describe("clientModulePath", () => {
  it("resolves nested compiled dashboard modules", () => {
    expect(clientModulePath("/ui-client/main.js", "C:\\client")).toBe(join("C:\\client", "main.js"));
    expect(clientModulePath("/ui-client/orchestrator-office/derive-state.js", "C:\\client")).toBe(
      join("C:\\client", "orchestrator-office", "derive-state.js"),
    );
  });

  it("rejects traversal, malformed segments, and non-JavaScript files", () => {
    expect(clientModulePath("/ui-client/../ui-page.js", "C:\\client")).toBeUndefined();
    expect(clientModulePath("/ui-client/orchestrator-office//derive-state.js", "C:\\client")).toBeUndefined();
    expect(clientModulePath("/ui-client/orchestrator-office\\derive-state.js", "C:\\client")).toBeUndefined();
    expect(clientModulePath("/ui-client/orchestrator-office/notes.txt", "C:\\client")).toBeUndefined();
  });
});
