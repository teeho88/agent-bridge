import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { containedPath, validateModel } from './remediation-policy.mjs';

export const agyBuiltinBackend = 'agy-trusted-host-builtin-sandbox-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const agySettingsHash = settings => hash(JSON.stringify(canonical(settings)));
export function agyBuiltinSettings({ workspace, protectedPaths = [] }) {
  const root = containedPath(workspace);
  const normalized = path => resolve(path).replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
  const denied = protectedPaths.map(path => {
    const target = resolve(path);
    const relative = win32.relative(root, target), reverse = win32.relative(target, root);
    const outside = path => path === '..' || path.startsWith('..\\') || win32.isAbsolute(path);
    if (!outside(relative) || !outside(reverse)) throw Error('Protected path overlaps writable workspace');
    return 'read_file(' + normalized(target) + ')';
  });
  return { enableTerminalSandbox: true, toolPermission: 'proceed-in-sandbox',
    permissions: { deny: ['unsandboxed(*)', 'mcp(*)', 'execute_url(*)', 'read_url(*)', 'read_file(.bridge-home)', 'read_file(.agents)', 'write_file(AGENTS.md)', ...denied] } };
}

export function configureAgyBuiltin({ workspace, protectedPaths }) {
  const directory = containedPath(join(workspace, '.bridge-home/.gemini/antigravity-cli'), containedPath(workspace));
  mkdirSync(directory, { recursive: true });
  const settings = agyBuiltinSettings({ workspace, protectedPaths });
  const path = join(directory, 'settings.json');
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx' });
  return { backend: agyBuiltinBackend, workspace: resolve(workspace), settingsPath: path, settingsHash: agySettingsHash(settings),
    settingsRawHash: hash(readFileSync(path)), requirements: { allowPaidFallback: false, allowNonWorkspaceAccess: false } };
}

export function agyBuiltinArguments({ capability, prompt = null }) {
  validateModel({ provider: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' }, capability);
  const args = ['--sandbox', '--model', 'gemini-3.8-flash-high', '--effort', 'high'];
  if (prompt !== null) {
    if (capability.timeoutSupported !== true || typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) throw Error('Invalid builtin prompt/capability');
    args.push('--print-timeout', '3600s', '--output-format', 'stream-json', '--disable-slash-commands', '--print', prompt);
  }
  const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  if (args.map(quote).join(' ').length + 1024 > 32766) throw Error('Windows argv limit');
  return args;
}

export function verifyAgyBuiltinProof(proof, config, binaryHash) {
  if (config.backend !== agyBuiltinBackend || proof?.backend !== agyBuiltinBackend || proof.passed !== true ||
    proof.workspace !== config.workspace || proof.binaryHash !== binaryHash || proof.settingsHash !== config.settingsHash ||
    proof.hostAuthenticationVerified !== true || proof.commandBoundaryVerified !== true || proof.fileToolsBoundaryVerified !== true ||
    proof.noHostCommandFallbackVerified !== true || proof.nativeStopVerified !== true || proof.noPaidFallbackVerified !== true ||
    !/^[a-f0-9]{64}$/.test(proof.nativeCanaryReceiptHash ?? '') || agySettingsHash(JSON.parse(readFileSync(containedPath(config.settingsPath, config.workspace), 'utf8'))) !== config.settingsHash)
    throw Error('Same-workspace/binary/config builtin command/file/native-stop proof required before inference');
  return true;
}
