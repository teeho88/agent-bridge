import { redactSecrets } from "./security-policy.js";

export type CompressLogOptions = {
  maxLines?: number;
  maxChars?: number;
  keepErrors?: boolean;
};

export type LogPreview = {
  text: string;
  totalLines: number;
  filteredLines: number;
  omittedLines: number;
  omittedDiagnostics: number;
};

const noisePatterns = [
  /^\s*$/,
  /added \d+ packages?/i,
  /found \d+ vulnerabilities?/i,
  /^\s*[.\-=]{4,}\s*$/,
  /downloaded|resolved|reused|progress:/i
];

const diagnosticPatterns = [
  /error|failed|exception|fatal|panic|warning|exit code/i,
  /^\s*at\s+\S+/,
  /^\s*File ["'].+["'], line \d+/,
  /^\s*(?:Traceback|Caused by:|\.\.\. \d+ more)/i
];

const truncatedMarker = "...[truncated]";
const clippedMarker = "...[line clipped]";

function validLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export function compressLogPreview(input: string, options: CompressLogOptions = {}): LogPreview {
  const maxLines = validLimit(options.maxLines, 80);
  const maxChars = validLimit(options.maxChars, 8000);
  const keepErrors = options.keepErrors ?? true;
  const lines = redactSecrets(input).replace(/\r\n/g, "\n").split("\n");
  const seen = new Set<string>();
  const candidates: { index: number; text: string; diagnostic: boolean }[] = [];

  for (const [index, line] of lines.entries()) {
    const content = line.trimEnd();
    const diagnostic = diagnosticPatterns.some((pattern) => pattern.test(content));
    if (!diagnostic && noisePatterns.some((pattern) => pattern.test(content))) continue;
    if (!diagnostic && seen.has(content)) continue;
    if (!diagnostic) seen.add(content);
    candidates.push({ index, text: content, diagnostic });
  }

  const prioritized = keepErrors
    ? [...candidates.filter((entry) => entry.diagnostic), ...candidates.filter((entry) => !entry.diagnostic)]
    : candidates;

  const select = (charBudget: number) => {
    const selected: { index: number; text: string; diagnostic: boolean; clipped: boolean }[] = [];
    let chars = 0;
    for (const entry of prioritized) {
      if (selected.length >= maxLines) break;
      const room = charBudget - chars - (selected.length ? 1 : 0);
      if (room <= 0) break;
      const maxLineChars = Math.min(room, 500);
      if (entry.text.length <= maxLineChars) {
        selected.push({ ...entry, clipped: false });
        chars += entry.text.length + (selected.length > 1 ? 1 : 0);
      } else if (entry.diagnostic && maxLineChars > clippedMarker.length + 12) {
        const text = entry.text.slice(0, maxLineChars - clippedMarker.length) + clippedMarker;
        selected.push({ ...entry, text, clipped: true });
        chars += text.length + (selected.length > 1 ? 1 : 0);
      }
    }
    selected.sort((a, b) => a.index - b.index);
    const selectedIds = new Set(selected.map((entry) => entry.index));
    const omittedLines = candidates.length - selected.length;
    const omittedDiagnostics = candidates.filter((entry) => entry.diagnostic && !selectedIds.has(entry.index)).length
      + selected.filter((entry) => entry.diagnostic && entry.clipped).length;
    return { selected, omittedLines, omittedDiagnostics };
  };

  let result = select(maxChars);
  if (result.omittedLines || result.omittedDiagnostics) {
    result = select(Math.max(0, maxChars - truncatedMarker.length - 1));
  }
  const truncated = result.omittedLines > 0 || result.omittedDiagnostics > 0;
  const visible = result.selected.map((entry) => entry.text).join("\n");
  const text = truncated
    ? [visible, truncatedMarker.slice(0, Math.max(0, maxChars - visible.length - (visible ? 1 : 0)))].filter(Boolean).join("\n")
    : visible;
  return {
    text,
    totalLines: lines.length,
    filteredLines: lines.length - candidates.length,
    omittedLines: result.omittedLines,
    omittedDiagnostics: result.omittedDiagnostics
  };
}

export function compressLog(input: string, options: CompressLogOptions = {}): string {
  return compressLogPreview(input, options).text;
}
