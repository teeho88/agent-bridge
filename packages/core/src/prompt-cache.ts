// Prompt-cache support. The compiled context is split into a stable PREFIX
// (rules, constraints, decisions, expected output — change rarely between turns)
// and a dynamic SUFFIX (goal, current state, files, handoff). A breakpoint marker
// separates them so an integration layer can place an Anthropic `cache_control`
// breakpoint at the end of the prefix and reuse it across turns. See
// docs/prompt-caching.md.
export const CACHE_BREAKPOINT_MARKER = "<!-- agent-bridge:cache-breakpoint -->";

export type CacheableBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

// Split a compiled context at the cache breakpoint. When the marker is absent
// (e.g. an older pack), everything is treated as dynamic suffix.
export function splitCacheable(markdown: string): { prefix: string; suffix: string } {
  const index = markdown.indexOf(CACHE_BREAKPOINT_MARKER);
  if (index === -1) return { prefix: "", suffix: markdown.trim() };
  return {
    prefix: markdown.slice(0, index).trimEnd(),
    suffix: markdown.slice(index + CACHE_BREAKPOINT_MARKER.length).replace(/^\n+/, "")
  };
}

// Build Anthropic content blocks with a single cache_control breakpoint at the
// end of the stable prefix. The marker itself is stripped. With no prefix, a
// single uncached block is returned.
export function toCacheableBlocks(markdown: string): CacheableBlock[] {
  const { prefix, suffix } = splitCacheable(markdown);
  if (!prefix) return [{ type: "text", text: suffix }];
  return [
    { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
    { type: "text", text: suffix }
  ];
}
