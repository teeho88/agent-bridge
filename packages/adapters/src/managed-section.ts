import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const start = "<!-- agent-bridge:start -->";
const end = "<!-- agent-bridge:end -->";

export function patchManagedSection(filePath: string, section: string): "created" | "updated" {
  const absolute = resolve(filePath);
  const normalizedSection = section.includes(start) ? section.trim() : `${start}\n\n${section.trim()}\n\n${end}`;

  if (!existsSync(absolute)) {
    writeFileSync(absolute, `${normalizedSection}\n`, "utf8");
    return "created";
  }

  const current = readFileSync(absolute, "utf8");
  copyFileSync(absolute, `${absolute}.bak`);
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, normalizedSection)
    : `${current.trimEnd()}\n\n${normalizedSection}\n`;
  writeFileSync(absolute, next, "utf8");
  return "updated";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
