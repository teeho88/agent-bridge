import type { RegisteredAgent, AgentProvider } from "@agent-bridge/memory";

export type OpenAICompatibleProvider = Extract<AgentProvider, "openai-compatible" | "deepseek" | "kimi" | "glm">;

export type OpenAICompatibleProviderPreset = {
  provider: OpenAICompatibleProvider;
  baseUrl: string;
  defaultModel: string;
  credentialEnv: string;
};

export type OpenAICompatibleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type OpenAICompatibleChatOptions = {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  credentialEnv?: string;
  credentialLookup?: (envName: string) => string | undefined;
  fetchImpl?: typeof fetch;
};

export type OpenAICompatibleConfig = {
  provider: OpenAICompatibleProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  credentialEnv: string;
  headers: Record<string, string>;
};

export type MissingCredentialConfig = {
  ok: false;
  provider: OpenAICompatibleProvider;
  credentialEnv: string;
  reason: string;
  questionTitle: string;
};

export type ResolvedOpenAICompatibleConfig =
  | ({ ok: true } & OpenAICompatibleConfig)
  | MissingCredentialConfig;

export type OpenAICompatibleRequest = {
  url: string;
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  };
};

export type OpenAICompatibleChatResult = {
  content: string;
  model?: string;
  usage?: unknown;
  raw: unknown;
};

export const providerPresets: Record<OpenAICompatibleProvider, OpenAICompatibleProviderPreset> = {
  "openai-compatible": {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    credentialEnv: "OPENAI_API_KEY",
  },
  deepseek: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    credentialEnv: "DEEPSEEK_API_KEY",
  },
  kimi: {
    provider: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    credentialEnv: "KIMI_API_KEY",
  },
  glm: {
    provider: "glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    credentialEnv: "GLM_API_KEY",
  },
};

export function providerPreset(provider: OpenAICompatibleProvider): OpenAICompatibleProviderPreset {
  return providerPresets[provider];
}

export function resolveOpenAICompatibleConfig(
  agent: RegisteredAgent,
  options: Pick<OpenAICompatibleChatOptions, "credentialEnv" | "credentialLookup"> = {},
): ResolvedOpenAICompatibleConfig {
  const provider = toOpenAICompatibleProvider(agent.provider);
  const preset = providerPresets[provider];
  const credentialEnv = options.credentialEnv ?? agent.credentialRef ?? preset.credentialEnv;
  const lookup = options.credentialLookup ?? ((name: string) => process.env[name]);
  const apiKey = lookup(credentialEnv);
  if (!apiKey) {
    return {
      ok: false,
      provider,
      credentialEnv,
      reason: `Missing API credential environment variable: ${credentialEnv}`,
      questionTitle: `Set API credential for ${agent.name}`,
    };
  }
  return {
    ok: true,
    provider,
    baseUrl: stripTrailingSlash(agent.baseUrl ?? preset.baseUrl),
    model: agent.model ?? preset.defaultModel,
    apiKey,
    credentialEnv,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
}

export function buildOpenAICompatibleRequest(
  config: OpenAICompatibleConfig,
  messages: OpenAICompatibleMessage[],
  options: Pick<OpenAICompatibleChatOptions, "temperature" | "maxTokens" | "json"> = {},
): OpenAICompatibleRequest {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.json) body.response_format = { type: "json_object" };
  return {
    url: `${stripTrailingSlash(config.baseUrl)}/chat/completions`,
    init: {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(body),
    },
  };
}

export async function chatOpenAICompatible(
  agent: RegisteredAgent,
  messages: OpenAICompatibleMessage[],
  options: OpenAICompatibleChatOptions = {},
): Promise<OpenAICompatibleChatResult> {
  const config = resolveOpenAICompatibleConfig(agent, options);
  if (!config.ok) throw new Error(config.reason);
  const request = buildOpenAICompatibleRequest(config, messages, options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(request.url, request.init);
  const json = await response.json();
  if (!response.ok) throw new Error(`Provider ${config.provider} returned ${response.status}: ${JSON.stringify(json)}`);
  return parseOpenAICompatibleChatResponse(json);
}

export function parseOpenAICompatibleChatResponse(raw: unknown): OpenAICompatibleChatResult {
  if (!raw || typeof raw !== "object") throw new Error("Invalid OpenAI-compatible response: expected object.");
  const record = raw as { choices?: Array<{ message?: { content?: unknown } }>; model?: unknown; usage?: unknown };
  const content = record.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Invalid OpenAI-compatible response: missing choices[0].message.content.");
  return {
    content,
    model: typeof record.model === "string" ? record.model : undefined,
    usage: record.usage,
    raw,
  };
}

export function redactOpenAICompatibleHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    if (/authorization|api-key|x-api-key/i.test(key)) return [key, redactHeaderValue(value)];
    return [key, value];
  }));
}

function toOpenAICompatibleProvider(provider: AgentProvider): OpenAICompatibleProvider {
  if (provider === "deepseek" || provider === "kimi" || provider === "glm" || provider === "openai-compatible") return provider;
  return "openai-compatible";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function redactHeaderValue(value: string): string {
  if (/^Bearer\s+/i.test(value)) return "Bearer [REDACTED]";
  return "[REDACTED]";
}
