import { renderPromptPack } from "./prompt-pack.js";
import { toSingleLine } from "./token-optimizer.js";
import type { CompileContextInput } from "./types.js";

type Pack = Parameters<typeof renderPromptPack>[0];

export function allocateContext(candidate: Pack, input: CompileContextInput, count: (text: string) => number): Pack {
  const pack: Pack = { ...candidate, testResults: [], currentState: [], sharedMemory: [], relevantFiles: [], knownDecisions: [],
    repoMap: undefined, handoff: candidate.handoff ? { ...candidate.handoff, done: [], filesChanged: [] } : undefined,
    omitted: { ...candidate.omitted } };
  const sections: Array<{ weight: number; cap?: number; items: string[]; apply(items: string[]): void }> = [
    { weight: 0.35, cap: input.decisionTokenBudget, items: candidate.knownDecisions, apply: (items) => { pack.knownDecisions = items; pack.omitted.knownDecisions = candidate.omitted.knownDecisions + candidate.knownDecisions.length - items.length; } },
    { weight: 0.2, cap: input.memoryTokenBudget, items: candidate.currentState, apply: (items) => { pack.currentState = items; pack.omitted.currentState = candidate.omitted.currentState + candidate.currentState.length - items.length; } },
    { weight: 0.3, cap: input.fileTokenBudget, items: candidate.relevantFiles, apply: (items) => { pack.relevantFiles = items; pack.omitted.relevantFiles = candidate.omitted.relevantFiles + candidate.relevantFiles.length - items.length; } },
    { weight: 0.15, cap: input.handoffTokenBudget, items: candidate.handoff?.done ?? [], apply: (items) => { if (pack.handoff) pack.handoff.done = items; pack.omitted.handoffDone = (candidate.omitted.handoffDone ?? 0) + (candidate.handoff?.done.length ?? 0) - items.length; } },
    { weight: 0.05, cap: input.handoffTokenBudget, items: candidate.handoff?.filesChanged ?? [], apply: (items) => { if (pack.handoff) pack.handoff.filesChanged = items; pack.omitted.handoffFilesChanged = (candidate.omitted.handoffFilesChanged ?? 0) + (candidate.handoff?.filesChanged.length ?? 0) - items.length; pack.omitted.handoff = candidate.omitted.handoff + (candidate.handoff?.done.length ?? 0) + (candidate.handoff?.filesChanged.length ?? 0) - (pack.handoff?.done.length ?? 0) - items.length; } },
    { weight: 0.05, items: candidate.testResults ?? [], apply: (items) => { pack.testResults = items; pack.omitted.testResults = (candidate.omitted.testResults ?? 0) + (candidate.testResults?.length ?? 0) - items.length; } },
    { weight: 0.15, cap: input.sharedMemoryTokenBudget, items: candidate.sharedMemory, apply: (items) => { pack.sharedMemory = items; pack.omitted.sharedMemory = candidate.omitted.sharedMemory + candidate.sharedMemory.length - items.length; } },
    { weight: 0.25, cap: input.repoMapTokenBudget, items: candidate.repoMap?.split("\n") ?? [], apply: (items) => { pack.repoMap = items.join("\n") || undefined; pack.omitted.repoMap = candidate.omitted.repoMap + (candidate.repoMap?.split("\n").length ?? 0) - items.length; } },
  ];
  for (const section of sections) {
    if (section.cap !== undefined && (!Number.isFinite(section.cap) || section.cap < 0)) throw new Error("Invalid section token budget");
    section.apply([]);
  }
  const required = count(renderPromptPack(pack));
  if (required > input.tokenBudget) throw Object.assign(new Error(`essential_budget_exceeded: required context needs ${required} tokens; budget ${input.tokenBudget}. Read full task/constraints or increase --budget.`),
    { code: "essential_budget_exceeded", requiredTokens: required });
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    const before = count(renderPromptPack(pack));
    const remaining = Math.max(0, input.tokenBudget - before);
    const weights = sections.slice(index).filter((item) => item.items.length).reduce((sum, item) => sum + item.weight, 0);
    const allowance = Math.min(section.cap ?? Infinity, weights ? remaining * section.weight / weights : 0);
    let low = 0;
    let high = section.items.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      section.apply(section.items.slice(0, middle));
      const total = count(renderPromptPack(pack));
      const sectionTokens = count(section.items.slice(0, middle).map((item) => `- ${toSingleLine(item)}`).join("\n"));
      if (total <= input.tokenBudget && sectionTokens <= allowance) low = middle;
      else high = middle - 1;
    }
    section.apply(section.items.slice(0, low));
  }
  return pack;
}
