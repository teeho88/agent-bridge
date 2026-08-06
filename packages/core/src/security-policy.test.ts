import { describe, expect, it } from "vitest";
import { redactSecrets } from "./security-policy.js";

describe("redactSecrets", () => {
  it("redacts env-style assignments and preserves the key name", () => {
    expect(redactSecrets("TOKEN=super-secret")).toBe("TOKEN=[REDACTED]");
    expect(redactSecrets('API_KEY="abc123"')).toBe("API_KEY=[REDACTED]");
    expect(redactSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI")).toBe("AWS_SECRET_ACCESS_KEY=[REDACTED]");
  });

  it("redacts known token formats", () => {
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED_AWS_KEY]");
    expect(redactSecrets("ghp_0123456789abcdef0123456789abcdefABCD")).toBe("[REDACTED_GITHUB_TOKEN]");
    expect(redactSecrets("Authorization: Bearer abc.def-123")).toContain("Bearer [REDACTED]");
    expect(redactSecrets("token eyJhbGciOi.eyJzdWIiOiI.SflKxwRJ here")).toContain("[REDACTED_JWT]");
  });

  it("redacts PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[REDACTED_PRIVATE_KEY]");
  });

  it("leaves ordinary text untouched", () => {
    const text = "Fix login session persistence after refresh";
    expect(redactSecrets(text)).toBe(text);
  });
});
