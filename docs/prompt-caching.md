# Prompt caching (Anthropic `cache_control`)

> Status: documented design + opt-in flag. Full proxy integration is optional and
> not enabled by default. The dashboard "Cache proxy" stage only **estimates**
> reusable tokens; it does not send `cache_control` to any provider.

## Why

The compiled context (`.agent-memory/compiled-context.md`) mixes two kinds of content:

- **Stable** between turns: `## Constraints`, `## Known Decisions`, `## Expected Output`.
  These rarely change while a task is in progress.
- **Dynamic**: `## Goal`, `## Current State`, `## Relevant Files`, `## Latest Handoff`,
  `## Next Actions`, `## Risks`. These shift every turn.

Anthropic prompt caching lets you mark a prefix of the prompt as cacheable with a
`cache_control` breakpoint. On a cache hit, the cached prefix is billed at a large
discount. Putting the **stable** sections in the cached prefix and the **dynamic**
sections after it maximizes reuse.

## What ships today

- The compiled context is **laid out for caching**: the stable sections
  (`## Expected Output`, `## Constraints`, `## Known Decisions`) come first, then a
  breakpoint marker `CACHE_BREAKPOINT_MARKER` (`<!-- agent-bridge:cache-breakpoint -->`),
  then the dynamic sections. Anthropic caches by prefix, so the stable content is now
  an actual reusable prefix rather than scattered mid-document.
- `splitCacheable(markdown)` and `toCacheableBlocks(markdown)` (exported from
  `@agent-bridge/core`) split at the marker and produce ready-to-send content blocks
  with `cache_control` on the prefix.
- `cacheableTokens` in the Token Savings estimator now counts the **real** tokens of
  the prefix (everything before the marker) — no fudge factor.

## How to integrate `cache_control` (when you proxy to the API)

Pass the compiled context through `toCacheableBlocks` and use the blocks directly —
the first block carries the `cache_control` breakpoint, the marker is stripped:

```js
import { toCacheableBlocks } from "@agent-bridge/core";
const blocks = toCacheableBlocks(pack.renderedMarkdown);
// blocks[0] = { type: "text", text: <stable prefix>, cache_control: { type: "ephemeral" } }
// blocks[1] = { type: "text", text: <dynamic suffix> }
const request = { system: blocks, messages: [/* conversation */] };
```

Rules of thumb:

- Only cache content that is stable for the cache TTL (5 minutes by default). Never
  cache `## Current State` / `## Latest Handoff` — they change every turn and would
  cause constant cache misses while still paying the write surcharge.
- A cache write costs more than a normal token; the savings come from reads on
  subsequent turns. Cache only when the same prefix will be reused.
- Order matters: the cached prefix must be byte-identical across requests to hit.

## Enabling

Caching integration is off by default. To opt in for a project, a proxy layer reads
`cacheableSectionHeadings`, slices the compiled context at those headings, and emits
the `cache_control` markers shown above. No `cache_control` is written unless that
proxy is explicitly enabled.
