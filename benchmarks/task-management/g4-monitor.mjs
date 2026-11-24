import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, '../..');
const diagnostics = join(root, 'docs/phase8-2-remediation-20261019/diagnostics');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function optionalJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function newestPointer() {
  const names = (await readdir(diagnostics, { withFileTypes: true }))
    .filter(item => item.isDirectory() && item.name.startsWith('g4-web-high-'));
  const options = await Promise.all(names.map(async item => {
    const path = join(diagnostics, item.name, 'round.json');
    try {
      const pointer = await readJson(path);
      const state = await stat(join(pointer.directory, 'state.json'));
      return { path, modified: state.mtimeMs };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  const sorted = options.filter(Boolean).sort((a, b) => b.modified - a.modified);
  if (!sorted.length) throw Error('Không tìm thấy round.json của G4 Web High; hãy dùng --pointer <path>');
  return sorted[0].path;
}

export async function resolvePointer(explicitPointer) {
  return explicitPointer ? resolve(explicitPointer) : newestPointer();
}

async function readEventTail(path, limit = 25) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size, mtime } = await handle.stat();
    const bytes = Math.min(size, 192 * 1024);
    if (!bytes) return { entries: [], modifiedAt: mtime.toISOString() };
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, size - bytes);
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = raw.split(/\r?\n/);
    if (size > bytes) lines.shift();
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const method = event.message?.method ?? 'unknown';
        const item = event.message?.params?.item;
        if (method === 'item/agentMessage/delta' && String(event.message?.params?.delta ?? '').includes('ChatGPT web turn broker timed out')) {
          entries.push({ at: event.at, method, label: 'Codex Native2: ChatGPT web turn broker timed out (model-reported)', failed: true });
          continue;
        }
        if (!['warning', 'turn/started', 'turn/completed', 'turn/failed', 'item/started', 'item/completed', 'thread/tokenUsage/updated', 'account/rateLimits/updated'].includes(method)) continue;
        let label = method;
        if (method === 'warning') label = String(event.message?.params?.message ?? 'Cảnh báo').slice(0, 240);
        else if (item) label = `${item.type ?? 'item'}${item.exitCode !== undefined ? ` · exit ${item.exitCode}` : ''}${item.status === 'failed' ? ' · FAILED' : ''}`;
        entries.push({ at: event.at, method, label, failed: method === 'warning' || item?.status === 'failed' || (item?.exitCode !== undefined && item.exitCode !== 0) });
      } catch { /* An append may leave an unfinished final JSONL record. */ }
    }
    return { entries: entries.slice(-limit).reverse(), modifiedAt: mtime.toISOString() };
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], modifiedAt: null };
    throw error;
  } finally { await handle?.close(); }
}

async function readRound(explicitPointer) {
  const pointerPath = await resolvePointer(explicitPointer);
  const pointer = await readJson(pointerPath);
  if (!pointer.directory || !pointer.protocol || !pointer.protocolHash) throw Error('Pointer G4 không hợp lệ');
  const [state, protocol] = await Promise.all([readJson(join(pointer.directory, 'state.json')), readJson(pointer.protocol)]);
  if (pointer.protocolHash !== state.protocolHash || pointer.protocolHash !== protocol.protocolHash) throw Error('G4 protocol/state identity mismatch');
  return { pointerPath, pointer, state, protocol };
}

