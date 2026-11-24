const el = id => document.getElementById(id);
const set = (id, value) => { el(id).textContent = value ?? '—'; };
const percent = (done, total) => total ? Math.round(100 * done / total) : 0;
const fmt = value => Number.isFinite(value) ? new Intl.NumberFormat('vi-VN').format(value) : '—';
const time = iso => iso ? new Date(iso).toLocaleString('vi-VN', { hour12: false }) : '—';
const duration = ms => !Number.isFinite(ms) ? '—' : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;
const labels = { pass: 'PASS', review: 'CHỜ REVIEW', rework: 'REWORK', blocked: 'BLOCKED', running: 'RUNNING', queued: 'CHƯA CHẠY' };
let data = null;
let selected = null;
let selectedAttempt = null;
let filter = 'all';
let fetching = false;
let eventRequest = 0;

function badge(status) {
  const span = document.createElement('span');
  span.className = `badge ${['pass', 'review', 'rework', 'blocked', 'running'].includes(status) ? status : ''}`;
  span.textContent = labels[status] ?? String(status ?? '—').toUpperCase();
  return span;
}

function phaseGate(id, label, status) {
  const elem = el(id);
  elem.textContent = label;
  elem.className = 'gate-status' + (status === 'pass' ? ' pass' : status === 'bad' ? ' bad' : '');
}

function renderSmoke() {
  const { smoke } = data;
  const progress = percent(smoke.passed, smoke.total);
  el('ring').style.background = `conic-gradient(var(--aqua) ${progress}%,#25384f ${progress}%)`;
  set('ringValue', `${progress}%`);
  set('smokeTitle', `${smoke.passed} / ${smoke.total} Smoke PASS`);
  set('smokeDescription', smoke.passed === smoke.total
    ? 'Tất cả logical slots đã được review PASS. Đang kiểm tra điều kiện gate tiếp theo.'
    : `Còn ${smoke.total - smoke.passed} logical slot chưa đạt. Acceptance riêng lẻ không đủ để mở gate.`);
  el('smokeBar').style.width = `${progress}%`;
  set('smokeCaption', `${smoke.passed} / ${smoke.total} · ${progress}%`);
  const flow = el('smokeFlow');
  flow.replaceChildren();
  for (const row of smoke.rows) {
    const step = document.createElement('span');
    step.className = `step ${row.status}`;
    step.textContent = `${row.id.replace('-0-', ' · ')} ${row.status === 'pass' ? '✓' : row.status === 'queued' ? '·' : '!'}`;
    flow.append(step);
  }
  set('executed', `${smoke.executed} / ${smoke.total}`);
  set('attempts', `${smoke.attempts} lần chạy · ${smoke.attempts - smoke.executed} lần retry`);
  set('reviewed', `${smoke.passed} / ${smoke.total}`);
  set('reviewPending', `${smoke.reviewPending} chờ review · ${smoke.blocked} cần sửa`);
  set('auditSummary', smoke.audit.result === 'pass' ? 'PASS' : smoke.audit.result.toUpperCase());
  set('auditDetail', smoke.audit.result === 'pass' && smoke.audit.partial ? 'Partial audit · chưa final' :
    smoke.audit.result === 'pass' ? 'Final audit đã đạt' : smoke.audit.result === 'stale' ? 'Audit lệch state/hash' :
    smoke.audit.result === 'fail' ? 'Có mechanical mismatch' : 'Chưa có audit');
  set('formalCount', `${data.formal.passed} / ${data.formal.total}`);
  el('formalBar').style.width = `${percent(data.formal.passed, data.formal.total)}%`;
  set('formalNote', `${data.formal.executed} / ${data.formal.total} đã chạy · ${data.formal.passed} PASS`);

  const tbody = el('smokeRows');
  tbody.replaceChildren();
  const rows = smoke.rows.filter(row => filter === 'all' || row.branch === filter);
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (selected === row.id) tr.className = 'selected';
    tr.tabIndex = 0;
    const name = document.createElement('td');
    const title = document.createElement('span'); title.className = 'name'; title.textContent = row.id;
    const subtitle = document.createElement('span'); subtitle.className = 'secondary'; subtitle.textContent = `Task ${row.task} · Stage ${row.stage}`;
    name.append(title, subtitle);
    const status = document.createElement('td'); status.append(badge(row.status));
    const turn = document.createElement('td'); turn.textContent = row.current?.turnStatus ?? '—';
    const acceptance = document.createElement('td'); acceptance.textContent = row.current?.acceptance === true ? `${row.current.acceptanceCases ?? '—'}/2 ✓` : row.current?.acceptance === false ? 'FAIL' : '—';
    const attempts = document.createElement('td'); attempts.className = 'right'; attempts.textContent = fmt(row.attempts.length);
    tr.append(name, status, turn, acceptance, attempts);
    tr.addEventListener('click', () => choose(row.id));
    tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(row.id); } });
    tbody.append(tr);
  }
}

