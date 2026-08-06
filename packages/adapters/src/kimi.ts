import type { CreateRegisteredAgentInput } from "@agent-bridge/memory";
import { providerPreset } from "./openai-compatible.js";

export const kimiPreset = providerPreset("kimi");

export function kimiAgentDefaults(name = "kimi"): CreateRegisteredAgentInput {
  return {
    name,
    provider: "kimi",
    mode: "api",
    baseUrl: kimiPreset.baseUrl,
    model: kimiPreset.defaultModel,
    credentialRef: kimiPreset.credentialEnv,
    capabilities: ["chat", "json", "research"],
  };
}
