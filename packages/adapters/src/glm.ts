import type { CreateRegisteredAgentInput } from "@agent-bridge/memory";
import { providerPreset } from "./openai-compatible.js";

export const glmPreset = providerPreset("glm");

export function glmAgentDefaults(name = "glm"): CreateRegisteredAgentInput {
  return {
    name,
    provider: "glm",
    mode: "api",
    baseUrl: glmPreset.baseUrl,
    model: glmPreset.defaultModel,
    credentialRef: glmPreset.credentialEnv,
    capabilities: ["chat", "json", "review"],
  };
}
