import Ajv from 'ajv';

const text = { type: 'string', minLength: 1, maxLength: 8192 };
const identifier = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const version = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const strings = { type: 'array', maxItems: 256, uniqueItems: true, items: text };
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
export const fileReferenceSchema = object({ path: text, hash, sourceRevision: text });
export const decisionSchema = object({
  key: identifier, value: text, reason: text,
  revision: { ...version, minimum: 1 },
  supersedes: { anyOf: [{ ...version, minimum: 1 }, { type: 'null' }] },
});
export const checkpointSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://bridge.local/v2/checkpoint.schema.json',
  ...object({
    schemaVersion: { const: 1 }, idempotencyKey: identifier,
    expectedVersion: version,
    status: { enum: ['working', 'handoff', 'complete'] },
    completed: strings,
    decisions: { type: 'array', maxItems: 256, items: decisionSchema },
    issues: strings, next: strings,
    files: { type: 'array', maxItems: 256, items: fileReferenceSchema },
    evidence: { type: 'array', maxItems: 256, uniqueItems: true,
      items: { type: 'string', pattern: '^artifact:[a-f0-9]{64}$' } },
  }),
  examples: [{ schemaVersion: 1, idempotencyKey: 'checkpoint-1', expectedVersion: 0,
    status: 'handoff', completed: ['Updated requested files'],
    decisions: [{ key: 'text-encoding', value: 'UTF-8', reason: 'Preserve existing file encoding',
      revision: 1, supersedes: null }], issues: [], next: ['Run relevant checks'], files: [], evidence: [] }],
};
export const lookupSchema = object({
  schemaVersion: { const: 1 }, reference: { type: 'string',
    pattern: '^(artifact:[a-f0-9]{64}|event:[A-Za-z0-9_-]{1,128}:[1-9][0-9]*)$' },
});
export const taskSchema = object({ id: identifier, objective: text, constraints: strings, sourceRevision: text });
export const sessionSchema = object({ id: identifier, taskId: identifier, provider: identifier, workspace: text });
export const artifactMetadataSchema = object({
  taskId: identifier,
  kind: { enum: ['command', 'test', 'note', 'file'] },
  provenance: { enum: ['runtime-observed', 'agent-reported'] },
  sourceRevision: text,
  command: { anyOf: [text, { type: 'null' }] },
  exitStatus: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  observedResult: { anyOf: [text, { type: 'null' }] },
});
artifactMetadataSchema.properties.sourceHash={anyOf:[hash,{type:'null'}]};
export const stateSchema = object({
  schemaVersion: { const: 1 }, objective: text, constraints: strings,
  status: { enum: ['working', 'handoff', 'complete'] },
  decisions: { type: 'array', maxItems: 256, items: decisionSchema },
  completed: strings, issues: strings, next: strings,
  files: { type: 'array', maxItems: 256, items: fileReferenceSchema },
  evidence: { type: 'array', maxItems: 256, uniqueItems: true,
    items: { type: 'string', pattern: '^artifact:[a-f0-9]{64}$' } },
});
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map();
export class BridgeError extends Error {
  constructor(code, field, expected, currentVersion = null) {
    super(code + ' at ' + field + ': expected ' + expected);
    this.name = 'BridgeError';
    Object.assign(this, { code, field, expected, currentVersion });
  }
  toJSON() {
    return { code: this.code, field: this.field, expected: this.expected, currentVersion: this.currentVersion };
  }
}
export function validate(schema, value, currentVersion = null) {
  let validator = validators.get(schema);
  if (!validator) { validator = ajv.compile(schema); validators.set(schema, validator); }
  if (!validator(value)) {
    const error = validator.errors[0];
    const suffix = error.params.missingProperty || error.params.additionalProperty;
    throw new BridgeError('SCHEMA_INVALID', (error.instancePath || '') + (suffix ? '/' + suffix : '') || '/',
      error.keyword === 'type' ? error.params.type : error.keyword + ' ' + JSON.stringify(error.params), currentVersion);
  }
  return value;
}
export function checkpointTemplate() { return structuredClone(checkpointSchema.examples[0]); }
export const toolMetadata = [
  { name: 'bridge.checkpoint', description: 'Atomically save a versioned task delta. Session identity is supplied by the host.', inputSchema: checkpointSchema },
  { name: 'bridge.lookup', description: 'Read one exact artifact or event reference bound to this task.', inputSchema: lookupSchema },
];
