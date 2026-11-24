const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const originalSpawnSync = cp.spawnSync;

function spawnSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};
  const requested = options.stdio === 'inherit' ? ['inherit', 'inherit', 'inherit']
    : options.stdio === 'ignore' ? ['ignore', 'ignore', 'ignore']
    : Array.isArray(options.stdio) ? options.stdio : ['pipe', 'pipe', 'pipe'];
  if (!requested.some(value => value === 'pipe' || value == null)) return originalSpawnSync(file, args, options);
  const directory = path.join(process.cwd(), '.bridge-tmp', 'stdio-' + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const fds = [], captures = {};
  try {
    const stdio = [0, 1, 2].map(index => {
      const mode = requested[index] ?? 'pipe';
      if (mode !== 'pipe') return mode;
      const target = path.join(directory, String(index));
      if (index === 0) fs.writeFileSync(target, options.input ?? '');
      else captures[index] = target;
      const fd = fs.openSync(target, index === 0 ? 'r' : 'w');
      fds.push(fd); return fd;
    });
    const result = originalSpawnSync(file, args, { ...options, input: undefined, stdio });
    for (const fd of fds.splice(0)) fs.closeSync(fd);
    const output = [null, null, null];
    for (const index of [1, 2]) if (captures[index]) {
      const bytes = fs.readFileSync(captures[index]);
      output[index] = options.encoding && options.encoding !== 'buffer' ? bytes.toString(options.encoding) : bytes;
      if (options.maxBuffer && bytes.length > options.maxBuffer && !result.error) {
        result.error = Object.assign(new Error('Native stdio maxBuffer exceeded'), { code: 'ENOBUFS' });
      }
    }
    return { ...result, output, stdout: output[1], stderr: output[2] };
  } finally {
    for (const fd of fds) fs.closeSync(fd);
    const absolute = path.resolve(directory), parent = path.resolve(process.cwd(), '.bridge-tmp');
    if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith('stdio-')) throw new Error('Unsafe stdio cleanup path');
    fs.rmSync(absolute, { recursive: true });
  }
}
cp.spawnSync = spawnSync;
cp.execFileSync = function (file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const result = spawnSync(file, args, options);
  if (result.error || result.status !== 0) {
    const error = result.error ?? new Error('Command failed: ' + file);
    Object.assign(error, { status: result.status, signal: result.signal, pid: result.pid,
      output: result.output, stdout: result.stdout, stderr: result.stderr });
    throw error;
  }
  return result.stdout;
};
require('node:module').syncBuiltinESMExports();
