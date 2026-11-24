import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { noLinks, disjoint } from './source-paths.mjs';
import { maxNativeSessionMs } from './session-policy.mjs';

const helper = fileURLToPath(new URL('./windows-sandbox.ps1', import.meta.url));
export class WindowsHostJob {
  constructor({ control, environment, coordinatorTrusted = false }) {
    if (coordinatorTrusted !== true) throw Error('Explicit trusted host coordinator required');
    this.control = noLinks(resolve(control), true); mkdirSync(this.control, { recursive: true });
    this.environment = environment;
  }
  start({ workspace, executable, arguments: args = [], maxSessionMs = 30000, runId = null }) {
    const cwd = noLinks(resolve(workspace)), target = noLinks(resolve(executable));
    disjoint(cwd, this.control);
    if (!Number.isSafeInteger(maxSessionMs) || maxSessionMs < 1 || maxSessionMs > maxNativeSessionMs || !args.every(arg => typeof arg === 'string' && !arg.includes('\0')))
      throw Error('Invalid host coordinator argv/session deadline');
    for (const directory of ['.bridge-home', '.bridge-tmp', '.bridge-home/cache']) mkdirSync(join(cwd, directory), { recursive: true });
    if (runId !== null && !/^[a-f0-9-]{36}$/.test(runId)) throw Error('Expected host job UUID');
    const id = runId ?? randomUUID(), prefix = join(this.control, id);
    const paths = { stdout: prefix + '.stdout', stderr: prefix + '.stderr', stop: prefix + '.stop', receipt: prefix + '.receipt' };
    const request = prefix + '.json', launcher = prefix + '.launch.json';
    writeFileSync(request, JSON.stringify({ operation: 'host-run', hostCoordinator: true, executable: target, arguments: args,
      workspace: cwd, ...paths, parentId: process.pid, timeoutMs: maxSessionMs, nodeDirectory: dirname(process.execPath) }), { flag: 'wx' });
    writeFileSync(launcher, JSON.stringify({ operation: 'launch-supervisor', helper, supervisorRequest: request, cwd }), { flag: 'wx' });
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-RequestFile', launcher],
      { cwd: this.control, env: this.environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false, offset = 0, failure = '';
    child.stdout.on('data', bytes => { failure = (failure + bytes.toString('utf8')).slice(-8192); });
    child.stderr.on('data', bytes => { failure = (failure + bytes.toString('utf8')).slice(-8192); });
    const closed = new Promise(resolveResult => {
      const finish = value => { if (done) return; done = true; resolveResult(value); };
      child.once('error', error => finish({ writersStopped: null, error: error.message }));
      child.once('close', code => {
        if (code !== 0) return finish({ writersStopped: null, error: 'Host job supervisor launch failed', detail: failure });
        const deadline = Date.now() + maxSessionMs + 20000;
        const poll = setInterval(() => {
          let receipt;
          try { receipt = JSON.parse(readFileSync(paths.receipt, 'utf8')); } catch {}
          if (receipt || Date.now() > deadline) {
            clearInterval(poll);
            if (receipt?.hostCoordinator === true && receipt.appContainer === false && receipt.writersStopped === true && receipt.activeProcesses === 0)
              finish({ ...receipt, runId: id, stdoutPath: paths.stdout, stderrPath: paths.stderr });
            else finish({ writersStopped: null, error: 'Host job stop receipt unverified', detail: receipt ?? failure });
          }
        }, 25);
      });
    });
    return { closed, receiptPath: paths.receipt, runId: id,
      read() {
        if (!existsSync(paths.stdout)) return Buffer.alloc(0);
        const fd = openSync(paths.stdout, 'r');
        try {
          const size = fstatSync(fd).size - offset;
          if (size < 0) throw Error('Host coordinator output rewound');
          const bytes = Buffer.alloc(Math.min(size, 1024 * 1024));
          const count = readSync(fd, bytes, 0, bytes.length, offset); offset += count; return bytes.subarray(0, count);
        } finally { closeSync(fd); }
      },
      async stop() {
        if (!done && !existsSync(paths.stop)) writeFileSync(paths.stop, 'stop', { flag: 'wx' });
        let timer;
        try { return await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Host job stop timeout')), 20000); })]); }
        finally { clearTimeout(timer); }
      }
    };
  }
}
