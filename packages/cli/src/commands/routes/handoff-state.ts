import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { safeRead } from "./files.js";

// Reading .handoff/CURRENT.md back into the shape the dashboard renders.

export type PortableHandoffState = {
  currentPath: string;
  indexPath: string;
  history: Array<{
    path: string;
    title: string;
    date: string;
    state: string;
    summary: string;
  }>;
};

export function emptyPortableHandoffState(): PortableHandoffState {
  return {
    currentPath: ".handoff/CURRENT.md",
    indexPath: ".handoff/INDEX.md",
    history: [],
  };
}

export function markdownField(content: string, label: string): string {
  const match = new RegExp(`^${label}:\\s*(.+)$`, "m").exec(content);
  return match?.[1]?.trim() ?? "";
}

export function markdownSection(content: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  if (start < 0) return "";
  const body = content.slice(start + marker.length).replace(/^\s*\r?\n/, "");
  const next = body.search(/\r?\n## /);
  return (next < 0 ? body : body.slice(0, next)).trim();
}

export function readPortableHandoffState(cwd: string, taskId: string): PortableHandoffState {
  const state = emptyPortableHandoffState();
  const historyDir = join(cwd, ".handoff", "history");
  if (!existsSync(historyDir)) return state;
  try {
    state.history = readdirSync(historyDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const content = safeRead(join(historyDir, entry.name));
        if (markdownField(content, "Task") !== taskId) return undefined;
        return {
          path: `.handoff/history/${entry.name}`,
          title: /^# Handoff — (.+)$/m.exec(content)?.[1]?.trim() ?? taskId,
          date: markdownField(content, "Date"),
          state: markdownField(content, "State") || "active",
          summary: markdownSection(content, "Current state"),
        };
      })
      .filter((entry): entry is PortableHandoffState["history"][number] => Boolean(entry))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20);
  } catch {
    // A concurrently written archive is harmless; the next UI poll retries.
  }
  return state;
}
