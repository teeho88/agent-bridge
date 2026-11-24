import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function installationRoot(moduleUrl = import.meta.url): string {
  const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), "..");
  const workspaceRoot = resolve(packageRoot, "..", "..");
  return existsSync(join(workspaceRoot, "pnpm-workspace.yaml")) &&
    existsSync(join(workspaceRoot, "packages", "cli", "package.json"))
    ? workspaceRoot
    : packageRoot;
}

export function readApplicationVersion(root = installationRoot()): string {
  const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
    throw new Error("Root package.json must contain a stable SemVer version.");
  }
  return parsed.version;
}

export const applicationVersion = readApplicationVersion();
