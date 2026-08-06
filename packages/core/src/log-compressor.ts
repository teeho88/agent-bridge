import { compactText } from "./token-optimizer.js";
import { redactSecrets } from "./security-policy.js";

export type CompressLogOptions = {
  maxLines?: number;
  maxChars?: number;
  keepErrors?: boolean;
};

const noisePatterns = [
  /^\s*$/,
  /added \d+ packages?/i,
  /found \d+ vulnerabilities?/i,
  /^\s*[.\-=]{4,}\s*$/,
  /downloaded|resolved|reused|progress:/i
];

const importantPatterns = [/error/i, /failed/i, /exception/i, /at\s+\S+\s+\(/, /exit code/i, /warning/i];

export function compressLog(input: string, options: CompressLogOptions = {}): string {
  const maxLines = options.maxLines ?? 80;
  const maxChars = options.maxChars ?? 8000;
  const keepErrors = options.keepErrors ?? true;
  const redacted = redactSecrets(input);
  const lines = redacted.replace(/\r\n/g, "\n").split("\n");
  const result: string[] = [];
  const repeats = new Map<string, number>();

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const important = importantPatterns.some((pattern) => pattern.test(trimmed));
    if (!important && noisePatterns.some((pattern) => pattern.test(trimmed))) continue;

    const key = trimmed.trim();
    const count = repeats.get(key) ?? 0;
    repeats.set(key, count + 1);
    if (count > 0 && !important) continue;

    if (keepErrors && important) {
      result.push(trimmed);
      continue;
    }

    if (result.length < maxLines) result.push(trimmed);
  }

  const repeated = [...repeats.entries()]
    .filter(([, count]) => count > 1)
    .map(([line, count]) => `[repeated ${count}x] ${line}`)
    .slice(0, 10);

  const combined = [...result.slice(0, maxLines), ...repeated].join("\n");
  return compactText(combined, maxChars);
}
