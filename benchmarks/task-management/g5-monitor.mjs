import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, '../..');
const local = join(root, '.local');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function optionalJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function optionalStat(path) {
  try { return await stat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function resolvePointer(explicitPointer) {
  if (explicitPointer) return resolve(explicitPointer);
  const names = (await readdir(local)).filter(name => /^g5-active-preparation-\d{8}\.json$/.test(name));
  const candidates = (await Promise.all(names.map(async name => {
    const path = join(local, name);
    const info = await optionalStat(path);
    return info ? { path, modified: info.mtimeMs } : null;
  }))).filter(Boolean).sort((a, b) => b.modified - a.modified);
  if (!candidates.length) throw Error('Chưa tìm thấy .local/g5-active-preparation-YYYYMMDD.json; dùng --pointer <round.json>');
  const locator = await readJson(candidates[0].path);
  if (typeof locator.directory !== 'string' || !isAbsolute(locator.directory)) throw Error('G5 active locator không hợp lệ');
  return join(locator.directory, 'round.json');
}

async function readRound(pointerArg) {
  const pointerPath = await resolvePointer(pointerArg);
  const pointer = await readJson(pointerPath);
  if (!pointer.directory || !pointer.protocol || !pointer.protocolHash || !isAbsolute(pointer.directory)) throw Error('Pointer G5 không hợp lệ');
  const [state, protocol] = await Promise.all([readJson(join(pointer.directory, 'state.json')), readJson(pointer.protocol)]);
  if (state.protocolHash !== pointer.protocolHash || protocol.protocolHash !== pointer.protocolHash) throw Error('G5 protocol/state identity mismatch');
  if (!Array.isArray(protocol.smoke) || !Array.isArray(protocol.schedule) || !Array.isArray(state.slots)) throw Error('G5 protocol/state thiếu schedule hoặc slots');
  return { pointerPath, pointer, state, protocol };
}

function latestAttempt(attempts) {
  return [...attempts].sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0) || Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0)).at(-1);
}

function asAttempt(row, reviews) {
  const review = reviews.get(row.id);
  let status = 'review';
  if (row.status === 'reserved' || row.status === 'launched') status = 'running';
  else if (review?.verdict === 'pass' && row.status === 'finished' && row.turn?.status === 'completed') status = 'pass';
  else if (review?.verdict === 'rework') status = 'rework';
  else if (review?.verdict === 'blocked' || row.status?.includes('fail')) status = 'blocked';
  else if (row.status !== 'finished') status = row.status ?? 'unknown';
  return {
    id: row.id, slotId: row.slotId ?? row.id, attempt: row.attempt ?? 1,
    status, nativeStatus: row.status, reviewVerdict: review?.verdict ?? null,
    reviewReason: review?.reason ?? null, reviewedAt: review?.reviewedAt ?? null,
    turnStatus: row.turn?.status ?? null, acceptance: row.acceptance?.passed ?? null,
    acceptanceCases: row.acceptance?.cases ?? null,
    failureClass: row.failureClass ?? row.terminal?.classification ?? null,
    failureReason: row.invocationError?.message ?? row.terminal?.reason ?? null,
    startedAt: row.startedAt ?? null, elapsedMs: row.elapsedMs ?? null,
    model: row.launch?.model ?? null, effort: row.launch?.effort ?? null,
    usage: row.usage ?? null, cleanupPassed: row.cleanup?.passed ?? null,
    nativeStopVerified: row.nativeStop?.writersStopped === true && row.nativeStop?.activeProcesses === 0,
  };
}

async function auditStatus(file, hash, phaseHash) {
  if (!file) return { result: 'missing', partial: null, mismatches: [] };
  if (file.protocolHash !== hash || file.phaseStateHash !== phaseHash) return { result: 'stale', partial: file.partial ?? null, mismatches: [] };
  return {
    result: file.mechanicalIntegrityPassed === true ? 'pass' : 'fail',
    partial: file.partial ?? false,
    mismatches: file.mismatches ?? [],
    observedAt: file.observedAt ?? null,
  };
}

