import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseFiles = [
  "package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/adapters/package.json",
  "packages/memory/package.json",
  "pnpm-lock.yaml",
];

function defaultGit(args, options = {}) {
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return typeof output === "string" ? output.trim() : "";
}

function defaultRunVersion(spec) {
  execFileSync(process.execPath, [join(root, "scripts", "release-version.mjs"), "version", spec], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
}

function defaultReadVersion() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

export function validateVersionSpec(spec) {
  if (!/^(major|minor|patch|\d+\.\d+\.\d+)$/.test(spec ?? "")) {
    throw new Error("Version must be major, minor, patch, or x.y.z.");
  }
}

export function releaseAndPush(spec, dependencies = {}) {
  validateVersionSpec(spec);
  const git = dependencies.git ?? defaultGit;
  const runVersion = dependencies.runVersion ?? defaultRunVersion;
  const readVersion = dependencies.readVersion ?? defaultReadVersion;

  if (git(["status", "--porcelain"])) {
    throw new Error("Working tree must be clean before versioning and pushing.");
  }
  const branch = git(["branch", "--show-current"]);
  if (!branch) throw new Error("Cannot release from a detached HEAD.");
  git(["remote", "get-url", "origin"]);

  runVersion(spec);
  const version = readVersion();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Updated root package version is invalid: ${version}`);
  }
  const tag = `v${version}`;

  git(["add", "--", ...releaseFiles], { inherit: true });
  git(["commit", "-m", `release: ${tag}`], { inherit: true });
  git(["tag", "-a", tag, "-m", `Release ${tag}`], { inherit: true });
  try {
    git([
      "push",
      "--atomic",
      "origin",
      `HEAD:refs/heads/${branch}`,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ], { inherit: true });
  } catch (error) {
    throw new Error(
      `Created local commit and tag ${tag}, but push failed. Fix the remote issue, then push branch ${branch} and tag ${tag}.`,
      { cause: error },
    );
  }
  return { branch, tag, version };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = releaseAndPush(process.argv[2]);
    console.log(`Released ${result.tag} from ${result.branch} to origin.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
