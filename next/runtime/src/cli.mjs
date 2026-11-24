#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BridgeError, checkpointSchema, lookupSchema, validate, checkpointTemplate } from './schema.mjs';

export async function main(args) {
  const [command, ...rest] = args;
  if (command === 'schema' && rest.length <= 1) {
    if (rest[0] && !['checkpoint', 'lookup'].includes(rest[0])) throw new BridgeError('USAGE', '/tool', 'checkpoint or lookup');
    return rest[0] === 'lookup' ? lookupSchema : checkpointSchema;
  }
  if (command === 'template' && rest.length === 0) return checkpointTemplate();
  if (command === 'validate' && rest.length === 1) {
    validate(checkpointSchema, JSON.parse(readFileSync(rest[0], 'utf8')));
    return { valid: true, schemaVersion: 1 };
  }
  if (['checkpoint', 'lookup'].includes(command) && rest.length === 3) {
    const [directory, sessionId, file] = rest;
    const input = JSON.parse(readFileSync(file, 'utf8'));
    const { TaskStore } = await import('./store.mjs');
    const store = new TaskStore(directory);
    try { return store[command](sessionId, input); } finally { store.close(); }
  }
  throw new BridgeError('USAGE', '/', 'schema [checkpoint|lookup] | template | validate <utf8-file> | checkpoint|lookup <store> <host-session> <utf8-file>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await main(process.argv.slice(2))) + '\n'); }
  catch (error) {
    const failure = error instanceof BridgeError ? error.toJSON() : { code: 'INPUT_ERROR', field: '/', expected: 'valid UTF-8 JSON input and accessible v2 store', currentVersion: null };
    process.stderr.write(JSON.stringify(failure) + '\n');
    process.exitCode = 1;
  }
}
