import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function requireRevisionRoundPointer(path, expectedHash = null) {
  if (!existsSync(path)) {
    if (expectedHash !== null) throw Error('Frozen round pointer missing');
    return true;
  }
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw Error('Round pointer already exists; refuse replay');
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expectedHash)
    throw Error('Frozen round pointer changed');
  return true;
}
