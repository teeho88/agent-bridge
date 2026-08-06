import { describe, expect, it } from "vitest";
import { loadOptionalTokenizer } from "./precise-tokens.js";

describe("loadOptionalTokenizer", () => {
  it("returns null when no module is named", async () => {
    expect(await loadOptionalTokenizer(undefined)).toBeNull();
  });

  it("returns null when the module cannot be imported", async () => {
    expect(await loadOptionalTokenizer("no-such-tokenizer-module-xyz")).toBeNull();
  });
});
