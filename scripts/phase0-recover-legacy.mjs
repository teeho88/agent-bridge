import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const freeze = join(root, 'next/.local/legacy-freeze');
const manifestId = '8f9ee3f72712a23d0e0c8305ec0c2b847700e59fc684995fbeeb9a69b712937e';
const output = join(root, 'docs/phase0-20261016/recovery.json');
if (existsSync(output)) throw new Error('Recovery evidence already exists');
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = readFileSync(join(freeze, manifestId + '.json'));
if (hash(bytes) !== manifestId) throw new Error('Manifest hash mismatch');
const manifest = JSON.parse(bytes);
if (resolve(manifest.project) !== root) throw new Error('Archive belongs to another project');
function inside(base, path) {
  const target = resolve(base, path), offset = relative(base, target);
  if (!offset || offset === '..' || offset.startsWith('..\\') || offset.startsWith('../') || isAbsolute(offset)) throw new Error('Unsafe archive path');
  for (let current = target; current !== base; current = dirname(current))
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Archive target contains a link');
  return target;
}
const missing = [], matching = [];
for (const entry of manifest.archive) {
  const data = readFileSync(inside(freeze, entry.blob));
  if (hash(data) !== entry.sha256 || data.length !== entry.bytes) throw new Error('Archive corruption: ' + entry.path);
  const target = inside(root, entry.path);
  if (existsSync(target)) {
    if (hash(readFileSync(target)) !== entry.sha256) throw new Error('Existing source drift: ' + entry.path);
    matching.push(entry.path);
  } else if (/^packages\/(cli|core|memory|adapters)\//.test(entry.path)) missing.push(entry);
}
for (const entry of missing) {
  const target = inside(root, entry.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(inside(freeze, entry.blob)), { flag: 'wx' });
  if (hash(readFileSync(target)) !== entry.sha256) throw new Error('Restore mismatch: ' + entry.path);
}
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), manifestId, archiveCreatedAt: manifest.createdAt,
  archiveFilesVerified: manifest.archive.length, matchingSurvivors: matching, driftingSurvivors: [],
  restoredFiles: missing.map(entry => ({ path: entry.path, sha256: entry.sha256 })),
  existingFilesOverwritten: 0, stateModified: false, dependenciesRestored: false, version: '0.1.1',
  provenanceLimit: 'Matches every surviving archived file; no Git history exists to prove changes to files that were entirely missing.' };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ report: relative(root, output), restored: missing.length, archiveFilesVerified: manifest.archive.length }));