export async function snapshot(pointerArg) {
  const { pointerPath, pointer, state, protocol } = await readRound(pointerArg);
  const dir = pointer.directory;
  const [review, partialSmoke, finalSmoke, smokeFinalReview, partialFormal, finalFormal, formalReview, checkpoint, stateInfo, reviewInfo, auditInfo] = await Promise.all([
    optionalJson(join(dir, 'smoke-content-review.json')),
    optionalJson(join(dir, 'smoke-audit.partial.json')),
    optionalJson(join(dir, 'smoke-audit.json')),
    optionalJson(join(dir, 'smoke-review.json')),
    optionalJson(join(dir, 'formal-audit.partial.json')),
    optionalJson(join(dir, 'formal-audit.json')),
    optionalJson(join(dir, 'formal-review.json')),
    optionalJson(join(dirname(pointerPath), 'checkpoint.json')),
    optionalStat(join(dir, 'state.json')),
    optionalStat(join(dir, 'smoke-content-review.json')),
    optionalStat(join(dir, 'smoke-audit.partial.json')),
  ]);
  const reviews = new Map(review?.protocolHash === pointer.protocolHash ? (review.rows ?? []).map(row => [row.id, row]) : []);
  const smokeAttempts = state.slots.filter(row => row.phase === 'smoke');
  const formalAttempts = state.slots.filter(row => row.phase === 'formal');
  const smokeRows = protocol.smoke.map(slot => {
    const attempts = smokeAttempts.filter(row => (row.slotId ?? row.id) === slot.id).map(row => asAttempt(row, reviews))
      .sort((a, b) => a.attempt - b.attempt || Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
    const last = attempts.at(-1);
    return { id: slot.id, branch: slot.branch, task: slot.taskId, stage: slot.stage,
      status: last?.status ?? 'queued', attempts, current: last ?? null };
  });
  const formalReviews = new Map(formalReview?.protocolHash === pointer.protocolHash ? (formalReview.rows ?? []).map(row => [row.id, row]) : []);
  const formalRows = protocol.schedule.map(slot => {
    const entries = formalAttempts.filter(row => (row.slotId ?? row.id) === slot.id);
    const row = latestAttempt(entries);
    const verdict = row && (formalReviews.get(row.id) ?? formalReviews.get(slot.id));
    const current = row ? asAttempt(row, new Map([[row.id, verdict]])) : null;
    return { id: slot.id, branch: slot.branch, task: slot.taskId, stage: slot.stage,
      repetition: slot.repetition, status: current?.status ?? 'queued', current, attemptCount: entries.length };
  });
  const smokeAudit = await auditStatus(finalSmoke ?? partialSmoke, pointer.protocolHash, digest(smokeAttempts));
  const formalAudit = await auditStatus(finalFormal ?? partialFormal, pointer.protocolHash, digest(formalAttempts));
  const smokePassed = smokeRows.filter(row => row.status === 'pass').length;
  const formalPassed = formalRows.filter(row => row.status === 'pass').length;
  const smokeFinished = smokeRows.filter(row => row.current?.nativeStatus === 'finished').length;
  const smokeBlocked = smokeRows.filter(row => ['rework', 'blocked'].includes(row.status)).length;
  const releasePassed = checkpoint?.releasePassed === true && checkpoint?.measurementComplete === true &&
    smokePassed === smokeRows.length && formalPassed === formalRows.length &&
    smokeAudit.result === 'pass' && smokeAudit.partial === false &&
    formalAudit.result === 'pass' && formalAudit.partial === false &&
    smokeFinalReview?.protocolHash === pointer.protocolHash && formalReview?.protocolHash === pointer.protocolHash;
  const blocker = smokeRows.find(row => ['blocked', 'rework'].includes(row.status)) ??
    smokeRows.find(row => row.status === 'review') ?? formalRows.find(row => ['blocked', 'rework', 'review'].includes(row.status)) ?? null;
  const updatedAt = Math.max(stateInfo?.mtimeMs ?? 0, reviewInfo?.mtimeMs ?? 0, auditInfo?.mtimeMs ?? 0);
  return {
    fetchedAt: new Date().toISOString(), evidenceUpdatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    pointerPath, roundDirectory: dir, roundId: basename(dir), protocolHash: pointer.protocolHash,
    status: state.status, model: protocol.model ?? checkpoint?.model ?? null, effort: protocol.effort ?? checkpoint?.effort ?? null,
    maxAttempts: checkpoint?.maxAttempts ?? null, activeExecution: checkpoint?.activeExecution ?? null,
    smoke: { total: smokeRows.length, executed: smokeRows.filter(row => row.attempts.length).length,
      finished: smokeFinished, passed: smokePassed, blocked: smokeBlocked,
      reviewPending: smokeRows.filter(row => row.status === 'review').length,
      running: smokeRows.filter(row => row.status === 'running').length,
      attempts: smokeAttempts.length, audit: smokeAudit,
      finalReview: smokeFinalReview?.protocolHash === pointer.protocolHash ? smokeFinalReview.verdict ?? 'present' : null,
      rows: smokeRows },
    formal: { total: formalRows.length, executed: formalRows.filter(row => row.attemptCount).length,
      passed: formalPassed, audit: formalAudit, review: formalReview?.protocolHash === pointer.protocolHash ? formalReview.verdict ?? 'present' : null,
      rows: formalRows },
    failures: (state.failures ?? []).map(({ slotId, at, message }) => ({ slotId, at, message })),
    blocker: blocker ? { id: blocker.id, status: blocker.status,
      reason: blocker.current?.reviewReason ?? blocker.current?.failureReason ?? 'Cần đánh giá bằng chứng trước bước tiếp theo.' } : null,
    measurementComplete: checkpoint?.measurementComplete === true,
    releasePassed: !!releasePassed,
  };
}

async function readEventTail(path, limit = 40) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size, mtime } = await handle.stat();
    const bytes = Math.min(size, 128 * 1024);
    if (!bytes) return { modifiedAt: mtime.toISOString(), entries: [] };
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, size - bytes);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (size > bytes) lines.shift();
    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const method = event.message?.method;
        const item = event.message?.params?.item;
        if (!['warning', 'turn/started', 'turn/completed', 'turn/failed', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(method)) continue;
        events.push({ at: event.at, method, label: method === 'warning' ? String(event.message?.params?.message ?? 'Warning').slice(0, 250) :
          item ? `${item.type ?? 'item'}${item.exitCode != null ? ` · exit ${item.exitCode}` : ''}` : method,
          failed: method === 'warning' || method === 'turn/failed' || item?.status === 'failed' || (item?.exitCode != null && item.exitCode !== 0) });
      } catch { /* JSONL may end with an unfinished append. */ }
    }
    return { modifiedAt: mtime.toISOString(), entries: events.slice(-limit).reverse() };
  } catch (error) {
    if (error.code === 'ENOENT') return { modifiedAt: null, entries: [] };
    throw error;
  } finally { await handle?.close(); }
}

