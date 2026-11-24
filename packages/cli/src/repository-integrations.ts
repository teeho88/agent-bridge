import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { antigravityRulesSection, claudeManagedSection, codexManagedSection, patchManagedSection } from "@agent-bridge/adapters";

type Json = Record<string, any>;
type Snapshot = { sections: Record<string, string>; hooks: Record<string, Json> };
const managedBlock = /<!-- agent-bridge:start -->[\s\S]*?<!-- agent-bridge:end -->/g;
const instructions = [
  ["AGENTS.md", codexManagedSection],
  ["CLAUDE.md", claudeManagedSection],
  [".agents/rules/agent-bridge.md", antigravityRulesSection],
] as const;
const hookFiles = [".codex/hooks.json", ".claude/settings.json", ".claude/settings.local.json", ".agents/hooks.json"];

function readJson(path: string): Json {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) : {};
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bridgeHook(hook: Json): boolean {
  return [hook.command, hook.commandWindows].some((command) => typeof command === "string" &&
    (/agent-bridge-(?:codex|claude|antigravity)-hook\.ps1/i.test(command) ||
      /\bcodex hook --event\b/.test(command)));
}

export function suspendRepositoryIntegrations(cwd: string): void {
  const snapshotPath = join(cwd, ".agent-memory", "disabled-integrations.json");
  const saved = readJson(snapshotPath);
  const snapshot: Snapshot = { sections: saved.sections ?? {}, hooks: saved.hooks ?? {} };
  const updates = new Map<string, string>();
  for (const [name] of instructions) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const blocks = content.match(managedBlock);
    if (!blocks) continue;
    const header = name === ".agents/rules/agent-bridge.md"
      ? content.match(/^---\r?\ntrigger: always_on\r?\ndescription: Agent Bridge lifecycle and work rules for Antigravity CLI\r?\n---\r?\n(?:\r?\n)?/)?.[0] ?? ""
      : "";
    const active = blocks.filter((block) => !block.includes("# Agent Bridge disabled"));
    if (active.length) snapshot.sections[name] = header + active.join("\n\n");
    updates.set(path, content.slice(header.length).replace(managedBlock, ""));
  }
  for (const name of hookFiles) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const config = readJson(path);
    const removed: Json = snapshot.hooks[name] ?? {};
    let changed = false;
    if (name === ".agents/hooks.json") {
      if (config["agent-bridge"]) {
        removed["agent-bridge"] = config["agent-bridge"];
        delete config["agent-bridge"];
        changed = true;
      }
    } else {
      for (const [event, entries] of Object.entries(config.hooks ?? {})) {
        if (!Array.isArray(entries)) continue;
        const kept: Json[] = [];
        for (const entry of entries) {
          if (!Array.isArray(entry.hooks)) { kept.push(entry); continue; }
          const bridge = entry.hooks.filter(bridgeHook);
          const other = entry.hooks.filter((hook: Json) => !bridgeHook(hook));
          if (bridge.length) {
            const restored = { ...entry, hooks: bridge };
            const previous = removed[event] ?? [];
            if (!previous.some((value: Json) => JSON.stringify(value) === JSON.stringify(restored))) previous.push(restored);
            removed[event] = previous;
            changed = true;
          }
          if (other.length || !bridge.length) kept.push({ ...entry, hooks: other });
        }
        if (kept.length) config.hooks[event] = kept;
        else delete config.hooks[event];
      }
    }
    if (changed) {
      snapshot.hooks[name] = removed;
      updates.set(path, `${JSON.stringify(config, null, 2)}\n`);
    }
  }
  writeJson(snapshotPath, snapshot);
  for (const [path, content] of updates) writeFileSync(path, content, "utf8");
}

export function restoreRepositoryIntegrations(cwd: string): void {
  const snapshotPath = join(cwd, ".agent-memory", "disabled-integrations.json");
  const snapshot = readJson(snapshotPath) as Partial<Snapshot>;
  for (const [name, section] of instructions) {
    const path = join(cwd, name);
    const saved = snapshot.sections?.[name];
    if (saved || existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const header = saved?.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/)?.[0] ?? "";
      patchManagedSection(path, saved ? saved.slice(header.length) : section());
      if (header) {
        const content = readFileSync(path, "utf8");
        if (!/^---\r?\n/.test(content)) writeFileSync(path, header + content.replace(/^\s*\n/, ""), "utf8");
      }
    }
  }
  for (const [name, removed] of Object.entries(snapshot.hooks ?? {})) {
    const path = join(cwd, name);
    const config = readJson(path);
    if (name === ".agents/hooks.json") {
      config["agent-bridge"] ??= removed["agent-bridge"];
    } else {
      config.hooks ??= {};
      for (const [event, entries] of Object.entries(removed)) {
        const current = config.hooks[event] ?? [];
        for (const entry of entries) {
          if (!current.some((value: Json) => JSON.stringify(value) === JSON.stringify(entry))) current.push(entry);
        }
        config.hooks[event] = current;
      }
    }
    writeJson(path, config);
  }
  if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
}
