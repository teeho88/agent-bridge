import { describe, expect, it } from "vitest";
import { compressLog } from "./log-compressor.js";

describe("compressLog", () => {
  it("redacts secrets and keeps errors", () => {
    const compressed = compressLog(
      [
        "Progress: resolved 10 packages",
        "TOKEN=super-secret",
        "Error: failed test",
        "Error: failed test",
        "    at run (src/test.ts:1:1)"
      ].join("\n"),
      { maxLines: 10 }
    );

    expect(compressed).toContain("TOKEN=[REDACTED]");
    expect(compressed).toContain("Error: failed test");
    expect(compressed).not.toContain("super-secret");
    expect(compressed).not.toContain("Progress: resolved");
  });
});
