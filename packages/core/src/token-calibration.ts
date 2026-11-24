import { estimateTokens } from "./token-optimizer.js";

export function calibrateTokenEstimate(samples: string[], count: (text: string) => number, fingerprint: string) {
  if (!Array.isArray(samples) || !samples.length || samples.some((sample) => typeof sample !== "string")) throw new Error("Calibration requires a nonempty array of text samples");
  const rows = samples.map((text) => {
    const actual = count(text);
    const estimated = estimateTokens(text);
    if (!Number.isFinite(actual) || actual < 0) throw new Error("Invalid configured tokenizer output");
    return { actual, estimated, ratio: estimated ? actual / estimated : actual ? null : 1 };
  });
  const ratios = rows.map((row) => row.ratio).filter((ratio): ratio is number => ratio !== null).sort((a, b) => a - b);
  const maximum = ratios[ratios.length - 1] ?? 1;
  const margin = Math.max(0, maximum - 1 + 0.05);
  return { schemaVersion: 1, fingerprint, provenance: "configured-tokenizer-calibration", samples: rows.length,
    p95Ratio: ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))], maxRatio: maximum,
    suggestedSafetyMargin: margin < 1 && rows.every((row) => row.ratio !== null) ? margin : null,
    applicableTo: "Only this tokenizer/model and sampled corpus; validate on held-out inputs", rows };
}
