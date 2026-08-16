import type { Handoff, Memory, Task } from "@agent-bridge/memory";
import { compressLog } from "./log-compressor.js";
import { estimateTokens } from "./token-optimizer.js";
import { splitCacheable } from "./prompt-cache.js";

export type TokenStackModuleId =
  | "rtk"
  | "claude-token-efficient"
  | "stable-prefix"
  | "token-optimizer"
  | "repomix"
  | "ccusage";

export type TokenStackModule = {
  id: TokenStackModuleId;
  label: string;
  purpose: string;
  usage: string;
  enabled: boolean;
  installed?: boolean;
};

export type TokenSavingsEstimateInput = {
  task?: Task;
  memories: Memory[];
  compiledContext: string;
  handoff?: Handoff;
  rawLog?: string;
};

export type TokenSavingsEstimate = {
  rawTokens: number;
  cleanedTokens: number;
  compiledTokens: number;
  cacheableTokens: number;
  savedTokens: number;
  savingsPercent: number;
  stages: Array<{
    id: string;
    label: string;
    beforeTokens: number;
    afterTokens: number;
    savedTokens: number;
    note: string;
  }>;
};

export function defaultTokenStackModules(): TokenStackModule[] {
  return [
    {
      id: "rtk",
      label: "RTK",
      purpose: "Filter CLI noise, repeated progress lines, and long logs.",
      usage: "Use through optimize logs or the token estimator stage.",
      enabled: true
    },
    {
      id: "claude-token-efficient",
      label: "claude-token-efficient",
      purpose: "Keep Claude/Codex responses concise and avoid unnecessary file reads.",
      usage: "Applied through AGENTS.md, CLAUDE.md, and compiled context rules.",
      enabled: true
    },
    {
      id: "stable-prefix",
      label: "stable prefix layout",
      purpose: "Order the compiled context so the unchanging part stays byte-identical and a provider can cache it.",
      usage:
        "Applied by every `context compile`: sections above the cache breakpoint marker are the reusable prefix. agent-bridge only lays the context out — the provider decides what it actually caches.",
      enabled: true
    },
    {
      id: "token-optimizer",
      label: "token-optimizer",
      purpose: "Estimate token cost, savings, and expensive context stages.",
      usage: "Shown in the dashboard Token Savings estimator.",
      enabled: true
    },
    {
      id: "repomix",
      label: "repomix",
      purpose: "Optional repository context packer.",
      usage: "After install, run repomix in a project to generate compact repo context.",
      enabled: false
    },
    {
      id: "ccusage",
      label: "ccusage",
      purpose:
        "Measure real prompt-cache reads and cost billed to the agent CLIs - the only non-estimated number in this stack.",
      usage: "Run `agent-bridge optimize cache-report` (requires ccusage on PATH).",
      enabled: true
    }
  ];
}

export function estimateTokenSavings(input: TokenSavingsEstimateInput): TokenSavingsEstimate {
  const rawText = [
    renderTaskRaw(input.task),
    input.memories
      .map((memory) => [memory.type, memory.content, memory.summary ?? "", memory.tags.join(",")].join("\n"))
      .join("\n\n"),
    input.handoff ? JSON.stringify(input.handoff) : "",
    input.rawLog ?? ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const rawTokens = estimateTokens(rawText);
  const cleanedLog = input.rawLog ? compressLog(input.rawLog) : "";
  const cleanedText = [renderTaskRaw(input.task), ...input.memories.map((memory) => memory.summary || memory.content), cleanedLog]
    .filter(Boolean)
    .join("\n");
  const cleanedTokens = estimateTokens(cleanedText);
  const compiledTokens = estimateTokens(input.compiledContext);
  const cacheableTokens = estimateCacheableTokens(input.compiledContext);

  const effectiveCompiledTokens = Math.max(compiledTokens - cacheableTokens, 0);
  const savedTokens = Math.max(rawTokens - effectiveCompiledTokens, 0);
  const savingsPercent = rawTokens > 0 ? Math.round((savedTokens / rawTokens) * 100) : 0;

  return {
    rawTokens,
    cleanedTokens,
    compiledTokens,
    cacheableTokens,
    savedTokens,
    savingsPercent,
    stages: [
      {
        id: "rtk",
        label: "RTK / log cleaning",
        beforeTokens: rawTokens,
        afterTokens: cleanedTokens,
        savedTokens: Math.max(rawTokens - cleanedTokens, 0),
        note: "Removes CLI noise, repeated lines, and compresses logs."
      },
      {
        id: "context-compile",
        label: "Context compile",
        beforeTokens: cleanedTokens,
        afterTokens: compiledTokens,
        savedTokens: Math.max(cleanedTokens - compiledTokens, 0),
        note:
          compiledTokens > cleanedTokens
            ? "Adds agent-ready structure and rules; can be larger for small tasks."
            : "Keeps task goal, relevant memories, decisions, handoff, and risks."
      },
      {
        id: "stable-prefix",
        label: "Stable prefix (cache candidate)",
        beforeTokens: compiledTokens,
        afterTokens: effectiveCompiledTokens,
        savedTokens: cacheableTokens,
        note:
          "Potential, not realised: the size of the prefix above the cache breakpoint. It only becomes a saving if the provider caches it and the same prefix is resent within its TTL. Run `optimize cache-report` for measured cache reads."
      },
      {
        id: "token-optimizer",
        label: "Token optimizer",
        beforeTokens: rawTokens,
        afterTokens: effectiveCompiledTokens,
        savedTokens,
        note: "Overall estimated savings. Provider billing can differ."
      }
    ]
  };
}

function renderTaskRaw(task?: Task): string {
  if (!task) return "";
  return [task.title, task.goal ?? "", task.status, task.ownerAgent ?? ""].filter(Boolean).join("\n");
}

// Sections that change rarely between the turns of one task. These mirror the
// prefix built by renderPromptPack and are only used as a fallback for older
// packs that predate the cache breakpoint marker. See docs/prompt-caching.md.
export const cacheableSectionHeadings = [
  "## Task",
  "## Goal",
  "## Expected Output",
  "## Constraints",
  "## Known Decisions",
  "## Repo Map"
] as const;

function estimateCacheableTokens(compiledContext: string): number {
  // Preferred path: count the real tokens of the stable prefix (everything
  // before the cache breakpoint marker). No fudge factor.
  const { prefix } = splitCacheable(compiledContext);
  if (prefix) return estimateTokens(prefix);

  // Fallback for packs without a breakpoint marker: sum the stable sections.
  const stableSections = cacheableSectionHeadings;
  const lines = compiledContext.split("\n");
  let active = false;
  const cacheable: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      active = stableSections.some((section) => line.startsWith(section));
    }
    if (active) cacheable.push(line);
  }

  return estimateTokens(cacheable.join("\n"));
}