export async function snapshot(explicitPointer) {
  const { pointerPath, pointer, state, protocol } = await readRound(explicitPointer);
  const directory = pointer.directory;
  const [ledger, partialAudit, finalAudit, finalReview, assessment, terminal] = await Promise.all([
    optionalJson(join(directory, 'smoke-content-review.json')),
    optionalJson(join(directory, 'smoke-audit.partial.json')),
    optionalJson(join(directory, 'smoke-audit.json')),
    optionalJson(join(directory, 'smoke-review.json')),
    optionalJson(join(directory, 'g4-assessment.json')),
    optionalJson(join(directory, 'g4-terminal-assessment.json')),
  ]);
  const reviews = new Map((ledger?.protocolHash === pointer.protocolHash ? ledger.rows : [])?.map(item => [item.id, item]) ?? []);
  const allAttempts = state.slots.filter(row => row.phase === 'smoke');
  const rows = await Promise.all((protocol.smoke ?? []).map(async slot => {
    const attempts = allAttempts.filter(row => (row.slotId ?? row.id) === slot.id)
      .sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0) || Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
    const row = attempts.at(-1);
    const review = row ? reviews.get(row.id) : null;
    let status = 'queued';
    if (row) {
      if (review?.verdict === 'pass' && row.status === 'finished') status = 'pass';
      else if (review?.verdict === 'rework') status = 'rework';
      else if (review?.verdict === 'blocked') status = 'blocked';
      else if (row.status === 'finished') status = 'review';
      else if (row.status === 'reserved' || row.status === 'launched') status = 'running';
      else if (row.status === 'terminal_infrastructure_failed' || row.failureClass || row.status.includes('fail')) status = 'blocked';
      else status = row.status;
    }
    const event = row?.evidence ? await readEventTail(join(row.evidence, 'events.jsonl'), 1) : null;
    return {
      id: slot.id, branch: slot.branch, task: slot.taskId, stage: slot.stage,
      status, nativeStatus: row?.status ?? null, invocationId: row?.id ?? null,
      attempt: row?.attempt ?? null, attempts: attempts.length, reviewed: review?.verdict ?? null,
      acceptance: row?.acceptance?.passed ?? null, failureClass: row?.failureClass ?? row?.terminal?.classification ?? null,
      failureReason: row?.invocationError?.message ?? row?.terminal?.reason ?? state.failures?.findLast(failure => failure.slotId === row?.id)?.message ?? null,
      startedAt: row?.startedAt ?? null, elapsedMs: row?.elapsedMs ?? null,
      model: row?.launch?.model ?? null, effort: row?.launch?.effort ?? null,
      usage: row?.usage ?? null, lastEventAt: event?.modifiedAt ?? null,
      lastEvent: event?.entries?.[0]?.label ?? null,
      nativeStopVerified: row?.nativeStop?.writersStopped === true && row?.nativeStop?.activeProcesses === 0,
      cleanupPassed: row?.cleanup?.passed ?? null,
    };
  }));
  const phaseHash = hash(allAttempts);
  const audit = finalAudit ?? partialAudit;
  const auditFresh = !!audit && audit.protocolHash === pointer.protocolHash && audit.phaseStateHash === phaseHash;
  const passed = rows.filter(row => row.status === 'pass').length;
  const running = rows.filter(row => row.status === 'running').length;
  const blocked = rows.filter(row => row.status === 'blocked').length;
  const reviewPending = rows.filter(row => row.status === 'review').length;
  const authoritative = assessment?.protocolHash === pointer.protocolHash ? assessment : terminal?.protocolHash === pointer.protocolHash ? terminal : null;
  const g4Passed = authoritative?.verdict === 'pass' && passed === rows.length && finalReview?.verdict === 'pass' && finalReview.protocolHash === pointer.protocolHash && finalAudit?.mechanicalIntegrityPassed === true;
  return {
    updatedAt: new Date().toISOString(), pointerPath, directory, revision: basename(dirname(pointerPath)),
    protocolHash: pointer.protocolHash, roundStatus: state.status, g4Passed: !!g4Passed,
    terminalVerdict: authoritative?.verdict ?? null, infrastructureFailed: state.status === 'infrastructure_failed',
    failures: (state.failures ?? []).map(({ slotId, at, message }) => ({ slotId, at, message })),
    total: rows.length, passed, running, blocked, reviewPending,
    audit: { result: !audit ? 'missing' : !auditFresh ? 'stale' : audit.mechanicalIntegrityPassed ? 'pass' : 'fail', partial: audit?.partial ?? null },
    finalized: finalReview?.verdict === 'pass' && finalReview.protocolHash === pointer.protocolHash,
    watchdogMinutes: protocol.watchdogMinutes ?? protocol.watchdog?.minutes ?? 60,
    attempts: allAttempts.length, rows,
  };
}

export async function eventsForSlot(explicitPointer, slotId) {
  const { state, protocol } = await readRound(explicitPointer);
  if (!(protocol.smoke ?? []).some(slot => slot.id === slotId)) throw Error('Slot G4 không tồn tại');
  const attempts = state.slots.filter(row => row.phase === 'smoke' && (row.slotId ?? row.id) === slotId)
    .sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
  const row = attempts.at(-1);
  const log = row?.evidence ? await readEventTail(join(row.evidence, 'events.jsonl'), 35) : { entries: [], modifiedAt: null };
  return { slotId, attempt: row?.attempt ?? null, ...log };
}

export function startServer({ pointer, port = 4328 } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'");
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/') {
        const page = await readFile(join(base, 'g4-monitor.html'));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page);
      } else if (url.pathname === '/api/status') {
        const data = await snapshot(pointer);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(data));
      } else if (url.pathname === '/api/events') {
        const slot = url.searchParams.get('slot') ?? '';
        const data = await eventsForSlot(pointer, slot);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(data));
      } else { response.writeHead(404).end('Not found'); }
    } catch (error) {
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`G4 monitor: http://127.0.0.1:${server.address().port}`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const pointer = flag('--pointer') || process.env.G4_MONITOR_POINTER || undefined;
  const port = Number(flag('--port') || process.env.G4_MONITOR_PORT || 4328);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Port phải là số nguyên từ 0 đến 65535');
  startServer({ pointer, port });
}
