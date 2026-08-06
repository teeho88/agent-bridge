import type { PromptPack } from "@agent-bridge/core";

export function genericMarkdown(pack: PromptPack): string {
  return pack.renderedMarkdown;
}