export async function eventsForSlot(pointerArg, slotId, attemptNumber) {
  const { pointer, protocol, state } = await readRound(pointerArg);
  if (![...protocol.smoke, ...protocol.schedule].some(slot => slot.id === slotId)) throw Error('Slot G5 không tồn tại');
  const attempts = state.slots.filter(row => (row.slotId ?? row.id) === slotId);
  const row = attemptNumber == null ? latestAttempt(attempts) : attempts.find(item => item.attempt === attemptNumber);
  if (attemptNumber != null && !row) throw Error('Attempt G5 không tồn tại');
  return { slotId, attempt: row?.attempt ?? null, ...(row?.evidence ? await readEventTail(join(row.evidence, 'events.jsonl')) : { modifiedAt: null, entries: [] }) };
}

export function startServer({ pointer, port = 4329 } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'");
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(await readFile(join(base, 'g5-monitor.html')));
      } else if (url.pathname === '/app.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(join(base, 'g5-monitor.js')));
      } else if (url.pathname === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(await snapshot(pointer)));
      } else if (url.pathname === '/api/events') {
        const slot = url.searchParams.get('slot') ?? '';
        const value = url.searchParams.get('attempt');
        const attempt = value === null ? null : Number(value);
        if (value !== null && (!Number.isInteger(attempt) || attempt <= 0)) throw Error('Attempt phải là số nguyên dương');
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(await eventsForSlot(pointer, slot, attempt)));
      } else { response.writeHead(404).end('Not found'); }
    } catch (error) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`G5 dashboard: http://127.0.0.1:${server.address().port}`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const pointer = flag('--pointer') || process.env.G5_MONITOR_POINTER || undefined;
  const port = Number(flag('--port') || process.env.G5_MONITOR_PORT || 4329);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Port phải là số nguyên từ 1 đến 65535');
  startServer({ pointer, port });
}
