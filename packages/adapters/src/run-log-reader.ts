import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

function logSegments(path: string): string[] {
  const absolute = resolve(path);
  const manifest = `${absolute}.segments.json`;
  if (!existsSync(manifest)) return [absolute];
  if (statSync(manifest).size > 65536) throw new Error("Run log manifest exceeds read budget");
  const data = JSON.parse(readFileSync(manifest, "utf8")) as { schemaVersion?: number; segments?: unknown[] };
  if (data.schemaVersion !== 1 || !Array.isArray(data.segments) || data.segments.length > 4096) throw new Error("Invalid run log manifest");
  const segments = data.segments.map((entry) => {
    if (typeof entry !== "string") throw new Error("Invalid run log segment");
    const candidate = isAbsolute(entry) ? resolve(entry) : resolve(dirname(absolute), basename(entry));
    const suffix = candidate.slice(absolute.length);
    if (candidate !== absolute && (!candidate.startsWith(absolute) || !/^\.[1-9]\d*$/.test(suffix))) throw new Error("Run log segment escapes its log");
    return candidate;
  });
  if (new Set(segments).size !== segments.length || segments.at(-1) !== absolute) throw new Error("Invalid run log segment order");
  return segments;
}

export function readRunLog(path: string, maxBytes = 134217728): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid run log read budget");
  const buffers: Buffer[] = [];
  let bytes = 0;
  for (const segment of logSegments(path)) {
    if (!existsSync(segment)) continue;
    const size = statSync(segment).size;
    if (bytes + size > maxBytes) throw new Error("run_log_read_budget_exceeded");
    const handle = openSync(segment, "r");
    try {
      const buffer = Buffer.alloc(size);
      let length = 0;
      while (length < size) {
        const read = readSync(handle, buffer, length, size - length, length);
        if (!read) break;
        length += read;
      }
      bytes += length;
      buffers.push(buffer.subarray(0, length));
    } finally { closeSync(handle); }
  }
  return Buffer.concat(buffers).toString("utf8");
}

export function readRunLogTail(path: string | undefined, lines = 14, maxBytes = 24000): string {
  if (!path) return "";
  if (!Number.isSafeInteger(lines) || lines < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid run log tail budget");
  try {
    const segments = logSegments(path);
    const buffers: Buffer[] = [];
    let remaining = maxBytes;
    let partial = false;
    for (let index = segments.length - 1; index >= 0 && remaining > 0; index--) {
      if (!existsSync(segments[index])) continue;
      const size = statSync(segments[index]).size;
      const length = Math.min(size, remaining);
      const handle = openSync(segments[index], "r");
      try {
        const buffer = Buffer.alloc(length);
        const read = readSync(handle, buffer, 0, length, size - length);
        buffers.unshift(buffer.subarray(0, read));
        remaining -= read;
        partial = length < size || (remaining === 0 && index > 0);
      } finally { closeSync(handle); }
    }
    const text = Buffer.concat(buffers).toString("utf8");
    const newline = text.indexOf("\n");
    const usable = partial ? (newline < 0 ? "" : text.slice(newline + 1)) : text;
    return usable.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n");
  } catch { return ""; }
}
