export function boundStatePayload(data: Record<string, unknown>, maxBytes = 262000): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(data)) <= maxBytes) return data;
  const result = structuredClone(data);
  const omitted: Record<string, number> = {};
  const trim = (value: unknown, path: string, width: number): unknown => {
    if (typeof value === "string" && value.length > width * 64) {
      omitted[path] = value.length;
      return `${value.slice(0, width * 64)}\n[Dashboard preview; refresh to load full details]`;
    }
    if (Array.isArray(value)) {
      if (value.length > width) omitted[path] = value.length - width;
      return value.slice(0, width).map((item, index) => trim(item, `${path}[${index}]`, width));
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 100) omitted[path] = Math.max(0, entries.length - width);
      return Object.fromEntries((entries.length > 100 ? entries.slice(0, width) : entries).map(([key, item]) => [key, trim(item, path ? `${path}.${key}` : key, width)]));
    }
    return value;
  };
  for (const width of [100, 50, 20, 10, 5, 1]) {
    const candidate = trim(result, "", width) as Record<string, unknown>;
    const response = { ...candidate, stateContinuation: { path: "/api/state/details", omitted } };
    if (Buffer.byteLength(JSON.stringify(response)) <= maxBytes) return response;
  }
  const minimal = Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
    Array.isArray(value) ? [] : value && typeof value === "object" ? {} : typeof value === "string" ? value.slice(0, 64) : value]));
  return { ...minimal, stateContinuation: { path: "/api/state/details", omittedPaths: Object.keys(omitted).length, error: "Preview metadata exceeds payload cap" } };
}
