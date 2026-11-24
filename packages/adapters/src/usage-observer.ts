import { StringDecoder } from "node:string_decoder";
import { aggregateWorkflowUsage, normalizeProviderUsage } from "@agent-bridge/core";

export function createUsageObserver() {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let usage = normalizeProviderUsage(undefined);
  let completeness = "unknown";
  let oversized = false;
  const rawUsage: unknown[] = [];
  let toolCalls = 0;
  let toolsObserved = false;
  const consume = (text: string) => {
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (oversized || line.length > 65536) { oversized = false; continue; }
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "item.completed") {
          toolsObserved = true;
          const item = event.item as Record<string, unknown> | undefined;
          if (["command_execution", "mcp_tool_call", "web_search"].includes(String(item?.type))) toolCalls++;
        }
        if (["result", "turn.completed", "finish"].includes(String(event.type))) {
          const payload = event.data as Record<string, unknown> | undefined;
          const raw = event.usage ?? payload?.usage ?? null;
          if (event.type === "result") rawUsage.length = 0;
          rawUsage.push(raw);
          usage = aggregateWorkflowUsage(rawUsage.map(value => ({ status: "done", usage: normalizeProviderUsage(value) }))).totals;
          completeness = event.type === "finish" ? "partial" : "terminal-summary";
        }
      } catch {}
    }
    if (pending.length > 65536) { pending = ""; oversized = true; }
  };
  return { write(chunk: Buffer) { consume(decoder.write(chunk)); }, finish() { consume(`${decoder.end()}\n`); return usage; }, completeness() { return completeness; }, rawUsage() { return rawUsage; }, toolCalls() { return toolsObserved ? toolCalls : null; } };
}
