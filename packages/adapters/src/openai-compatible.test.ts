import { describe, expect, it } from "vitest";
import type { RegisteredAgent } from "@agent-bridge/memory";
import { deepseekAgentDefaults } from "./deepseek.js";
import { glmAgentDefaults } from "./glm.js";
import { kimiAgentDefaults } from "./kimi.js";
import {
  buildOpenAICompatibleRequest,
  parseOpenAICompatibleChatResponse,
  providerPreset,
  redactOpenAICompatibleHeaders,
  resolveOpenAICompatibleConfig,
} from "./openai-compatible.js";

function apiAgent(input: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: "agent-1",
    name: "deepseek-api",
    provider: "deepseek",
    mode: "api",
    capabilities: [],
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("OpenAI-compatible provider adapters", () => {
  it("resolves provider presets and env credentials", () => {
    const config = resolveOpenAICompatibleConfig(apiAgent(), {
      credentialLookup: (name) => name === "DEEPSEEK_API_KEY" ? "sk-test" : undefined,
    });

    expect(config.ok).toBe(true);
    if (!config.ok) throw new Error("expected config");
    expect(config.baseUrl).toBe(providerPreset("deepseek").baseUrl);
    expect(config.model).toBe("deepseek-chat");
    expect(config.headers.Authorization).toBe("Bearer sk-test");
  });

  it("returns a question-ready missing credential result", () => {
    const config = resolveOpenAICompatibleConfig(apiAgent({ credentialRef: "CUSTOM_KEY" }), {
      credentialLookup: () => undefined,
    });

    expect(config.ok).toBe(false);
    if (config.ok) throw new Error("expected missing credential");
    expect(config.credentialEnv).toBe("CUSTOM_KEY");
    expect(config.questionTitle).toContain("Set API credential");
  });

  it("redacts authorization and API-key headers", () => {
    expect(redactOpenAICompatibleHeaders({
      Authorization: "Bearer sk-secret",
      "x-api-key": "plain-secret",
      "Content-Type": "application/json",
    })).toEqual({
      Authorization: "Bearer [REDACTED]",
      "x-api-key": "[REDACTED]",
      "Content-Type": "application/json",
    });
  });

  it("builds JSON-mode chat completion requests", () => {
    const config = resolveOpenAICompatibleConfig(apiAgent({ baseUrl: "https://api.example.test/v1/", model: "model-a" }), {
      credentialLookup: () => "sk-test",
    });
    if (!config.ok) throw new Error("expected config");

    const request = buildOpenAICompatibleRequest(config, [{ role: "user", content: "Return JSON" }], { json: true, maxTokens: 32 });
    const body = JSON.parse(request.init.body) as { response_format?: { type?: string }; max_tokens?: number };

    expect(request.url).toBe("https://api.example.test/v1/chat/completions");
    expect(body.response_format?.type).toBe("json_object");
    expect(body.max_tokens).toBe(32);
  });

  it("parses mocked chat completion responses", () => {
    const parsed = parseOpenAICompatibleChatResponse({
      model: "model-a",
      choices: [{ message: { content: "{\"ok\":true}" } }],
      usage: { total_tokens: 12 },
    });

    expect(parsed.content).toBe('{"ok":true}');
    expect(parsed.model).toBe("model-a");
    expect(parsed.usage).toEqual({ total_tokens: 12 });
  });

  it("exposes default agent configs for DeepSeek Kimi and GLM", () => {
    expect(deepseekAgentDefaults()).toMatchObject({ provider: "deepseek", mode: "api", credentialRef: "DEEPSEEK_API_KEY" });
    expect(kimiAgentDefaults()).toMatchObject({ provider: "kimi", mode: "api", credentialRef: "KIMI_API_KEY" });
    expect(glmAgentDefaults()).toMatchObject({ provider: "glm", mode: "api", credentialRef: "GLM_API_KEY" });
  });
});
