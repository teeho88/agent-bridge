import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { containedPath, projectRoot } from './remediation-policy.mjs';

const packages = ['memory', 'core', 'adapters', 'cli'];
const defaults = { B: join(projectRoot, 'docs/phase8-recovery-20261019/validated/baseline-source'), S: projectRoot };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function directory(path) {
  path = containedPath(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Build directory required without links: ' + path);
  return path;
}

function expectedInventory(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw Error('Missing build inventory: ' + label);
  const names = new Set();
  for (const [name, digest] of Object.entries(value)) {
    if (!name || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') ||
        names.has(name.toLowerCase()) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid build inventory entry: ' + label + '/' + name);
    names.add(name.toLowerCase());
  }
  return value;
}

function inventory(root, selectedSource = false) {
  const result = Object.create(null);
  function walk(name) {
    const path = containedPath(join(root, name), root);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Build inventory rejects links: ' + path);
    if (stat.isFile()) result[name] = hash(path);
    else if (stat.isDirectory()) {
      for (const item of readdirSync(path)) {
        if (selectedSource && (item === 'node_modules' || item === 'dist' || item.endsWith('.tsbuildinfo'))) continue;
        walk(name ? name + '/' + item : item);
      }
    } else throw Error('Build inventory rejects special files: ' + path);
  }
  if (selectedSource) {
    for (const name of ['package.json', 'tsconfig.base.json']) {
      const file = containedPath(join(root, name), root);
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw Error('Source input file required: ' + file);
      walk(name);
    }
    for (const name of packages) {
      directory(join(root, 'packages', name));
      walk('packages/' + name);
    }
  } else {
    for (const name of readdirSync(root)) walk(name);
  }
  return result;
}

function verify(actual, expected, label) {
  const names = Object.keys(actual).sort(), wanted = Object.keys(expected).sort();
  if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) throw Error('Build inventory file set mismatch: ' + label);
  for (const name of names) if (actual[name] !== expected[name]) throw Error('Build inventory hash mismatch: ' + label + '/' + name);
}

export function validateCampaignBuild(build) {
  if (!build || build.passed !== true || build.protectedEvidenceUnchanged !== true || build.error != null) throw Error('Successful independent B/S build with unchanged protected evidence required');
  if (!build.branches || typeof build.branches !== 'object' || Array.isArray(build.branches) ||
      Object.keys(build.branches).sort().join(',') !== 'B,S') throw Error('Complete B/S build branches required');
  for (const branch of ['B', 'S']) {
    const built = build.branches[branch];
    if (!built || typeof built !== 'object' || Array.isArray(built)) throw Error('Missing build branch: ' + branch);
    const runtime = directory(built.runtime), snapshot = directory(built.sourceSnapshot);
    const origin = directory(built.origin === undefined ? defaults[branch] : built.origin);
    const runtimeHashes = expectedInventory(built.runtimeHashes, branch + ' runtime');
    const source = expectedInventory(built.source, branch + ' source');
    verify(inventory(runtime), runtimeHashes, branch + ' runtime');
    verify(inventory(snapshot), source, branch + ' source snapshot');
    verify(inventory(origin, true), source, branch + ' current origin source');
  }
  return build;
}
