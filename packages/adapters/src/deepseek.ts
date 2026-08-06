import type { CreateRegisteredAgentInput } from "@agent-bridge/memory";
import { providerPreset } from "./openai-compatible.js";

export const deepseekPreset = providerPreset("deepseek");

export function deepseekAgentDefaults(name = "deepseek"): CreateRegisteredAgentInput {
  return {
    name,
    provider: "deepseek",
    mode: "api",
    baseUrl: deepseekPreset.baseUrl,
    model: deepseekPreset.defaultModel,
    credentialRef: deepseekPreset.credentialEnv,
    capabilities: ["chat", "json", "implement"],
  };
}
