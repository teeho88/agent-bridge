import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function leaseSnapshotHash(repositoryRoot: string, path: string): string | undefined {
  const root = realpathSync(repositoryRoot);
  const target = resolve(root, path);
  const local = relative(root, target);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error("Recovery path escapes repository");
  if (!existsSync(target)) return undefined;
  const inspect = (file: string): string => {
    const actual = realpathSync(file);
    const local = relative(root, actual);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) || lstatSync(file).isSymbolicLink())
      throw new Error("Recovery snapshot cannot follow symbolic links");
    if (!lstatSync(file).isDirectory()) return createHash("sha256").update(readFileSync(file)).digest("hex");
    const entries = readdirSync(file).sort().map(name => [name, inspect(resolve(file, name))]);
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  };
  return inspect(target);
}
