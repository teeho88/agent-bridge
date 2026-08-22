import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, sep } from "node:path";

export type SkillScope = "global" | "repo";

export type SkillRecord = {
  name: string;
  description: string;
  scope: SkillScope;
  path: string;
  content: string;
  updatedAt: string;
};

export type SaveSkillInput = {
  scope: SkillScope;
  name?: string;
  description?: string;
  content: string;
};

export type SkillFile = {
  path: string;
  content: Uint8Array;
};

export type InstallSkillFilesInput = {
  scope: SkillScope;
  files: SkillFile[];
  overwrite?: boolean;
};

const MAX_SKILL_BYTES = 512 * 1024;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function skillRoot(
  scope: SkillScope,
  cwd: string,
  userHome = homedir(),
): string {
  return scope === "global"
    ? join(userHome, ".agents", "skills")
    : join(cwd, ".agents", "skills");
}

export function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseSkillMarkdown(content: string): {
  name?: string;
  description?: string;
  instructions: string;
} {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) return { instructions: normalized.trim() };
  const metadata = match[1] ?? "";
  const readField = (name: string): string | undefined => {
    const field = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(metadata)?.[1]?.trim();
    if (!field) return undefined;
    if (field.startsWith('"') && field.endsWith('"')) {
      try {
        return JSON.parse(field) as string;
      } catch {
        return field.slice(1, -1);
      }
    }
    return field.replace(/^['"]|['"]$/g, "");
  };
  return {
    name: readField("name"),
    description: readField("description"),
    instructions: (match[2] ?? "").trim(),
  };
}

export function listSkills(
  scope: SkillScope,
  cwd: string,
  userHome = homedir(),
): SkillRecord[] {
  const root = skillRoot(scope, cwd, userHome);
  if (!existsSync(root)) return [];
  const skills: SkillRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
    const filePath = join(root, entry.name, "SKILL.md");
    if (!existsSync(filePath) || statSync(filePath).size > MAX_SKILL_BYTES) continue;
    const content = readFileSync(filePath, "utf8");
    const parsed = parseSkillMarkdown(content);
    if (!parsed.name || !parsed.description) continue;
    skills.push({
      name: parsed.name,
      description: parsed.description,
      scope,
      path: filePath,
      content,
      updatedAt: statSync(filePath).mtime.toISOString(),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveSkill(
  input: SaveSkillInput,
  cwd: string,
  userHome = homedir(),
): SkillRecord {
  if (Buffer.byteLength(input.content, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("Skill content must not exceed 512 KB.");
  }
  const parsed = parseSkillMarkdown(input.content);
  const name = normalizeSkillName(input.name || parsed.name || "");
  const description = (input.description || parsed.description || "").trim();
  const instructions = parsed.instructions.trim();
  if (!name || !SKILL_NAME.test(name)) {
    throw new Error("Skill name must contain letters or numbers and may use hyphens.");
  }
  if (!description) throw new Error("Skill description is required.");
  if (!instructions) throw new Error("Skill instructions are required.");

  const root = skillRoot(input.scope, cwd, userHome);
  const directory = resolve(root, name);
  if (basename(directory) !== name || resolve(directory, "..").toLowerCase() !== resolve(root).toLowerCase()) {
    throw new Error("Invalid skill path.");
  }
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, "SKILL.md");
  const markdown = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    instructions,
    "",
  ].join("\n");
  writeFileSync(filePath, markdown, "utf8");
  return {
    name,
    description,
    scope: input.scope,
    path: filePath,
    content: markdown,
    updatedAt: statSync(filePath).mtime.toISOString(),
  };
}

export function installSkillFiles(
  input: InstallSkillFilesInput,
  cwd: string,
  userHome = homedir(),
): SkillRecord {
  if (!input.files.length || input.files.length > MAX_SKILL_FILES) {
    throw new Error(`A skill must contain between 1 and ${MAX_SKILL_FILES} files.`);
  }
  let totalBytes = 0;
  const normalizedFiles = input.files.map((file) => {
    const path = normalizeRelativeSkillPath(file.path);
    if (file.content.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Skill file ${path} must not exceed 2 MB.`);
    }
    totalBytes += file.content.byteLength;
    return { path, content: file.content };
  });
  if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
    throw new Error("A skill directory must not exceed 8 MB.");
  }
  if (new Set(normalizedFiles.map((file) => file.path.toLowerCase())).size !== normalizedFiles.length) {
    throw new Error("A skill directory must not contain duplicate file paths.");
  }

  const skillFile = normalizedFiles.find((file) => file.path.toLowerCase() === "skill.md");
  if (!skillFile) throw new Error("The selected GitHub directory does not contain SKILL.md.");
  if (skillFile.content.byteLength > MAX_SKILL_BYTES) {
    throw new Error("SKILL.md must not exceed 512 KB.");
  }
  const markdown = Buffer.from(skillFile.content).toString("utf8");
  const parsed = parseSkillMarkdown(markdown);
  const name = normalizeSkillName(parsed.name ?? "");
  if (!parsed.name || name !== parsed.name || !SKILL_NAME.test(name)) {
    throw new Error("GitHub SKILL.md must declare a lowercase name using letters, numbers, and hyphens.");
  }
  if (!parsed.description?.trim()) throw new Error("GitHub SKILL.md must declare a description.");
  if (!parsed.instructions.trim()) throw new Error("GitHub SKILL.md must contain instructions.");

  const root = resolve(skillRoot(input.scope, cwd, userHome));
  const directory = resolve(root, name);
  if (basename(directory) !== name || resolve(directory, "..").toLowerCase() !== root.toLowerCase()) {
    throw new Error("Invalid skill path.");
  }
  if (existsSync(directory) && !input.overwrite) {
    throw new Error(`Skill $${name} already exists in the selected scope.`);
  }

  mkdirSync(root, { recursive: true });
  const operationId = randomUUID();
  const staging = resolve(root, `.${name}.install-${operationId}`);
  const backup = resolve(root, `.${name}.backup-${operationId}`);
  try {
    mkdirSync(staging, { recursive: false });
    for (const file of normalizedFiles) {
      const target = resolve(staging, ...file.path.split("/"));
      if (target !== staging && !target.toLowerCase().startsWith(`${staging.toLowerCase()}${sep}`)) {
        throw new Error("Invalid skill file path.");
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    if (existsSync(directory)) renameSync(directory, backup);
    renameSync(staging, directory);
    if (existsSync(backup)) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch {
        // A locked backup is hidden from discovery and can be cleaned up later.
      }
    }
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (existsSync(backup) && !existsSync(directory)) renameSync(backup, directory);
    throw error;
  }

  const filePath = join(directory, "SKILL.md");
  return {
    name,
    description: parsed.description.trim(),
    scope: input.scope,
    path: filePath,
    content: markdown,
    updatedAt: statSync(filePath).mtime.toISOString(),
  };
}

function normalizeRelativeSkillPath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error("Invalid skill file path.");
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Invalid skill file path.");
  }
  return normalized;
}

export function deleteSkill(
  scope: SkillScope,
  nameValue: string,
  cwd: string,
  userHome = homedir(),
): boolean {
  const name = normalizeSkillName(nameValue);
  if (!name || name !== nameValue || !SKILL_NAME.test(name)) {
    throw new Error("Invalid skill name.");
  }
  const root = resolve(skillRoot(scope, cwd, userHome));
  const directory = resolve(root, name);
  if (basename(directory) !== name || resolve(directory, "..").toLowerCase() !== root.toLowerCase()) {
    throw new Error("Invalid skill path.");
  }
  if (!existsSync(directory)) return false;
  const stats = lstatSync(directory);
  rmSync(directory, { recursive: stats.isDirectory() && !stats.isSymbolicLink(), force: false });
  return true;
}