function renderBlocker() {
  const box = el('blockerPanel');
  const issue = data.blocker;
  box.classList.toggle('good', !issue);
  set('blockerIcon', issue ? '!' : '✓');
  set('blockerLabel', issue ? 'Vấn đề cần xử lý' : 'Không có blocker ở slot');
  set('blockerTitle', issue?.id ?? 'Các slot đã có verdict PASS');
  el('blockerBadge').replaceChildren();
  if (issue) el('blockerBadge').append(badge(issue.status));
  set('blockerReason', issue?.reason ?? 'Chờ kiểm chứng final audit và formal gate trước khi kết luận G5 hoàn thành.');
}

function renderGates() {
  phaseGate('gateSmoke', `${data.smoke.passed} / ${data.smoke.total}`, data.smoke.passed === data.smoke.total ? 'pass' : 'pending');
  const audit = data.smoke.audit;
  phaseGate('gateAudit', audit.result === 'pass' ? (audit.partial ? 'PARTIAL PASS' : 'FINAL PASS') : audit.result.toUpperCase(),
    audit.result === 'pass' && !audit.partial ? 'pass' : audit.result === 'fail' ? 'bad' : 'pending');
  phaseGate('gateFormal', `${data.formal.passed} / ${data.formal.total}`, data.formal.passed === data.formal.total && data.formal.total ? 'pass' : 'pending');
  phaseGate('gateRelease', data.releasePassed ? 'PASS' : 'CHƯA PASS', data.releasePassed ? 'pass' : 'pending');
  const overall = el('overall');
  overall.className = 'pill' + (data.releasePassed ? ' pass' : data.status?.includes('fail') ? ' failed' : '');
  overall.textContent = data.releasePassed ? '● RELEASE PASSED' : `● ${data.status?.replaceAll('-', ' ').toUpperCase() ?? 'CHƯA PASS'}`;
}

function renderMeta() {
  set('runner', data.status);
  set('model', `${data.model ?? '—'} · ${data.effort ?? '—'}`);
  set('round', data.roundId.slice(0, 13) + '…');
  set('hash', data.protocolHash.slice(0, 16) + '…');
  set('evidenceTime', time(data.evidenceUpdatedAt));
  set('process', data.activeExecution?.sessionId ? `Session ${data.activeExecution.sessionId}` : data.activeExecution?.terminal ? 'Đã dừng' : 'Không rõ');
  set('filePath', data.pointerPath);
  set('lastSync', `API cập nhật ${time(data.fetchedAt)} · Evidence ${time(data.evidenceUpdatedAt)}`);
}

function renderDetails() {
  const row = data.smoke.rows.find(slot => slot.id === selected);
  if (!row) return;
  if (selectedAttempt == null || !row.attempts.some(a => a.attempt === selectedAttempt)) selectedAttempt = row.current?.attempt ?? null;
  const current = row.attempts.find(a => a.attempt === selectedAttempt) ?? row.current;
  set('detailTitle', row.id);
  set('detailSubtitle', `${row.branch} · ${row.task} · Stage ${row.stage} · ${row.attempts.length} attempt(s)`);
  el('detailBadge').replaceChildren(badge(current?.status ?? 'queued'));
  const body = el('detailBody'); body.replaceChildren();
  if (!current) { body.textContent = 'Chưa thực thi.'; return; }
  const facts = [
    `Attempt #${current.attempt} · ${current.nativeStatus} · Turn: ${current.turnStatus ?? '—'}`,
    `Acceptance: ${current.acceptance === true ? 'PASS' : current.acceptance === false ? 'FAIL' : '—'} · Cleanup: ${current.cleanupPassed === true ? 'PASS' : '—'} · Native stop: ${current.nativeStopVerified ? 'VERIFIED' : '—'}`,
    `Thời gian chạy: ${duration(current.elapsedMs)} · Input tokens: ${fmt(current.usage?.inputTokens)} · Output tokens: ${fmt(current.usage?.outputTokens)}`,
  ];
  for (const line of facts) { const p = document.createElement('p'); p.textContent = line; body.append(p); }
  if (current.failureClass || current.failureReason || current.reviewReason) {
    const reason = document.createElement('div'); reason.className = 'evidence-box';
    reason.textContent = [current.failureClass ? `Failure class: ${current.failureClass}` : null,
      current.failureReason, current.reviewReason ? `Host review: ${current.reviewReason}` : null].filter(Boolean).join(' · ');
    body.append(reason);
  }
  const history = el('attemptHistory'); history.replaceChildren();
  for (const attempt of row.attempts) {
    const item = document.createElement('div'); item.className = 'attempt';
    const content = document.createElement('div');
    const headline = document.createElement('b'); headline.textContent = `Attempt ${attempt.attempt} · ${labels[attempt.status] ?? attempt.status}`;
    const desc = document.createElement('div'); desc.className = 'desc'; desc.textContent = `${time(attempt.startedAt)} · ${attempt.turnStatus ?? '—'} · ${duration(attempt.elapsedMs)}`;
    content.append(headline, desc);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = attempt.attempt === selectedAttempt ? 'Đang xem' : 'Xem events';
    button.disabled = attempt.attempt === selectedAttempt;
    button.addEventListener('click', () => { selectedAttempt = attempt.attempt; renderDetails(); fetchEvents(); });
    item.append(content, button); history.append(item);
  }
}

