import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export function repositoryIdentity(cwd: string, options: { includeBaseCommit?: boolean } = {}): { repositoryId: string; branch: string; baseCommit?: string } {
  const git = (args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (options.includeBaseCommit === false) {
    try {
      const [root, branch] = git(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]).split(/\r?\n/);
      if (root && branch && branch !== "HEAD") return { repositoryId: realpathSync.native(root), branch };
    } catch {}
  }
  let root: string;
  try { root = git(["rev-parse", "--show-toplevel"]); }
  catch { return { repositoryId: realpathSync.native(cwd), branch: "unversioned" }; }
  let baseCommit: string | undefined;
  try { baseCommit = git(["rev-parse", "HEAD"]); } catch { baseCommit = undefined; }
  let branch: string;
  try { branch = git(["symbolic-ref", "--short", "HEAD"]); }
  catch { branch = `detached:${baseCommit ?? "unknown"}`; }
  return { repositoryId: realpathSync.native(root), branch, baseCommit };
}
