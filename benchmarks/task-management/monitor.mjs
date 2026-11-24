import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, '../..');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const port = Number(process.env.BENCHMARK_MONITOR_PORT || 4317);
async function snapshot() {
  const pointer = await readJson(join(root, 'docs/phase0-20261016/round.json'));
  const [state, protocol] = await Promise.all([
    readJson(join(pointer.directory, 'state.json')), readJson(pointer.protocol),
  ]);
  if (state.protocolHash !== pointer.protocolHash) throw new Error('Round identity mismatch');
  const optional = async name => {
    try { const value = await readJson(join(pointer.directory, name)); return value.protocolHash === pointer.protocolHash ? value : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const [audit, review] = await Promise.all([optional('formal-audit.json'), optional('formal-review.json')]);
  const reviewById = new Map(review?.rows?.map(row => [row.id, row.verdict]) ?? []);
  const rows = protocol.schedule.map(slot => {
    const row = state.slots.find(item => item.phase === 'formal' && item.id === slot.id);
    return { id: slot.id, task: slot.taskId, repetition: slot.repetition, stage: slot.stage,
      status: row?.status ?? 'not_started', passed: row?.acceptance?.passed ?? null,
      model: row?.launch?.model ?? null, startedAt: row?.startedAt ?? null,
      elapsedMs: row?.elapsedMs ?? null, usage: row?.usage ?? null, failure: row?.failureClass ?? null,
      contentVerdict: reviewById.get(slot.id) ?? null };
  });
  return { updatedAt: new Date().toISOString(), protocolHash: pointer.protocolHash,
    status: state.status, rows, failures: state.failures, smokeCompleted: state.slots.filter(row => row.phase === 'smoke' && row.status === 'finished').length,
    auditPassed: audit?.mechanicalIntegrityPassed ?? null, reviewComplete: review?.dataComplete ?? false,
    reviewCounts: review?.reviewCounts ?? null, qualityPassed: review?.qualityPassed ?? null };
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/api/status') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(await snapshot()));
    } else if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(await readFile(join(base, 'monitor.html')));
    } else { response.writeHead(404); response.end('Not found'); }
  } catch (error) {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Benchmark monitor: http://127.0.0.1:${port}`));