function renderFormal() {
  const grid = el('formalGrid'); grid.replaceChildren();
  for (const row of data.formal.rows) {
    const cell = document.createElement('button'); cell.type = 'button'; cell.className = `formal-cell ${row.status}`;
    cell.textContent = row.id.replace(/^([BS])-/, '$1·');
    cell.title = `${row.id} · ${labels[row.status] ?? row.status}`;
    cell.addEventListener('click', () => set('formalSelection', `${row.id} · ${labels[row.status] ?? row.status} · ${row.attemptCount} attempt(s) · Task ${row.task}`));
    grid.append(cell);
  }
  const formalReady = data.smoke.passed === data.smoke.total && data.smoke.audit.result === 'pass' && !data.smoke.audit.partial;
  set('formalStatus', data.formal.executed ? 'ĐANG THEO DÕI' : formalReady ? 'CHỜ KHỞI CHẠY' : 'CHƯA MỞ');
}

async function fetchEvents() {
  if (!selected || selectedAttempt == null) return;
  const requestId = ++eventRequest;
  try {
    const response = await fetch(`/api/events?slot=${encodeURIComponent(selected)}&attempt=${selectedAttempt}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw Error(result.error ?? `HTTP ${response.status}`);
    if (requestId !== eventRequest) return;
    set('eventCount', `${result.entries.length} events`);
    const list = el('eventList'); list.replaceChildren();
    if (!result.entries.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Chưa có native event.'; list.append(p); return; }
    for (const event of result.entries) {
      const item = document.createElement('div'); item.className = `event${event.failed ? ' failed' : ''}`;
      const pin = document.createElement('span'); pin.className = 'pin';
      const content = document.createElement('div');
      const label = document.createElement('strong'); label.textContent = event.label;
      const at = document.createElement('time'); at.textContent = `${time(event.at)} · ${event.method}`;
      content.append(label, at); item.append(pin, content); list.append(item);
    }
  } catch (error) {
    if (requestId !== eventRequest) return;
    set('eventCount', 'LOG ERROR'); set('eventList', error.message);
  }
}

function render() {
  if (!data) return;
  if (!selected || !data.smoke.rows.some(row => row.id === selected)) {
    selected = data.blocker && data.smoke.rows.some(row => row.id === data.blocker.id) ? data.blocker.id : data.smoke.rows[0]?.id ?? null;
    selectedAttempt = null;
  }
  renderSmoke(); renderBlocker(); renderGates(); renderMeta(); renderDetails(); renderFormal();
}

function choose(id) {
  selected = id; selectedAttempt = null; renderSmoke(); renderDetails(); fetchEvents();
}

async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw Error(result.error ?? `HTTP ${response.status}`);
    data = result; render();
    el('syncDot').classList.remove('off'); set('connection', 'Kết nối · 4s');
    el('error').style.display = 'none';
    await fetchEvents();
  } catch (error) {
    el('syncDot').classList.add('off'); set('connection', 'Mất kết nối');
    el('error').style.display = 'block'; set('error', `Không đọc được dữ liệu G5: ${error.message}`);
  } finally { fetching = false; }
}

for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll('[data-filter]')) other.classList.toggle('active', other === button);
    if (data) renderSmoke();
  });
}
el('refresh').addEventListener('click', refresh);
el('copy').addEventListener('click', async () => {
  if (!data) return;
  try { await navigator.clipboard.writeText(location.href); set('copy', 'Đã sao chép ✓'); }
  catch { set('copy', 'Không thể sao chép'); }
  setTimeout(() => set('copy', 'Sao chép đường dẫn'), 1800);
});
setInterval(refresh, 4000);
refresh();
