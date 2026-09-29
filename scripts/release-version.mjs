import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageFiles = [
  "package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/adapters/package.json",
  "packages/memory/package.json",
];
const stableSemver = /^(\d+)\.(\d+)\.(\d+)$/;
const corepackCommand = process.platform === "win32" ? process.execPath : "corepack";
const corepackPrefix =
  process.platform === "win32"
    ? [join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js")]
    : [];

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
}

function runCorepack(args) {
  run(corepackCommand, [...corepackPrefix, ...args]);
}

function assertCleanTree() {
  if (git(["status", "--porcelain"])) {
    throw new Error("Working tree must be clean before release versioning/check.");
  }
}

function versions() {
  return packageFiles.map((path) => ({ path, version: readJson(path).version }));
}

function assertSynchronized() {
  const items = versions();
  const canonical = items[0].version;
  if (!stableSemver.test(canonical)) {
    throw new Error(`Root package version is not stable SemVer: ${canonical}`);
  }
  const mismatches = items.filter((item) => item.version !== canonical);
  if (mismatches.length) {
    throw new Error(
      `Package versions must match root ${canonical}: ${mismatches
        .map((item) => `${item.path}=${item.version}`)
        .join(", ")}`,
    );
  }
  return canonical;
}

function assertTagAbsent(version) {
  if (git(["tag", "--list", `v${version}`])) {
    throw new Error(`Tag v${version} already exists.`);
  }
}

function nextVersion(current, spec) {
  if (stableSemver.test(spec)) return spec;
  const match = stableSemver.exec(current);
  if (!match) throw new Error(`Invalid current version: ${current}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error("Version must be major, minor, patch, or x.y.z.");
}

function writeVersions(version) {
  for (const path of packageFiles) {
    const full = join(root, path);
    const pkg = JSON.parse(readFileSync(full, "utf8"));
    pkg.version = version;
    writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }
}

function checkLockfile() {
  runCorepack(["pnpm", "install", "--lockfile-only", "--frozen-lockfile"]);
}

function validateRelease(version) {
  assertTagAbsent(version);
  checkLockfile();
  runCorepack(["pnpm", "-r", "build"]);
  runCorepack(["pnpm", "-r", "test"]);
}

const [mode, requested] = process.argv.slice(2);

try {
  if (mode === "check") {
    assertCleanTree();
    const version = assertSynchronized();
    validateRelease(version);
    console.log(`Release checks passed for v${version}.`);
  } else if (mode === "version") {
    assertCleanTree();
    const current = assertSynchronized();
    const target = nextVersion(current, requested ?? "");
    if (target === current) throw new Error("Target version must differ from current version.");
    assertTagAbsent(target);
    writeVersions(target);
    runCorepack(["pnpm", "install", "--lockfile-only"]);
    assertSynchronized();
    runCorepack(["pnpm", "-r", "build"]);
    runCorepack(["pnpm", "-r", "test"]);
    console.log(`Version updated to ${target}. Review and commit the changes, then create tag v${target} intentionally.`);
  } else {
    throw new Error("Usage: release-version.mjs check | version <major|minor|patch|x.y.z>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
