// Script-aware token estimate. A flat length/4 heuristic badly underestimates
// Vietnamese (accents/diacritics) and CJK text, where the real tokenizer emits
// far more tokens per character than for plain ASCII. We weight each code point
// by script — ASCII ~1/4 token, CJK ~1 token, other (accented Latin, combining
// marks, non-Latin scripts) ~3/4 token — then round up. This keeps pure-ASCII
// estimates identical to the old length/4 behaviour while staying within ~20%
// of real Claude token counts on Vietnamese samples.
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let weight = 0;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      weight += 0.25;
    } else if (isCjk(code)) {
      weight += 1;
    } else {
      weight += 0.75;
    }
  }
  return Math.max(1, Math.ceil(weight));
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
  );
}

export function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item.trim());
  }
  return result;
}

export type TrimmedList = {
  items: string[];
  /** How many input items did not fit, so the caller can say so out loud. */
  omitted: number;
  /** Tokens consumed by the kept items. */
  used: number;
};

// Skip-and-continue rather than stop-at-first-overflow: a single oversized
// entry must not hide every shorter, higher-value entry queued behind it.
export function trimToTokenBudgetDetailed(
  items: string[],
  budget: number,
): TrimmedList {
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const item of items) {
    const cost = estimateTokens(item);
    if (used + cost > budget) {
      omitted += 1;
      continue;
    }
    kept.push(item);
    used += cost;
  }
  return { items: kept, omitted, used };
}

export function trimToTokenBudget(items: string[], budget: number): string[] {
  return trimToTokenBudgetDetailed(items, budget).items;
}

const MARKDOWN_LINE_PREFIX = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;

// Collapses free text into one line and strips per-line markdown markers.
// Memory content is whatever an agent wrote - often multi-line markdown - and
// a rendered pack section is a flat list, so an unflattened entry escapes its
// bullet and its headings forge sections that were never in the pack.
export function toSingleLine(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(MARKDOWN_LINE_PREFIX, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// The first meaningful line of a block of text, for use as its one-line
// summary. Falls back to the flattened text when there is no line break.
export function firstLineSummary(text: string, maxChars = 200): string {
  const line =
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((value) => value.replace(MARKDOWN_LINE_PREFIX, "").trim())
      .find(Boolean) ?? "";
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

export function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 24)).trim()}\n...[truncated]`;
}
