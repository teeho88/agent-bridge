import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value);
const bindingFields = ['protocolHash', 'runId', 'threadId', 'turnId', 'attemptId', 'attempt'];

export function providerObservationBinding(protocolHash, row) {
  return { protocolHash, runId: row.launch?.runId, threadId: row.launch?.threadId, turnId: row.launch?.turnId,
    attemptId: row.attemptId, attempt: row.attempt };
}

export function providerObservationAncestors(rows, row) {
  const result = [], seen = new Set();
  let current = row;
  while (current) {
    if (seen.has(current.id) || current.phase !== row.phase || current.branch !== row.branch ||
        current.workspace !== row.workspace || rows.indexOf(current) > rows.indexOf(row)) throw Error('Invalid provider observation ancestry');
    seen.add(current.id); result.push(current);
    if (!current.continuationFrom) break;
    const parent = rows.find(item => item.id === current.continuationFrom);
    if (!parent || rows.indexOf(parent) >= rows.indexOf(current)) throw Error('Invalid provider observation predecessor');
    current = parent;
  }
  return result.reverse();
}

export function isProviderLaunchFailure(message) {
  const item = message?.params?.item;
  return message?.method === 'item/completed' && item?.type === 'commandExecution' && identifier(item.id) &&
    item.source === 'unifiedExecStartup' && item.status === 'failed' && item.processId === null &&
    Number.isInteger(item.exitCode) && item.exitCode !== 0 &&
    typeof item.command === 'string' && item.command.length > 0 &&
    typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 0;
}

export function isCompletedCommandEvent(message) {
  const item = message?.params?.item;
  return message?.method === 'item/completed' && item?.type === 'commandExecution' &&
    identifier(item.id) && typeof item.command === 'string' && item.command.length > 0 &&
    (typeof item.aggregatedOutput === 'string' || item.aggregatedOutput === null) && !isProviderLaunchFailure(message);
}

export function providerObservationKind(message) {
  if (isProviderLaunchFailure(message)) return 'provider-launch-failure';
  if (isCompletedCommandEvent(message)) return 'provider-completed-command';
  return null;
}

function validatePayload(payload, kind = 'provider-launch-failure') {
  if (!payload || Object.keys(payload).sort().join(',') !== 'binding,envelope') throw Error('Invalid provider observation payload');
  const binding = payload.binding;
  if (!binding || Object.keys(binding).sort().join(',') !== [...bindingFields].sort().join(',') ||
      !/^[a-f0-9]{64}$/.test(binding.protocolHash ?? '') ||
      bindingFields.slice(1, 5).some(field => !identifier(binding[field])) || !Number.isSafeInteger(binding.attempt) || binding.attempt < 1) {
    throw Error('Invalid provider observation binding');
  }
  const envelope = payload.envelope;
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'at,message' ||
      typeof envelope.at !== 'string' || !Number.isFinite(Date.parse(envelope.at)) ||
      !(kind === 'provider-launch-failure' ? isProviderLaunchFailure(envelope.message) :
        kind === 'provider-completed-command' && isCompletedCommandEvent(envelope.message))) {
    throw Error(kind === 'provider-launch-failure' ? 'Provider observation requires a complete startup-failure event' :
      'Provider observation requires a complete executed command event');
  }
  for (const field of ['threadId', 'turnId']) {
    const actual = envelope.message.params[field];
    if (actual !== undefined && actual !== binding[field]) throw Error('Provider event/binding mismatch: ' + field);
  }
}

export function createProviderObservationKeys() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }) };
}

export function signProviderObservation(envelope, binding, privateKey) {
  return signObservation(envelope, binding, privateKey, 'provider-launch-failure');
}

export function signCompletedCommandObservation(envelope, binding, privateKey) {
  return signObservation(envelope, binding, privateKey, 'provider-completed-command');
}

function signObservation(envelope, binding, privateKey, kind) {
  const payload = structuredClone({ binding, envelope });
  validatePayload(payload, kind);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 provider observation key required');
  return { schemaVersion: kind === 'provider-launch-failure' ? 1 : 2, kind, payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64') };
}

export function verifyProviderObservation(observation, publicKey, { binding = {}, envelope } = {}) {
  if (!observation || Object.keys(observation).sort().join(',') !== 'kind,payload,schemaVersion,signature' ||
      !((observation.schemaVersion === 1 && observation.kind === 'provider-launch-failure') ||
        (observation.schemaVersion === 2 && observation.kind === 'provider-completed-command')) ||
      typeof observation.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(observation.signature)) {
    throw Error('Invalid signed provider observation');
  }
  validatePayload(observation.payload, observation.kind);
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(JSON.stringify(observation.payload)), key,
      Buffer.from(observation.signature, 'base64'))) throw Error('Provider observation signature mismatch');
  for (const [field, expected] of Object.entries(binding)) {
    if (!bindingFields.includes(field) || observation.payload.binding[field] !== expected) throw Error('Provider observation binding mismatch: ' + field);
  }
  if (envelope !== undefined && JSON.stringify(envelope) !== JSON.stringify(observation.payload.envelope)) {
    throw Error('Provider observation differs from original raw event');
  }
  return { ...observation.payload, eventId: observation.payload.envelope.message.params.item.id,
    kind: observation.kind,
    output: observation.payload.envelope.message.params.item.aggregatedOutput };
}
