import type { Data } from "./service.js";
import { theme } from "./surface.js";

export const editLevels = [
  { maxAge: 10 * 60_000, label: "EDIT ≤10m", style: theme.editFresh },
  { maxAge: 3 * 60 * 60_000, label: "EDIT ≤3h", style: theme.success },
  { maxAge: 24 * 60 * 60_000, label: "EDIT ≤24h", style: theme.editToday },
  { maxAge: Infinity, label: "EDIT >24h", style: theme.muted },
];

export function editHighlight(node: Data, now = Date.now()): { label: string; style: string } | undefined {
  const timestamp = typeof node.lastEditedAt === "string" ? Date.parse(node.lastEditedAt) : NaN;
  if (!Number.isFinite(timestamp)) return node.recentKind === "edit" ? { label: "EDIT", style: theme.muted } : undefined;
  const age = Math.max(0, now - timestamp);
  return editLevels.find((level) => age <= level.maxAge);
}
