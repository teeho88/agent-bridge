const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const workspace = fs.realpathSync.native(process.cwd());
function sameExecutable(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left === right) return true;
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const actual = file => {
    const resolved = fs.realpathSync.native(file);
    return process.platform === 'win32' ? path.toNamespacedPath(resolved).toLowerCase() : resolved;
  };
  return actual(left) === actual(right);
}
function contained(name) {
  if (typeof name !== 'string' || name.includes('\0') || name.split(/[\\/]/).includes('..') || /^[/\\]{2}/.test(name)) throw Error('Invalid evidence path');
  const target = path.resolve(workspace, name);
  function check(value) { const rel = path.relative(workspace, value); if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('Evidence path escapes workspace'); }
  check(target);
  let ancestor = target;
  while (ancestor !== workspace) {
    let stat; try { stat = fs.lstatSync(ancestor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) check(fs.realpathSync.native(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return target;
}
const input = JSON.parse(fs.readFileSync(contained(process.argv[2]), 'utf8'));
if (!/^[A-Za-z0-9_-]+$/.test(input.id ?? '') || typeof input.executable !== 'string' || !Array.isArray(input.argv) || input.argv.some(arg => typeof arg !== 'string')) throw Error('Expected unique command ID and structured executable/argv');
const timeoutMs = input.timeoutMs ?? 30000;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw Error('timeoutMs must be an integer between 1 and 600000');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const argv = [...input.argv];
const nodeExecutable = /^(?:node|node\.exe)$/i.test(path.basename(input.executable)) || input.executable === process.execPath;
let startupContext;
if (input.startupContext !== undefined) {
  const reference = input.startupContext;
  if (!reference || Object.keys(reference).sort().join(',') !== 'hash,path' ||
      !/^\.bridge-runtime\/evidence\/context-startup(?:-[A-Za-z0-9_-]+)?\.json$/.test(reference.path ?? '') ||
      !/^[a-f0-9]{64}$/.test(reference.hash ?? '') || !nodeExecutable ||
      !['task', 'session'].includes(argv[1]) || argv[2] !== 'start') throw Error('Invalid paired startup context reference');
  const contextPath = contained(reference.path);
  if (hash(contextPath) !== reference.hash) throw Error('Startup context spec hash mismatch');
  const spec = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  if (spec.id !== path.basename(contextPath, '.json') || spec.id === input.id || !sameExecutable(spec.executable, input.executable) ||
      JSON.stringify(spec.argv) !== JSON.stringify([argv[0], 'context', 'startup', '--agent', 'codex']) ||
      spec.startupContext !== undefined || !Number.isSafeInteger(spec.timeoutMs ?? 30000) ||
      (spec.timeoutMs ?? 30000) < 1 || (spec.timeoutMs ?? 30000) > 600000) throw Error('Invalid paired context startup spec');
  if (fs.existsSync(contained('.handoff/commands/' + spec.id))) throw Error('Context capture ID already reserved; no startup replay');
  startupContext = { path: contextPath, spec, hash: reference.hash };
}
if (process.platform === 'win32' && nodeExecutable && argv[0] === '--test') {
  if (argv.some(arg => arg.startsWith('--experimental-test-isolation=') && arg !== '--experimental-test-isolation=none')) throw Error('Windows Node tests require --experimental-test-isolation=none');
  if (!argv.includes('--experimental-test-isolation=none')) argv.splice(argv.indexOf('--test') + 1, 0, '--experimental-test-isolation=none');
}
const parent = contained('.handoff/commands'); fs.mkdirSync(parent, { recursive: true }); contained(parent);
const directory = contained(path.join(parent, input.id)); fs.mkdirSync(directory); contained(directory);
const stdoutPath = path.join(directory, 'stdout.log'), stderrPath = path.join(directory, 'stderr.log');
const stdout = fs.openSync(stdoutPath, 'wx'), stderr = fs.openSync(stderrPath, 'wx');
const startedAt = new Date().toISOString();
let result;
try { result = cp.spawnSync(input.executable, argv, { cwd: workspace, env: process.env, stdio: ['ignore', stdout, stderr], windowsHide: true, timeout: timeoutMs }); }
catch (error) { result = { status: null, signal: null, error }; }
finally { fs.closeSync(stdout); fs.closeSync(stderr); }
const portable = file => path.relative(workspace, file).replaceAll('\\', '/');
const receipt = { schemaVersion: 1, id: input.id, executable: input.executable, argv, timeoutMs, cwd: workspace,
  startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.stack ?? null,
  stdout: { path: portable(stdoutPath), hash: hash(stdoutPath) }, stderr: { path: portable(stderrPath), hash: hash(stderrPath) } };
const receiptPath = path.join(directory, 'command.json'); fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ commandId: input.id, receipt: portable(receiptPath), sha256: hash(receiptPath), exitCode: receipt.exitCode }));
process.exitCode = result.status ?? 2;
if (startupContext && result.status === 0 && !result.signal && !result.error) {
  const lifecycleOutput = fs.readFileSync(stdoutPath, 'utf8').replace(/\x1b\](?:0|2);[^\x07\r\n]*\x07/g, '');
  const starts = [...lifecycleOutput.matchAll(/^(?:Bound codex session|Started codex session) (\S+) (?:to|for) (\S+)\r?$/gm)];
  if (starts.length !== 1) throw Error('Captured lifecycle startup task/session binding missing or ambiguous');
  if (hash(startupContext.path) !== startupContext.hash) throw Error('Startup context spec changed after lifecycle start');
  const contextResult = cp.spawnSync(process.execPath, [__filename, startupContext.path], {
    cwd: workspace, env: process.env, encoding: 'utf8', windowsHide: true,
    timeout: (startupContext.spec.timeoutMs ?? 30000) + 5000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(contextResult.stdout ?? '');
  process.stderr.write(contextResult.stderr ?? '');
  process.exitCode = contextResult.status ?? 2;
  if (contextResult.error) process.stderr.write(contextResult.error.stack + '\n');
  if (contextResult.status === 0 && !contextResult.signal && !contextResult.error) {
    const contextReceiptPath = contained('.handoff/commands/' + startupContext.spec.id + '/command.json');
    const contextReceipt = JSON.parse(fs.readFileSync(contextReceiptPath, 'utf8'));
    const pointer = JSON.parse(contextResult.stdout.trim());
    if (pointer.commandId !== startupContext.spec.id || pointer.receipt !== portable(contextReceiptPath) ||
        pointer.sha256 !== hash(contextReceiptPath) || pointer.exitCode !== contextReceipt.exitCode ||
        contextReceipt.exitCode !== 0 || contextReceipt.signal || contextReceipt.error || contextReceipt.cwd !== workspace ||
        contextReceipt.executable !== startupContext.spec.executable || JSON.stringify(contextReceipt.argv) !== JSON.stringify(startupContext.spec.argv)) throw Error('Captured context receipt binding mismatch');
    const contextOutputPath = contained(contextReceipt.stdout.path), contextErrorPath = contained(contextReceipt.stderr.path);
    if (hash(contextOutputPath) !== contextReceipt.stdout.hash || hash(contextErrorPath) !== contextReceipt.stderr.hash) throw Error('Captured context stream hash mismatch');
    const output = fs.readFileSync(contextOutputPath, 'utf8');
    const tasks = [...output.matchAll(/^Task: (.+)\r?$/gm)], sessions = [...output.matchAll(/^Session: (.+)\r?$/gm)];
    if (tasks.length !== 1 || sessions.length !== 1 || tasks[0][1].trim() !== starts[0][2] || sessions[0][1].trim() !== starts[0][1]) throw Error('Lifecycle context startup task/session binding missing or inconsistent');
  }
}
