import { lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, parse, join } from 'node:path';
import { BridgeError } from './schema.mjs';
import { canonical, sha256 } from './artifacts.mjs';

const denied = new Set(['evaluator', '.evaluator', '.git', '.agent-memory', '.codex', '.claude', '.aws', '.ssh', 'node_modules', '.bridge-home', '.bridge-tmp']);
export function sourceError(code, field, expected) { throw new BridgeError(code, field, expected); }
export function sourcePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value) || /[\x00-\x1f:*?"<>|]/.test(value)) sourceError('PATH_INVALID', '/path', 'portable relative path');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || denied.has(p.toLowerCase()) || /^\.env(?:\.|$)/i.test(p)))
    sourceError('PATH_FORBIDDEN', '/path', 'source path without private/control/dependency segments');
  return value;
}
export function noLinks(location, allowMissing = false) {
  const full = resolve(location);
  let current = parse(full).root;
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (allowMissing && ['ENOENT','ENOTDIR'].includes(error.code)) return full; throw error; }
    if (stat.isSymbolicLink()) sourceError('PATH_ESCAPE', '/path', 'no symlink/junction in path');
  }
  return full;
}
export function contained(root, relativePath) {
  sourcePath(relativePath);
  const full = resolve(root, relativePath);
  const offset = relative(resolve(root), full);
  if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) sourceError('PATH_ESCAPE', '/path', 'path inside project');
  return noLinks(full, true);
}
export function disjoint(left, right) {
  const a = resolve(left), b = resolve(right);
  for (const [parent, child] of [[a,b],[b,a]]) {
    const offset = relative(parent,child);
    if (!offset || (offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset))) sourceError('ROOT_OVERLAP', '/roots', 'disjoint authoritative, host and workspace roots');
  }
}
export function scopes(input) {
  if (!Array.isArray(input) || !input.length || input.length > 128) sourceError('ALLOWLIST_INVALID', '/allowlist', '1–128 explicit source paths');
  const result = [...new Set(input.map(sourcePath))].sort();
  for (let i=0;i<result.length;i++) for(let j=i+1;j<result.length;j++)
    if (result[j].toLowerCase() === result[i].toLowerCase() || result[j].toLowerCase().startsWith(result[i].toLowerCase() + '/'))
      sourceError('ALLOWLIST_INVALID', '/allowlist', 'unique non-overlapping source paths');
  return result;
}
export const allowed = (name, allowlist) => allowlist.some(scope => name === scope || name.startsWith(scope + '/'));
export function tree(root, allowlist, { capture = false } = {}) {
  noLinks(root);
  const entries = [];
  const names = new Set();
  function visit(name) {
    const location = contained(root, name);
    let stat;
    try { stat = lstatSync(location); } catch(error) { if(error.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) {
      for (const child of readdirSync(location).sort()) visit(name + '/' + child);
    } else {
      if (!stat.isFile() || stat.nlink !== 1) sourceError('SOURCE_TYPE', '/path', 'regular file without hardlinks');
      const folded = name.normalize('NFC').toLowerCase();
      if (names.has(folded)) sourceError('PATH_ALIAS', '/path', 'unique portable path');
      names.add(folded);
      const bytes = readFileSync(location);
      entries.push({ path: name, hash: sha256(bytes), bytes: bytes.length, executable: Boolean(stat.mode & 0o111), ...(capture ? { content: bytes.toString('base64') } : {}) });
    }
  }
  for (const name of allowlist) visit(name);
  entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return { entries, hash: sha256(canonical(entries.map(({content,...entry})=>entry))), bytes: entries.reduce((n,e)=>n+e.bytes,0) };
}
export function assertWorkspaceTree(root, allowlist, git = false) {
  for (const name of readdirSync(root)) {
    if (['.bridge-home','.bridge-tmp'].includes(name) || (git && name === '.git')) continue;
    const possible = allowlist.some(scope => name === scope || name.startsWith(scope + '/') || scope.startsWith(name + '/'));
    if (!possible) sourceError('PATH_NOT_ALLOWLISTED', '/workspace', 'only explicitly copied source paths');
  }
  function scan(name) {
    if (allowed(name, allowlist)) return;
    const location = contained(root,name);
    if (!lstatSync(location).isDirectory()) sourceError('PATH_NOT_ALLOWLISTED','/workspace','only allowlisted files');
    for (const child of readdirSync(location)) scan(name+'/'+child);
  }
  for(const name of readdirSync(root)) if (!['.bridge-home','.bridge-tmp'].includes(name) && !(git && name === '.git')) scan(name);
}
