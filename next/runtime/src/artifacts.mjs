import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError, validate, artifactMetadataSchema } from './schema.mjs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
export function writeArtifact(directory, content, metadata) {
  validate(artifactMetadataSchema, metadata);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const envelope = Buffer.from(canonical({ schemaVersion: 1, metadata, content: body.toString('base64') }), 'utf8');
  const hash = sha256(envelope);
  const relativePath = 'artifacts/' + hash + '.json';
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  const target = join(directory, relativePath);
  const temporary = join(directory, 'artifacts', '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, envelope, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(readFileSync(target)) !== hash)
      throw new BridgeError('ARTIFACT_HASH_MISMATCH', '/artifact', hash);
  } finally { unlinkSync(temporary); }
  return { reference: 'artifact:' + hash, hash, relativePath, size: body.length, metadata };
}
export function readArtifact(directory, record) {
  const target = join(directory, record.relative_path);
  let envelope;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid file');
    envelope = readFileSync(target);
  } catch { throw new BridgeError('ARTIFACT_MISSING', '/reference', record.hash); }
  if (sha256(envelope) !== record.hash) throw new BridgeError('ARTIFACT_HASH_MISMATCH', '/reference', record.hash);
  const parsed = JSON.parse(envelope.toString('utf8'));
  if (canonical(parsed.metadata) !== record.metadata_json)
    throw new BridgeError('ARTIFACT_METADATA_MISMATCH', '/reference', 'committed metadata');
  return { reference: 'artifact:' + record.hash, metadata: parsed.metadata,
    content: Buffer.from(parsed.content, 'base64'), size: record.size };
}
