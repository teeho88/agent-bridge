// Dashboard client. Runs in the browser as an ES module served from
// /ui-client/main.js - it is no longer a string inside ui-page.ts, so tsc
// checks it and it can be split by domain without touching the HTML.
// Widened deliberately: these are looked up by id and used as inputs, buttons
// and containers interchangeably. Narrow them per-section as the file is split.
// The DOM lib types these lookups as Element/HTMLElement, but every call site
// here knows the concrete element it asked for. Narrow per-section instead of
// widening once the file is split by domain.
function formText(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}

function elById(id: string): any {
  return document.getElementById(id);
}

function qs(root: any, selector: string): any {
  return root ? root.querySelector(selector) : null;
}

function qsa(root: any, selector: string): any[] {
  return root ? Array.from(root.querySelectorAll(selector)) : [];
}

// Event targets are typed as EventTarget but are always elements here. These
// two helpers replace the `x.target.closest && x.target.closest(...)` guard
// that was repeated throughout the file.
function closestFrom(target: EventTarget | null, selector: string): any {
  const el = target as Element | null;
  return el && typeof el.closest === 'function' ? el.closest(selector) : null;
}

function datasetOf(target: EventTarget | null): Record<string, string | undefined> {
  return (target as HTMLElement | null)?.dataset ?? {};
}

const els: Record<string, any> = {
  workspacePill: elById('workspacePill'),
  hookPill: elById('hookPill'),
  installClaudeHookButton: elById('installClaudeHookButton'),
  antigravityHookPill: elById('antigravityHookPill'),
  installAntigravityHookButton: elById('installAntigravityHookButton'),
  refreshPill: elById('refreshPill'),
  liveTaskSummary: elById('liveTaskSummary'),
  liveTaskShell: elById('liveTaskShell'),
  liveTasks: elById('liveTasks'),
  liveTaskPrev: elById('liveTaskPrev'),
  liveTaskNext: elById('liveTaskNext'),
  editTaskId: elById('editTaskId'),
  editTaskTitle: elById('editTaskTitle'),
  editTaskGoal: elById('editTaskGoal'),
  editTaskStatus: elById('editTaskStatus'),
  editTaskAgent: elById('editTaskAgent'),
  sessionForm: elById('sessionForm'),
  sessionTaskId: elById('sessionTaskId'),
  sessionStatus: elById('sessionStatus'),
  memoryType: elById('memoryType'),
  memoryImportance: elById('memoryImportance'),
  memoryScope: elById('memoryScope'),
  memoryTaskId: elById('memoryTaskId'),
  sessionState: elById('sessionState'),
  overviewSessionState: elById('overviewSessionState'),
  tokenSavings: elById('tokenSavings'),
  overviewTimeline: elById('overviewTimeline'),
  tasks: elById('tasks'),
  memories: elById('memories'),
  overviewMemories: elById('overviewMemories'),
  repoMemories: elById('repoMemories'),
  repoMemoryEditModal: elById('repoMemoryEditModal'),
  repoMemoryEditForm: elById('repoMemoryEditForm'),
  repoMemoryEditId: elById('repoMemoryEditId'),
  repoMemoryEditContent: elById('repoMemoryEditContent'),
  repoMemoryEditType: elById('repoMemoryEditType'),
  repoMemoryEditImportance: elById('repoMemoryEditImportance'),
  repoMemoryEditTags: elById('repoMemoryEditTags'),
  repoMemoryCandidates: elById('repoMemoryCandidates'),
  handoff: elById('handoff'),
  handoffHistory: elById('handoffHistory'),
  compiledEditor: elById('compiledEditor'),
  compileTaskId: elById('compileTaskId'),
  contextSaveStatus: elById('contextSaveStatus'),
  searchResults: elById('searchResults'),
  skillForm: elById('skillForm'),
  skillScope: elById('skillScope'),
  skillName: elById('skillName'),
  skillDescription: elById('skillDescription'),
  skillContent: elById('skillContent'),
  skillFile: elById('skillFile'),
  skillDropZone: elById('skillDropZone'),
  skillStatus: elById('skillStatus'),
  repoSkills: elById('repoSkills'),
  globalSkills: elById('globalSkills'),
  githubSkillSearchForm: elById('githubSkillSearchForm'),
  githubSkillQuery: elById('githubSkillQuery'),
  githubSkillScope: elById('githubSkillScope'),
  githubSkillStatus: elById('githubSkillStatus'),
  githubSkillResults: elById('githubSkillResults'),
  githubTokenHelpModal: elById('githubTokenHelpModal'),
  githubTokenHelpClose: elById('githubTokenHelpClose'),
  tools: elById('tools'),
  tokenStack: elById('tokenStack'),
  overviewTools: elById('overviewTools'),
  optSavedPctStat: elById('optSavedPctStat'),
  optSavedTokensStat: elById('optSavedTokensStat'),
  optFilesStat: elById('optFilesStat'),
  optCompiledAvgStat: elById('optCompiledAvgStat'),
  optLimit: elById('optLimit'),
  optFocus: elById('optFocus'),
  optStatus: elById('optStatus'),
  optResult: elById('optResult'),
  optHistory: elById('optHistory'),
  optTopFiles: elById('optTopFiles'),
  graphFilesStat: elById('graphFilesStat'),
  graphSymbolsStat: elById('graphSymbolsStat'),
  graphInternalStat: elById('graphInternalStat'),
  graphExternalStat: elById('graphExternalStat'),
  injectRepoMap: elById('injectRepoMap'),
  autoBriefOnToolUse: elById('autoBriefOnToolUse'),
  watchAutoBrief: elById('watchAutoBrief'),
  repoMapLimit: elById('repoMapLimit'),
  graphIncludePaths: elById('graphIncludePaths'),
  graphIgnorePaths: elById('graphIgnorePaths'),
  repoMap: elById('repoMap'),
  graphCanvas: elById('graphCanvas'),
  graphHint: elById('graphHint'),
  graphBuildStatus: elById('graphBuildStatus'),
  graphSettingsStatus: elById('graphSettingsStatus'),
  watcherPill: elById('watcherPill'),
  watcherToggleButton: elById('watcherToggleButton'),
  watcherStatus: elById('watcherStatus'),
  graphBriefPath: elById('graphBriefPath'),
  graphBriefPriority: elById('graphBriefPriority'),
  graphBriefSummary: elById('graphBriefSummary'),
  graphBriefRanges: elById('graphBriefRanges'),
  graphBriefTaskEdited: elById('graphBriefTaskEdited'),
  graphBriefStatus: elById('graphBriefStatus'),
  laneTaskId: elById('laneTaskId'),
  workChanges: elById('workChanges'),
  workLeases: elById('workLeases'),
  agentRequestQueue: elById('agentRequestQueue'),
  agentRequestSummary: elById('agentRequestSummary'),
  requestToastStack: elById('requestToastStack'),
  workforceAgentMode: elById('workforceAgentMode'),
  workforceAgentId: elById('workforceAgentId'),
  workforceAgentSubmit: elById('workforceAgentSubmit'),
  workforceAgentCancelEdit: elById('workforceAgentCancelEdit'),
  workforceAgentModal: elById('workforceAgentModal'),
  workforceAgentModalTitle: elById('workforceAgentModalTitle'),
  defaultAgentPresets: elById('defaultAgentPresets'),
  defaultAgentPresetsModal: elById('defaultAgentPresetsModal'),
  defaultAgentPresetsSummary: elById('defaultAgentPresetsSummary'),
  defaultAgentSelectAll: elById('defaultAgentSelectAll'),
  taskDetailModal: elById('taskDetailModal'),
  taskDetailTitle: elById('taskDetailTitle'),
  taskDetailBody: elById('taskDetailBody'),
  workforceAgents: elById('workforceAgents'),
};
let live = true;
let lastFingerprint = '';
let graphLoaded = false;
let graphSettingsTouched = false;
let taskEditTouched = false;
let contextEditTouched = false;
let memoryImportanceTouched = false;
let lastTasks = [];
let lastOptionalTools = [];
let lastState = null;
let selectedLiveTaskId = '';
let graphAnim = null;
let selectedGraphPath = '';
// Task ids that have an orchestration behind them. A request raised on one
// of these belongs to the leader loop, not the Work Board, so its toast has
// to open the Orchestration view.
let orchestrationTaskIds = new Set();
const seenRequestToastIds = new Set();
const requestToastTimers = new Map();
const runStatusById = new Map();
const runToastTimers = new Map();
const suggestedImportanceByType = {
  note: 3,
  bug: 4,
  constraint: 5,
  decision: 5,
  test: 4,
  file: 4
};

async function api(path, options: any = {}) {
  const res = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function load(force = false) {
  try {
    const state = await api('/api/state');
    const fingerprint = JSON.stringify({
      currentTaskId: state.config.currentTaskId,
      tasks: (state.tasks || []).map(t => [t.id, t.title, t.status, t.ownerAgent, t.updatedAt].join(':')).join('|'),
      liveTasks: (state.liveTasks || []).map(item => [item.task.id, item.task.updatedAt, item.sessionState && item.sessionState.updatedAt, item.handoff && item.handoff.id, item.compiledContext, (item.sessions || []).map(session => session.sessionId + ':' + session.hasWindow).join(',')].join(':')).join('|'),
      repoMemories: (state.repoMemories || []).map(m => m.id + m.updatedAt).join('|'),
      repoMemoryCandidates: (state.repoMemoryCandidates || []).map(c => c.id + c.status).join('|'),
      memories: state.memories.map(m => m.id + m.updatedAt).join('|'),
      compiledContextLength: (state.compiledContext || '').length,
      handoff: state.handoff && state.handoff.id,
      handoffHistory: (state.portableHandoff?.history || []).map(item => item.path).join('|'),
      tools: (state.optionalTools || []).map(t => t.name + t.installed).join('|'),
      skills: (state.skills || []).map(skill => skill.scope + ':' + skill.name + ':' + skill.updatedAt).join('|'),
      tokenStack: (state.tokenStack || []).map(t => t.id + t.enabled + t.installed).join('|'),
      graphStats: JSON.stringify(state.graphStats || {}),
      optimizeStats: JSON.stringify(state.optimizeStats || {}),
      work: JSON.stringify({
        lanes: state.taskLanes || [],
        leases: state.fileLeases || [],
        changes: state.taskChanges || [],
        requests: state.agentRequests || [],
        agents: state.registeredAgents || [],
        defaultAgentPresets: state.defaultAgentPresets || []
      }),
      dbError: state.dbError || ''
    });
    if (!force && fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    renderState(state);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    els.refreshPill.textContent = message;
    els.refreshPill.className = 'pill warn';
    if (els.liveTasks) els.liveTasks.innerHTML = '<div class="error">Dashboard failed to load: ' + escapeHtml(message) + '</div>';
    if (els.overviewSessionState) els.overviewSessionState.innerHTML = '<div class="error">Dashboard failed to load: ' + escapeHtml(message) + '</div>';
  }
}

function renderState(state) {
  lastState = state;
  const liveTasks = state.liveTasks || [];
  if (!selectedLiveTaskId || !liveTasks.some(item => item.task.id === selectedLiveTaskId)) {
    selectedLiveTaskId = liveTasks.find(item => item.sessionState)?.task.id ||
      liveTasks.find(item => state.currentTask && item.task.id === state.currentTask.id)?.task.id ||
      liveTasks[0]?.task.id || '';
  }
  const selected = liveTasks.find(item => item.task.id === selectedLiveTaskId);
  const current = selected ? selected.task : state.currentTask;
  lastTasks = state.tasks || [];
  lastOptionalTools = state.optionalTools || [];
  renderSkills(state.skills || []);
  orchestrationTaskIds = new Set(state.orchestrationTaskIds || []);
  const stats = selected?.tokenStats || state.tokenStats || { rawTokens: 0, cleanedTokens: 0, compiledTokens: 0, cacheableTokens: 0, savedTokens: 0, savingsPercent: 0, stages: [] };
  els.workspacePill.textContent = state.workspace || 'Workspace';
  const hookStatus = state.claudeHookStatus || { installed: state.claudeHookInstalled, current: state.claudeHookInstalled };
  if (!hookStatus.installed) {
    els.hookPill.textContent = 'Claude hook missing';
    els.hookPill.className = 'pill warn';
    els.installClaudeHookButton.textContent = 'Install Claude Hook';
    els.installClaudeHookButton.style.display = 'inline-flex';
  } else if (!hookStatus.current) {
    els.hookPill.textContent = 'Claude hook outdated' + (hookStatus.installedVersion ? ' (' + hookStatus.installedVersion + ')' : '');
    els.hookPill.className = 'pill warn';
    els.installClaudeHookButton.textContent = 'Update Claude Hook';
    els.installClaudeHookButton.style.display = 'inline-flex';
  } else {
    els.hookPill.textContent = 'Claude hook current ' + (hookStatus.expectedVersion || '');
    els.hookPill.className = 'pill ok';
    els.installClaudeHookButton.style.display = 'none';
  }
  // agy has no session hooks of its own until these are installed, so an
  // agy run started by hand never reaches the Work Board without them.
  const agyHook = state.antigravityHookStatus || { installed: false, current: false };
  if (!agyHook.installed) {
    els.antigravityHookPill.textContent = 'Antigravity hook missing';
    els.antigravityHookPill.className = 'pill warn';
    els.installAntigravityHookButton.textContent = 'Install Antigravity Hook';
    els.installAntigravityHookButton.style.display = 'inline-flex';
  } else if (!agyHook.current) {
    els.antigravityHookPill.textContent = 'Antigravity hook outdated' + (agyHook.installedVersion ? ' (' + agyHook.installedVersion + ')' : '');
    els.antigravityHookPill.className = 'pill warn';
    els.installAntigravityHookButton.textContent = 'Update Antigravity Hook';
    els.installAntigravityHookButton.style.display = 'inline-flex';
  } else {
    els.antigravityHookPill.textContent = 'Antigravity hook current ' + (agyHook.expectedVersion || '');
    els.antigravityHookPill.className = 'pill ok';
    els.installAntigravityHookButton.style.display = 'none';
  }
  els.watcherPill.textContent = state.watcherRunning ? 'Watcher running' : 'Watcher stopped';
  els.watcherPill.className = state.watcherRunning ? 'pill ok' : 'pill warn';
  els.watcherToggleButton.textContent = state.watcherRunning ? 'Stop Watcher' : 'Start Watcher';
  els.watcherToggleButton.dataset.running = state.watcherRunning ? '1' : '';
  els.refreshPill.textContent = state.dbError ? 'DB issue: ' + state.dbError : (live ? 'Live refresh: on' : 'Live refresh: paused');
  els.refreshPill.className = state.dbError ? 'pill warn' : (live ? 'pill ok' : 'pill');
  const activeWorkItems = liveTasks.filter(item => item.hasActiveSession || (item.sessions || []).length).length;
  const allActionableRequests = (state.agentRequests || []).filter(request => request.status === 'pending');
  syncRequestToasts(allActionableRequests);
  const selectedTaskId = current?.id || '';
  const taskActionableRequests = selectedTaskId
    ? allActionableRequests.filter(request => !request.taskId || request.taskId === selectedTaskId)
    : allActionableRequests;
  const pendingRequests = taskActionableRequests.filter(request => request.status === 'pending').length;
  els.liveTaskSummary.textContent = liveTasks.length + ' live task' + (liveTasks.length === 1 ? '' : 's') + ' · ' +
    activeWorkItems + ' active agent' + (activeWorkItems === 1 ? '' : 's') + ' · ' +
    pendingRequests + ' pending request' + (pendingRequests === 1 ? '' : 's');
  els.agentRequestSummary.textContent = pendingRequests + ' pending';
  if (!taskEditTouched) {
    els.editTaskId.value = current ? current.id : '';
    els.editTaskTitle.value = current ? current.title : '';
    els.editTaskGoal.value = current ? (current.goal || '') : '';
    els.editTaskStatus.value = current ? current.status : 'in_progress';
    els.editTaskAgent.value = current ? (current.ownerAgent || state.config.defaultAgent || 'codex') : (state.config.defaultAgent || 'codex');
  }
  const sessionStateHtml = renderSessionState(selected?.sessionState || state.sessionState);
  els.sessionState.innerHTML = sessionStateHtml;
  els.overviewSessionState.innerHTML = sessionStateHtml;
  if (els.tokenSavings) els.tokenSavings.innerHTML = renderTokenStats(stats);
  const taskHtml = state.tasks.length ? state.tasks.map(renderTask).join('') : '<div class="muted">No tasks yet.</div>';
  els.tasks.innerHTML = taskHtml;
  populateSessionTaskSelect(state.tasks || [], current?.id);
  els.liveTasks.innerHTML = liveTasks.length ? liveTasks.map((entry, index) => renderLiveTask(entry, index, liveTasks)).join('') : '<div class="muted">No live tasks. Start or resume an agent session to populate this board.</div>';
  syncLiveTaskCarousel(false);
  const selectedMemories = selected?.memories || state.memories;
  const memoryHtml = selectedMemories.length ? selectedMemories.map(renderMemory).join('') : '<div class="muted">No memories for selected task.</div>';
  els.overviewTimeline.innerHTML = selected?.events?.length
    ? selected.events.map(renderSessionEvent).join('')
    : '<div class="muted">No task events yet.</div>';
  els.memories.innerHTML = memoryHtml;
  if (els.overviewMemories) els.overviewMemories.innerHTML = memoryHtml;
  const graph = state.graphStats || {};
  const graphKnowledge = graph.files
    ? '<div class="memory-row"><div class="meta">repository knowledge graph</div><div class="memory-content">' + escapeHtml(String(graph.files)) + ' files, ' + escapeHtml(String(graph.symbols || 0)) + ' symbols, and ' + escapeHtml(String(graph.internalEdges || 0)) + ' internal links are available to every task.</div><div><span class="tag">shared</span><span class="tag">knowledge-graph</span></div></div>'
    : '';
  const repoMemoryHtml = state.repoMemories?.length ? state.repoMemories.map(renderRepositoryMemory).join('') : '<div class="muted">No saved repository facts yet. Add one above with scope “Repository shared”.</div>';
  els.repoMemories.innerHTML = graphKnowledge + repoMemoryHtml;
  els.repoMemoryCandidates.innerHTML = state.repoMemoryCandidates?.length
    ? state.repoMemoryCandidates.map(renderMemoryCandidate).join('')
    : '<div class="muted">Inbox is clear. Session discoveries that look repository-wide will appear here for review.</div>';
  const activeHandoff = selected?.handoff || state.handoff;
  const portableHandoff = selected?.portableHandoff || state.portableHandoff || { history: [] };
  els.handoff.innerHTML = activeHandoff ? renderHandoff(activeHandoff, current) : '<div class="muted">No current handoff.</div>';
  els.handoffHistory.innerHTML = portableHandoff.history?.length
    ? portableHandoff.history.map(renderHandoffHistory).join('')
    : '<div class="muted">No archived handoffs for this task.</div>';
  populateTaskSelects(state.tasks || [], current?.id);
  populateWorkTaskSelects(state.tasks || [], current?.id);
  renderWorkState(state, current?.id);
  renderWorkforceState(state);
  els.agentRequestQueue.innerHTML = taskActionableRequests.length
    ? taskActionableRequests.map(request => renderAgentRequest(request, { global: true })).join('')
    : '<div class="muted">No pending agent requests.</div>';
  if (!contextEditTouched && document.activeElement !== els.compiledEditor) {
    els.compiledEditor.value = selected?.compiledContext || state.compiledContext || '';
  }
  const coreStack = (state.tokenStack || []).filter(module => module.id !== 'repomix' && module.id !== 'ccusage');
  const stackHtml = coreStack.map(renderStackModule).join('') || '<div class="muted">No stack status available.</div>';
  const toolHtml = (state.optionalTools || []).map(renderTool).join('') || '<div class="muted">No optional tool status available.</div>';
  els.tokenStack.innerHTML = stackHtml;
  els.tools.innerHTML = toolHtml;
  if (els.overviewTools) els.overviewTools.innerHTML = stackHtml + toolHtml;

  const gs = state.graphStats || { files: 0, symbols: 0, internalEdges: 0, externalEdges: 0 };
  els.graphFilesStat.textContent = String(gs.files || 0);
  els.graphSymbolsStat.textContent = String(gs.symbols || 0);
  els.graphInternalStat.textContent = String(gs.internalEdges || 0);
  els.graphExternalStat.textContent = String(gs.externalEdges || 0);

  renderOptimizeStats(state.optimizeStats);
  // Reflect persisted settings unless the user is mid-edit.
  if (!graphSettingsTouched) {
    const g = (state.config && state.config.graph) || {};
    els.injectRepoMap.checked = g.injectRepoMap !== false;
    els.autoBriefOnToolUse.checked = g.autoBriefOnToolUse !== false;
    els.watchAutoBrief.checked = g.watchAutoBrief !== false;
    els.repoMapLimit.value = g.repoMapLimit != null ? g.repoMapLimit : 30;
    els.graphIncludePaths.value = (g.includePaths || []).join('\n');
    els.graphIgnorePaths.value = (g.ignorePaths || []).join('\n');
  }
}

function renderTokenStats(stats) {
  const stages = (stats.stages || []).map(stage =>
    '<div class="memory-row"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(stage.label) + '</strong><span class="pill ok">-' + escapeHtml(stage.savedTokens) + '</span></div>' +
    '<div class="meta">' + escapeHtml(stage.beforeTokens) + ' -> ' + escapeHtml(stage.afterTokens) + ' tokens · ' + escapeHtml(stage.note) + '</div></div>'
  ).join('');
  return '<div class="metric-row">' +
    '<div class="metric-pill"><strong>' + escapeHtml(String(stats.rawTokens)) + '</strong><span>raw</span></div>' +
    '<div class="metric-pill"><strong>' + escapeHtml(String(stats.cleanedTokens)) + '</strong><span>cleaned</span></div>' +
    '<div class="metric-pill"><strong>' + escapeHtml(String(stats.compiledTokens)) + '</strong><span>compiled</span></div>' +
    '<div class="metric-pill"><strong>' + escapeHtml(String(stats.savedTokens)) + '</strong><span>saved ' + escapeHtml(String(stats.savingsPercent)) + '%</span></div>' +
    '</div><details style="margin-top:10px"><summary class="meta" style="cursor:pointer">Show stage breakdown</summary><div class="stack" style="margin-top:8px">' + stages + '</div></details>' +
    renderCacheReportSlot();
}

function ccusageInstalled() {
  return lastOptionalTools.some(tool => tool.name === 'ccusage' && tool.installed);
}

// Everything above this point is estimated. ccusage reads what the
// providers actually billed, so the button is the only way to tell whether
// the estimate means anything - and it is useless without ccusage on PATH.
function renderCacheReportSlot() {
  if (!ccusageInstalled()) {
    return '<div class="muted" style="margin-top:10px">Measured cache usage needs ccusage. Install it with <code>npm i -g ccusage</code>, or use the Install button in Optional Tools.</div>';
  }
  return '<div style="margin-top:10px"><button class="secondary" id="cacheReportButton" type="button">Measured cache report</button>' +
    '<div id="cacheReportBody" style="margin-top:8px"></div></div>';
}

function renderCacheReport(report) {
  if (!report.ok) return '<div class="muted">' + escapeHtml(report.reason || 'ccusage failed.') + '</div>';
  // report.days counts days with data; report.window is what was asked for.
  if (!report.days) return '<div class="muted">No agent usage recorded in the last ' + escapeHtml(String(report.window)) + ' days.</div>';

  const models = (report.models || []).map(model =>
    '<div class="memory-row"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(model.model) + '</strong><span class="pill ok">' + escapeHtml(String(model.hitRatePct)) + '%</span></div>' +
    '<div class="meta">' + fmtNum(model.cacheReadTokens) + ' read from cache · $' + escapeHtml(model.cost.toFixed(2)) + '</div></div>'
  ).join('');

  // A hit rate is only readable next to what it is a rate of, so the raw
  // read/write/uncached split stays on screen with it.
  return '<div class="metric-row">' +
    '<div class="metric-pill"><strong>' + escapeHtml(String(report.hitRatePct)) + '%</strong><span>cache hit</span></div>' +
    '<div class="metric-pill"><strong>' + fmtNum(report.cacheReadTokens) + '</strong><span>read</span></div>' +
    '<div class="metric-pill"><strong>' + fmtNum(report.cacheCreationTokens) + '</strong><span>written</span></div>' +
    '<div class="metric-pill"><strong>' + fmtNum(report.inputTokens) + '</strong><span>uncached</span></div>' +
    '<div class="metric-pill"><strong>$' + escapeHtml(report.cost.toFixed(2)) + '</strong><span>cost</span></div>' +
    '</div>' +
    '<div class="meta" style="margin-top:6px">Measured by ccusage over ' + escapeHtml(String(report.days)) + ' day(s)' +
    (report.firstPeriod ? ', ' + escapeHtml(report.firstPeriod) + ' to ' + escapeHtml(report.lastPeriod || 'now') : '') +
    ' · ' + escapeHtml(String(report.readPerWrite)) + 'x read per write. These are the agent CLIs\' own cache breakpoints, not agent-bridge\'s.</div>' +
    (models ? '<div class="stack" style="margin-top:8px">' + models + '</div>' : '');
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function renderOptimizeStats(stats) {
  const baseline = stats && stats.baseline;
  const compiled = stats && stats.compiled;
  els.optSavedPctStat.textContent = baseline ? baseline.latest.savedPct + '%' : '—';
  els.optSavedTokensStat.textContent = baseline ? fmtNum(baseline.latest.savedTokens) : '—';
  els.optFilesStat.textContent = baseline ? String(baseline.latest.fileCount) : '—';
  els.optCompiledAvgStat.textContent = compiled ? fmtNum(compiled.average) : '—';
  els.optHistory.innerHTML = baseline && baseline.history.length
    ? baseline.history.map(renderBaselinePoint).join('')
    : '<div class="muted">No baseline runs recorded yet. Click Measure Savings.</div>';
}

function renderBaselinePoint(point) {
  return '<div class="card"><div class="toolbar" style="justify-content:space-between">' +
    '<strong>' + escapeHtml(point.savedPct) + '% saved</strong>' +
    '<span class="pill ok">-' + fmtNum(point.savedTokens) + '</span></div>' +
    '<div class="meta">' + escapeHtml(point.fileCount) + ' files | index ' + fmtNum(point.optimizedTokens || 0) + ' tokens | ' + escapeHtml(point.agent || '?') + '</div>' +
    '<div class="meta">' + escapeHtml(point.createdAt) + '</div></div>';
}

function renderOptimizeResult(result) {
  const s = result.summary;
  const skipped = result.skipped && result.skipped.length
    ? '<div class="muted">Skipped ' + result.skipped.length + ': ' + escapeHtml(result.skipped.slice(0, 5).join(', ')) + (result.skipped.length > 5 ? ', …' : '') + '</div>'
    : '';
  els.optResult.innerHTML =
    '<div class="grid-3">' +
    '<div class="card"><div class="meta">Read raw source</div><strong>' + fmtNum(s.baselineTokens) + '</strong><div class="muted">' + s.fileCount + ' files in full</div></div>' +
    '<div class="card"><div class="meta">Repo map index</div><strong>' + fmtNum(s.optimizedTokens) + '</strong><div class="muted">compact overview</div></div>' +
    '<div class="card"><div class="meta">Saved</div><strong>' + fmtNum(s.savedTokens) + ' (' + s.savedPct + '%)</strong><div class="muted">' + (result.precise ? 'precise tokenizer' : 'heuristic') + '</div></div>' +
    '</div>' + skipped;
  els.optTopFiles.innerHTML = (result.topFiles && result.topFiles.length)
    ? result.topFiles.map(file =>
        '<div class="card"><div class="toolbar" style="justify-content:space-between">' +
        '<code class="meta">' + escapeHtml(file.path) + '</code>' +
        '<span class="pill">' + fmtNum(file.tokens) + ' tokens</span></div></div>'
      ).join('')
    : '<div class="muted">No per-file costs.</div>';
}

function renderTask(task) {
  return '<div class="card"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(task.title) + '</strong>' +
    '<span class="toolbar"><button class="secondary edit-task" data-task-id="' + escapeHtml(task.id) + '" type="button">Edit</button>' +
    '<button class="ghost delete-task" data-task-id="' + escapeHtml(task.id) + '" type="button">Delete</button></span></div>' +
    '<div class="meta">' + escapeHtml(task.status) + ' | ' + escapeHtml(task.ownerAgent || 'unknown') + '</div>' +
    '<div class="meta">' + escapeHtml(task.id) + '</div></div>';
}

function renderLiveTask(entry, index, entries) {
  const task = entry.task;
  const state = entry.sessionState ? String(entry.sessionState.content || '').replace(/^(?:claude|codex|antigravity|generic) latest response:\s*/i, '') : 'No live response yet.';
  const active = Boolean(entry.hasActiveSession || (entry.sessions || []).length);
  const selected = task.id === selectedLiveTaskId;
  const selectedIndex = entries.findIndex(item => item.task.id === selectedLiveTaskId);
  const depthClass = selected ? ' is-selected' : (selectedIndex >= 0 && index < selectedIndex ? ' is-before' : ' is-after');
  const lane = entry.lane;
  const changes = entry.changes || [];
  const leases = entry.leases || [];
  const requests = (entry.requests || []).filter(request => request.status === 'pending');
  const events = (entry.events || []).slice(0, 4);
  const readLeases = leases.filter(lease => lease.mode === 'read').length;
  const writeLeases = leases.filter(lease => lease.mode === 'write').length;
  const addedChanges = changes.filter(change => change.changeType === 'added').length;
  const deletedChanges = changes.filter(change => change.changeType === 'deleted').length;
  const changeStats = summarizeChangeStats(changes);
  const changedCount = changes.length - addedChanges - deletedChanges;
  const conflicts = changes.filter(change => change.status === 'conflict').length;
  const alert = conflicts > 0 || requests.length > 0 || (lane && lane.status === 'conflict');
  const laneText = lane ? lane.mode + ' / ' + lane.status : 'no lane';
  const timelineHtml = events.length ? events.map(renderSessionEvent).join('') : '<div class="muted">No task events yet.</div>';
  const requestHtml = requests.length ? requests.map(request => renderAgentRequest(request, { compact: true })).join('') : '<div class="muted">No pending requests for this task.</div>';
  const stats = entry.tokenStats || { rawTokens: 0, cleanedTokens: 0, compiledTokens: 0, savedTokens: 0, savingsPercent: 0 };
  const taskSession = (entry.sessions || []).find(session => session.hasWindow && session.agent === task.ownerAgent) ||
    (entry.sessions || []).find(session => session.hasWindow) ||
    (entry.sessions || []).find(session => session.agent === task.ownerAgent) ||
    (entry.sessions || [])[0] || {};
  const taskAgent = taskSession.agent || task.ownerAgent || '';
  return '<div class="card live-task-card' + (active ? ' is-active' : ' is-idle') + (alert ? ' has-alert' : '') + depthClass + '" data-task-id="' + escapeHtml(task.id) + '" tabindex="0" role="button" aria-current="' + (selected ? 'true' : 'false') + '">' +
    '<div class="toolbar" style="justify-content:space-between;align-items:flex-start"><div><strong class="task-card-title">' + escapeHtml(task.title) + '</strong><div class="meta">' + escapeHtml(task.ownerAgent || 'unknown') + ' | ' + escapeHtml(laneText) + '</div></div>' +
    '<span class="task-status active">live</span></div>' +
    '<div class="metric-row">' +
      '<div class="metric-pill"><strong>' + String(readLeases) + '/' + String(writeLeases) + '</strong><span>read/write leases</span></div>' +
      '<div class="metric-pill"><strong>+' + String(changeStats.insertions) + ' / -' + String(changeStats.deletions) + '</strong><span>line changes</span></div>' +
      '<div class="metric-pill"><strong>' + String(changedCount) + '</strong><span>modified</span></div>' +
      '<div class="metric-pill"><strong>' + String(requests.length) + '</strong><span>task requests</span></div>' +
    '</div>' +
    '<div class="grid-2" style="align-items:start">' +
      '<div class="task-card-section task-card-panel"><h3>Latest Response</h3><div class="memory-content live-task-state">' + escapeHtml(state) + '</div></div>' +
      '<div class="task-card-section task-card-panel"><h3>Token Savings</h3><div class="metric-row"><div class="metric-pill"><strong>' + escapeHtml(String(stats.compiledTokens || 0)) + '</strong><span>compiled</span></div><div class="metric-pill"><strong>' + escapeHtml(String(stats.savedTokens || 0)) + '</strong><span>saved ' + escapeHtml(String(stats.savingsPercent || 0)) + '%</span></div></div><button class="ghost open-token" data-task-id="' + escapeHtml(task.id) + '" type="button">Details</button></div>' +
      '<div class="task-card-section task-card-panel"><h3>Latest Event Timeline</h3><div class="task-card-list">' + timelineHtml + '</div></div>' +
      '<div class="task-card-section task-card-panel"><div class="toolbar" style="justify-content:space-between"><h3>Task Requests</h3>' + (requests.length ? '<button class="ghost request-clear-task" data-task-id="' + escapeHtml(task.id) + '" type="button">Clear all</button>' : '') + '</div><div class="task-card-list">' + requestHtml + '</div></div>' +
    '</div>' +
    '<div class="toolbar task-control-row">' +
      '<button class="secondary open-task-window" data-task-id="' + escapeHtml(task.id) + '" data-agent="' + escapeHtml(taskAgent) + '" data-session-id="' + escapeHtml(taskSession.sessionId || '') + '" type="button">Open Task Window</button>' +
      '<button class="ghost open-workgit" data-task-id="' + escapeHtml(task.id) + '" type="button">Work-Git</button>' +
      '<button class="ghost stop-task-card" data-task-id="' + escapeHtml(task.id) + '" type="button">Stop</button>' +
    '</div></div>';
}
function populateWorkTaskSelects(tasks, selectedId) {
  const options = (tasks || []).map(task => '<option value="' + escapeHtml(task.id) + '"' + (task.id === selectedId ? ' selected' : '') + '>' + escapeHtml(task.title) + '</option>').join('') || '<option value="">No task</option>';
  els.laneTaskId.innerHTML = options;
}

function renderWorkState(state, selectedTaskId) {
  const selectedLive = (state.liveTasks || []).find(item => item.task.id === selectedTaskId);
  const changes = selectedLive?.changes || state.taskChanges || [];
  const leases = selectedTaskId
    ? (selectedLive && Array.isArray(selectedLive.leases) ? selectedLive.leases : (state.fileLeases || []).filter(lease => lease.taskId === selectedTaskId))
    : (state.fileLeases || []);
  els.workChanges.innerHTML = changes.length ? changes.map(renderTaskChange).join('') : '<div class="muted">No recorded changes. Run task scan or add changes through the API.</div>';
  els.workLeases.innerHTML = leases.length ? leases.map(renderLease).join('') : '<div class="muted">No active leases.</div>';
}

function optionHtml(items, selectedId, labelFn) {
  return (items || []).map(item => '<option value="' + escapeHtml(item.id) + '"' + (item.id === selectedId ? ' selected' : '') + '>' + escapeHtml(labelFn(item)) + '</option>').join('');
}

function setSelectOptions(select, html, emptyLabel) {
  if (!select) return;
  const previous = select.value;
  select.innerHTML = (emptyLabel ? '<option value="">' + escapeHtml(emptyLabel) + '</option>' : '') + html;
  if (previous && Array.from<any>(select.options).some(option => option.value === previous)) select.value = previous;
}


function renderWorkforceState(state) {
  const agents = state.registeredAgents || [];
  lastRegisteredAgents = agents;
  renderProviderToggles();
  const presets = state.defaultAgentPresets || [];
  const selectedPresetCount = presets.filter(preset => preset.selected).length;
  if (els.defaultAgentSelectAll) {
    els.defaultAgentSelectAll.checked = presets.length > 0 && selectedPresetCount === presets.length;
    els.defaultAgentSelectAll.indeterminate = selectedPresetCount > 0 && selectedPresetCount < presets.length;
    els.defaultAgentSelectAll.disabled = presets.length === 0;
  }
  if (els.defaultAgentPresetsSummary) {
    els.defaultAgentPresetsSummary.textContent = selectedPresetCount
      ? selectedPresetCount + ' of ' + presets.length + ' selected'
      : 'No default agents selected.';
  }
  if (els.defaultAgentPresets) {
    els.defaultAgentPresets.innerHTML = presets.length ? presets.map(preset =>
      '<label class="card default-agent-option">' +
        '<input class="default-agent-preset" type="checkbox" data-preset-key="' + escapeHtml(preset.key) + '"' + (preset.selected ? ' checked' : '') + '>' +
        '<span class="default-agent-option-copy"><strong>' + escapeHtml(preset.label) + '</strong>' +
        '<span class="meta" style="display:block">' + escapeHtml(preset.provider) + ' | ' + escapeHtml(preset.model) + ' | effort: ' + escapeHtml(preset.reasoningEffort || 'default') + '</span>' +
        '<span class="muted" style="display:block">' + escapeHtml(preset.description) + '</span></span>' +
        '<button class="ghost default-agent-delete" data-preset-key="' + escapeHtml(preset.key) + '" data-preset-label="' + escapeHtml(preset.label) + '" data-preset-custom="' + (preset.custom ? 'true' : 'false') + '" type="button">Delete</button>' +
      '</label>'
    ).join('') : '<div class="muted">No default agent presets available.</div>';
  }
  els.workforceAgents.innerHTML = agents.length ? agents.map(agent => {
    const caps = (agent.capabilities || []).slice(0, 4).map(item => '<span class="tag">' + escapeHtml(item) + '</span>').join('');
    return '<div class="card"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(agent.name) + '</strong><span class="pill ' + (agent.enabled ? 'ok' : 'warn') + '">' + (agent.enabled ? 'enabled' : 'disabled') + '</span></div>' +
      '<div class="meta">' + escapeHtml(agent.provider) + ' | ' + escapeHtml(agent.mode) + (agent.model ? ' | ' + escapeHtml(agent.model) : '') +
      ' | effort: ' + escapeHtml(agent.reasoningEffort || 'default') + '</div>' +
      (agent.description ? '<div class="muted">' + escapeHtml(agent.description) + '</div>' : '') +
      '<div>' + caps + '</div><div class="toolbar" style="margin-top:8px">' +
      '<button class="ghost agent-toggle" data-agent-id="' + escapeHtml(agent.id) + '" data-enabled="' + (agent.enabled ? 'false' : 'true') + '" type="button">' + (agent.enabled ? 'Disable' : 'Enable') + '</button>' +
      '<button class="ghost agent-edit" data-agent-id="' + escapeHtml(agent.id) + '" data-agent-name="' + escapeHtml(agent.name) + '" data-agent-description="' + escapeHtml(agent.description || '') + '" data-agent-provider="' + escapeHtml(agent.provider) + '" data-agent-mode="' + escapeHtml(agent.mode) + '" data-agent-command="' + escapeHtml(agent.command || '') + '" data-agent-base-url="' + escapeHtml(agent.baseUrl || '') + '" data-agent-model="' + escapeHtml(agent.model || '') + '" data-agent-reasoning="' + escapeHtml(agent.reasoningEffort || '') + '" data-agent-credential="' + escapeHtml(agent.credentialRef || '') + '" data-agent-capabilities="' + escapeHtml((agent.capabilities || []).join(',')) + '" type="button">Edit</button>' +
      '<button class="ghost agent-delete" data-agent-id="' + escapeHtml(agent.id) + '" data-agent-name="' + escapeHtml(agent.name) + '" data-agent-preset="' + escapeHtml(agent.presetKey || '') + '" type="button">' + (agent.presetKey ? 'Remove' : 'Delete') + '</button>' +
      '</div></div>';
  }).join('') : '<div class="muted">No registered agents.</div>';
}
function renderTaskChange(change) {
  const insertions = Number(change.insertions || 0);
  const deletions = Number(change.deletions || 0);
  const diffHtml = change.diff
    ? '<pre class="git-diff" aria-label="Git diff">' + renderGitDiff(change.diff) + '</pre>'
    : '<div class="muted">No git diff available for this file.</div>';
  return '<div class="card"><div class="toolbar" style="justify-content:space-between"><code class="meta">' + escapeHtml(change.path) + '</code><span class="pill">' + escapeHtml(change.status) + '</span></div>' +
    '<div class="meta">' + escapeHtml(change.changeType) + ' | +' + String(insertions) + ' / -' + String(deletions) + (change.currentHash ? ' | ' + escapeHtml(String(change.currentHash).slice(0, 12)) : '') + '</div>' +
    '<div class="memory-content">' + escapeHtml(change.diffSummary || 'No summary recorded.') + '</div>' +
    diffHtml + '</div>';
}

function summarizeChangeStats(changes) {
  return (changes || []).reduce((total, change) => ({
    insertions: total.insertions + Number(change.insertions || 0),
    deletions: total.deletions + Number(change.deletions || 0)
  }), { insertions: 0, deletions: 0 });
}

function renderGitDiff(diff) {
  return String(diff || '').split('\n').map(line => {
    const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff --git')
      ? ' meta'
      : line.startsWith('+')
        ? ' add'
        : line.startsWith('-')
          ? ' del'
          : '';
    return '<span class="git-diff-line' + cls + '">' + escapeHtml(line || ' ') + '</span>';
  }).join('\n');
}

function renderLease(lease) {
  return '<div class="card" data-lease-card="' + escapeHtml(lease.id) + '"><div class="toolbar" style="justify-content:space-between"><code class="meta">' + escapeHtml(lease.path) + '</code><span class="pill ok">' + escapeHtml(lease.mode) + '</span></div>' +
    '<div class="meta">' + escapeHtml(lease.agent || 'unknown') + ' | expires ' + escapeHtml(lease.expiresAt) + '</div>' +
    '<div class="toolbar"><button class="ghost release-lease" data-lease-id="' + escapeHtml(lease.id) + '" data-task-id="' + escapeHtml(lease.taskId || '') + '" type="button">Release</button></div></div>';
}

function renderAgentRequest(request, options: any = {}) {
  const task = lastTasks.find(item => item.id === request.taskId);
  const orchestrationRequest = orchestrationTaskIds.has(request.taskId || '');
  // Spawn approvals already have Accept/Reject controls; a neutral
  // A neutral resolved status would silently behave like a rejection at the gate.
  const resolveButton = request.status === 'pending' && request.type !== 'approval'
    ? '<button class="ghost request-resolve" data-request-id="' + escapeHtml(request.id) + '" data-task-id="' + escapeHtml(request.taskId || '') + '" data-resume="' + (orchestrationRequest ? 'true' : 'false') + '" type="button">' + (orchestrationRequest ? 'Resolve &amp; Resume' : 'Resolve') + '</button>'
    : '';
  return '<div class="card request-card candidate-row" data-request-id="' + escapeHtml(request.id) + '">' +
    '<div class="toolbar" style="justify-content:space-between;align-items:flex-start"><div><strong>' + escapeHtml(request.title) + '</strong>' +
    '<div class="meta">' + escapeHtml(request.agent || 'unknown') + ' | ' + escapeHtml(request.status) + (task ? ' | ' + escapeHtml(task.title) : '') + '</div></div>' +
    '<span class="toolbar" style="align-items:flex-start"><span class="pill warn">' + escapeHtml(request.type) + '</span>' + resolveButton +
    '<button class="ghost request-delete" data-request-id="' + escapeHtml(request.id) + '" type="button" aria-label="Delete notification" title="Delete notification">×</button></span></div></div>';
}

function syncRequestToasts(requests) {
  if (!els.requestToastStack) return;
  const pendingIds = new Set((requests || []).filter(request => request.taskId).map(request => request.id));
  qsa(els.requestToastStack, '.request-toast').forEach(toast => {
    if (!pendingIds.has(toast.dataset.requestId || '')) closeRequestToast(toast.dataset.requestId || '');
  });
  (requests || []).filter(request => request.taskId).forEach(request => {
    if (seenRequestToastIds.has(request.id)) return;
    seenRequestToastIds.add(request.id);
    showRequestToast(request);
  });
}

function showRequestToast(request) {
  const task = lastTasks.find(item => item.id === request.taskId);
  const toast = document.createElement('div');
  toast.className = 'request-toast';
  toast.dataset.requestId = request.id;
  toast.dataset.taskId = request.taskId || '';
  toast.setAttribute('role', 'button');
  toast.setAttribute('tabindex', '0');
  toast.innerHTML =
    '<div class="toolbar" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">' +
      '<strong class="request-toast-title" title="' + escapeHtml(request.title || 'Task request') + '">' +
        escapeHtml(clampText(request.title || 'Task request', 140)) + '</strong>' +
      '<button class="request-toast-close" type="button" aria-label="Dismiss request notification">X</button>' +
    '</div>' +
    '<div class="request-toast-meta">' + escapeHtml(request.agent || 'unknown') + ' | ' + escapeHtml(request.type || 'request') + (task ? ' | ' + escapeHtml(task.title) : '') +
      (orchestrationTaskIds.has(request.taskId || '') ? ' | opens Orchestration' : '') + '</div>';
  els.requestToastStack.appendChild(toast);
  requestToastTimers.set(request.id, window.setTimeout(() => closeRequestToast(request.id), 15000));
}

function closeRequestToast(requestId) {
  if (!requestId || !els.requestToastStack) return;
  const timer = requestToastTimers.get(requestId);
  if (timer) window.clearTimeout(timer);
  requestToastTimers.delete(requestId);
  const toast = qs(els.requestToastStack, '.request-toast[data-request-id="' + cssEscape(requestId) + '"]');
  if (toast) toast.remove();
}

function closeRunToast(runId) {
  if (!runId || !els.requestToastStack) return;
  const timer = runToastTimers.get(runId);
  if (timer) window.clearTimeout(timer);
  runToastTimers.delete(runId);
  const toast = qs(els.requestToastStack, '.run-toast[data-run-id="' + cssEscape(runId) + '"]');
  if (toast) toast.remove();
}

function showRunCompletionToast(run, agentName) {
  if (!els.requestToastStack) return;
  const succeeded = run.status === 'done';
  const stopped = run.status === 'stopped';
  const toast = document.createElement('div');
  toast.className = 'request-toast run-toast ' + (succeeded ? 'is-success' : 'is-failure');
  toast.dataset.runId = run.id;
  toast.setAttribute('role', 'button');
  toast.setAttribute('tabindex', '0');
  const outcome = succeeded ? 'completed' : (stopped ? 'stopped' : 'failed');
  const detail = succeeded
    ? 'Process exited successfully; subtask is awaiting review.'
    : (run.exitCode == null ? 'Open Runs for details.' : 'Exit code ' + run.exitCode + '. Open Runs for details.');
  toast.innerHTML =
    '<div class="toolbar" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">' +
      '<strong class="request-toast-title">' + escapeHtml(agentName + ' ' + outcome) + '</strong>' +
      '<button class="request-toast-close" type="button" aria-label="Dismiss run notification">X</button>' +
    '</div>' +
    '<div class="request-toast-meta">' + escapeHtml(detail) + '</div>';
  els.requestToastStack.appendChild(toast);
  runToastTimers.set(run.id, window.setTimeout(() => closeRunToast(run.id), succeeded ? 15000 : 30000));
}

function syncRunCompletionToasts(runs, agentsById) {
  (runs || []).forEach(run => {
    const previous = runStatusById.get(run.id);
    const wasActive = previous === 'starting' || previous === 'running' || previous === 'waiting' || previous === 'stopping';
    if (wasActive && !isRunActive(run) && run.status !== 'stopping') {
      const agent = agentsById[run.agentId];
      showRunCompletionToast(run, agent ? agent.name : run.agentId);
    }
    runStatusById.set(run.id, run.status);
  });
}

function openRequestToastTask(taskId, requestId) {
  closeRequestToast(requestId);
  if (!taskId) return;
  // An approval/question raised by a leader is answered on the Orchestration
  // board, so send the click there — and to that orchestration, not whichever
  // one the picker happened to be showing.
  if (orchestrationTaskIds.has(taskId)) {
    selectedOrchestrationTaskId = taskId;
    const picker = elById('orchestratorPicker');
    if (picker) picker.value = taskId;
    activateView('orchestrator');
    return;
  }
  selectedLiveTaskId = taskId;
  contextEditTouched = false;
  activateView('overview');
  if (lastState) renderState(lastState);
  syncLiveTaskCarousel(true);
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
function renderMemoryCandidate(candidate) {
  const tags = (candidate.tags || []).map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
  return '<div class="memory-row candidate-row"><div class="toolbar" style="justify-content:space-between;align-items:flex-start"><div><div class="meta">proposed ' + escapeHtml(candidate.type) + ' · importance ' + escapeHtml(String(candidate.importance)) + '</div><div class="memory-content">' + escapeHtml(candidate.content) + '</div><div>' + tags + '</div></div><div class="toolbar"><button class="secondary review-candidate" data-candidate-id="' + escapeHtml(candidate.id) + '" data-action="promote" type="button">Promote</button><button class="ghost review-candidate" data-candidate-id="' + escapeHtml(candidate.id) + '" data-action="reject" type="button">Dismiss</button></div></div></div>';
}

function renderSessionEvent(event) {
  return '<div class="memory-row"><div class="meta">' + escapeHtml(event.kind.replace(/_/g, ' ')) + ' · ' + escapeHtml(new Date(event.createdAt).toLocaleString()) + '</div><div class="memory-content">' + escapeHtml(event.summary || 'No summary recorded.') + '</div></div>';
}

function populateTaskSelects(tasks, currentId) {
  const options = tasks.map(task => '<option value="' + escapeHtml(task.id) + '">' + escapeHtml(task.title) + ' (' + escapeHtml(task.status) + ')</option>').join('') || '<option value="">No task</option>';
  [els.memoryTaskId, els.compileTaskId].forEach(select => {
    const wanted = select.value || currentId || '';
    select.innerHTML = options;
    if (Array.from<any>(select.options).some(option => option.value === wanted)) select.value = wanted;
  });
}

function populateSessionTaskSelect(tasks, currentId) {
  const selectable = tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled');
  const wanted = els.sessionTaskId.value || currentId || '';
  els.sessionTaskId.innerHTML = selectable.map(task => '<option value="' + escapeHtml(task.id) + '">' + escapeHtml(task.title) + '</option>').join('') || '<option value="">No active task</option>';
  if (Array.from<any>(els.sessionTaskId.options).some(option => option.value === wanted)) els.sessionTaskId.value = wanted;
}

function fillTaskEditor(task) {
  if (!task) return;
  els.editTaskId.value = task.id || '';
  els.editTaskTitle.value = task.title || '';
  els.editTaskGoal.value = task.goal || '';
  els.editTaskStatus.value = task.status || 'in_progress';
  els.editTaskAgent.value = task.ownerAgent || 'codex';
  taskEditTouched = true;
}

function renderMemory(memory) {
  const tags = (memory.tags || []).map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
  return '<div class="memory-row"><div class="meta">' + escapeHtml(memory.type) + ' | importance ' + memory.importance + ' | ' + escapeHtml(memory.sourceAgent || 'manual') + '</div>' +
    '<div class="memory-content">' + escapeHtml(memory.content) + '</div><div>' + tags + '</div></div>';
}

function renderRepositoryMemory(memory) {
  const tags = (memory.tags || []).map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
  return '<div class="memory-row"><div class="toolbar" style="justify-content:space-between;align-items:flex-start"><div><div class="meta">' + escapeHtml(memory.type) + ' | importance ' + memory.importance + ' | ' + escapeHtml(memory.sourceAgent || 'manual') + '</div>' +
    '<div class="memory-content">' + escapeHtml(memory.content) + '</div><div>' + tags + '</div></div>' +
    '<div class="toolbar"><button class="secondary edit-repo-memory" data-memory-id="' + escapeHtml(memory.id) + '" type="button">Edit</button><button class="ghost delete-repo-memory" data-memory-id="' + escapeHtml(memory.id) + '" type="button">Delete</button></div></div></div>';
}

function openRepoMemoryEditor(memory) {
  if (!memory) return;
  els.repoMemoryEditId.value = memory.id || '';
  els.repoMemoryEditContent.value = memory.content || '';
  els.repoMemoryEditType.value = memory.type || 'note';
  els.repoMemoryEditImportance.value = String(memory.importance || 3);
  els.repoMemoryEditTags.value = (memory.tags || []).join(',');
  els.repoMemoryEditModal.hidden = false;
  els.repoMemoryEditContent.focus();
}

function closeRepoMemoryEditor() {
  els.repoMemoryEditModal.hidden = true;
}

function renderSessionState(memory) {
  if (!memory) return '<div class="muted">No latest response captured yet.</div>';
  const content = String(memory.content || '').replace(/^(?:claude|codex|antigravity|generic) latest response:\s*/i, '');
  return '<div class="memory-row"><div class="meta">latest response | importance ' + memory.importance + ' | ' + escapeHtml(memory.sourceAgent || 'unknown') + '</div>' +
    '<div class="memory-content">' + escapeHtml(content) + '</div></div>';
}

function renderHandoff(handoff, task) {
  const section = (title, value) => '<div style="margin-top:12px"><div class="meta">' + title + '</div><div class="memory-content">' + escapeHtml(value || 'None recorded') + '</div></div>';
  return '<div class="card"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(task?.title || handoff.taskId) + '</strong><span class="pill">Created by ' + escapeHtml(handoff.fromAgent || 'unknown') + '</span></div>' +
    section('Goal', task?.goal) +
    section('Current state', handoff.summary) +
    section('Completed', (handoff.done || []).join('\n')) +
    section('Open loops', (handoff.next || []).map((item, index) => 'P' + index + ' — ' + item).join('\n')) +
    section('Decisions & gotchas', (handoff.risks || []).join('\n')) +
    section('Read first', (handoff.filesChanged || []).slice(0, 5).join('\n')) +
    '<div class="meta" style="margin-top:12px">.handoff/CURRENT.md</div></div>';
}

function renderHandoffHistory(item) {
  return '<div class="card"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(item.title) + '</strong><span class="pill">' + escapeHtml(item.state) + '</span></div>' +
    '<div class="meta">' + escapeHtml(item.date) + '</div><div class="memory-content" style="margin-top:8px">' + escapeHtml(item.summary || 'No current-state summary') + '</div>' +
    '<div class="meta" style="margin-top:8px">' + escapeHtml(item.path) + '</div></div>';
}

function renderTool(tool) {
  const installButton = tool.installable && !tool.installed
    ? '<button class="secondary install-tool" data-tool="' + escapeHtml(tool.name) + '" type="button">Install</button>'
    : '<span class="pill ok">ready</span>';
  return '<div class="tool-row"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(tool.name) + '</strong>' +
    '<span class="' + (tool.installed ? 'pill ok' : 'pill warn') + '">' + (tool.installed ? 'installed' : 'missing') + '</span></div>' +
    '<div class="muted">' + escapeHtml(tool.purpose) + '</div>' +
    '<div class="meta">' + escapeHtml(tool.usage || '') + '</div>' +
    '<div class="toolbar" style="margin-top:8px; justify-content:space-between"><code class="meta">' + escapeHtml(tool.command || '') + '</code>' +
    '<span class="help" data-tip="' + escapeHtml(tool.usage || tool.purpose || '') + '">?</span>' + installButton + '</div></div>';
}

function renderSkills(skills) {
  function renderSkill(skill) {
    return '<div class="card skill-card ' + escapeHtml(skill.scope) + '">' +
      '<div class="toolbar" style="justify-content:space-between"><strong>$' + escapeHtml(skill.name) + '</strong>' +
      '<button class="secondary delete-skill" data-scope="' + escapeHtml(skill.scope) + '" data-name="' + escapeHtml(skill.name) + '" type="button">Delete</button></div>' +
      '<div class="muted">' + escapeHtml(skill.description) + '</div>' +
      '<div class="meta">' + escapeHtml(skill.path) + '</div></div>';
  }
  const repo = skills.filter(skill => skill.scope === 'repo').map(renderSkill).join('');
  const global = skills.filter(skill => skill.scope === 'global').map(renderSkill).join('');
  els.repoSkills.innerHTML = repo || '<div class="muted">No repository skills yet.</div>';
  els.globalSkills.innerHTML = global || '<div class="muted">No global skills yet.</div>';
}

function renderStackModule(module) {
  return '<div class="tool-row"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(module.label) + '</strong>' +
    '<span class="' + (module.enabled ? 'pill ok' : 'pill') + '">' + (module.enabled ? 'enabled' : 'optional') + '</span></div>' +
    '<div class="muted">' + escapeHtml(module.purpose) + '</div>' +
    '<div class="toolbar" style="margin-top:8px; justify-content:space-between"><div class="meta">Installed: ' + (module.installed ? 'yes' : 'no') + '</div>' +
    '<span class="help" data-tip="' + escapeHtml(module.usage || module.purpose || '') + '">?</span></div></div>';
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function on(id, type, handler) {
  const element = elById(id);
  if (element) element.addEventListener(type, handler);
}

function onElement(element, type, handler) {
  if (element) element.addEventListener(type, handler);
}

function bindForm(id, path, options: any = {}) {
  const formElement = elById(id);
  if (!formElement) return;
  formElement.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = await api(path, { method: 'POST', body: JSON.stringify(formData(form)) });
    if (options.reset !== false) form.reset();
    if (options.onSuccess) options.onSuccess(data);
    await load(true);
  });
}

bindForm('taskForm', '/api/task/start');
bindForm('taskEditForm', '/api/task/update', { reset: false, onSuccess: data => { fillTaskEditor(data.task); } });
bindForm('memoryForm', '/api/memory/add', { onSuccess: () => {
  memoryImportanceTouched = false;
  setSuggestedMemoryImportance(true);
} });
bindForm('repoMemoryEditForm', '/api/repo-memory/update', { reset: false, onSuccess: () => {
  closeRepoMemoryEditor();
} });
on('repoMemoryEditCancel', 'click', closeRepoMemoryEditor);
on('repoMemoryEditClose', 'click', closeRepoMemoryEditor);
onElement(els.repoMemoryEditModal, 'click', event => {
  if (event.target === els.repoMemoryEditModal) closeRepoMemoryEditor();
});
bindForm('compileForm', '/api/context/compile', { reset: false, onSuccess: data => {
  contextEditTouched = true;
  if (data?.pack?.task?.id) {
    selectedLiveTaskId = data.pack.task.id;
    els.compileTaskId.value = data.pack.task.id;
  }
  if (data?.pack?.renderedMarkdown) {
    els.compiledEditor.value = data.pack.renderedMarkdown;
  }
} });
bindForm('handoffForm', '/api/handoff/save');
bindForm('laneForm', '/api/orchestration/lane', { reset: false });
// Declared up here with providerCommands: syncAgentSetupMode() runs during
// wiring below, well before the model helpers further down, and a const in
// their block would still be in its temporal dead zone at that point.
const AGENT_CUSTOM_MODEL = '__custom__';
// Provider -> CLI command. Keep this initialized before syncAgentSetupMode()
// is first called below. The catalog response later replaces these seeds.
let providerCommands = { codex: 'codex', claude: 'claude', antigravity: 'agy', gemini: 'gemini' };

function syncAgentSetupMode() {
  const form = elById('workforceAgentForm');
  if (!form) return;
  const mode = els.workforceAgentMode?.value || 'cli';
  qsa(form, '[data-mode-field]').forEach(field => {
    const visible = field.dataset.modeField === mode;
    field.style.display = visible ? '' : 'none';
    qsa(field, 'input, select, textarea').forEach(input => {
      input.disabled = !visible;
      if (!visible) input.value = '';
    });
  });
  // Switching back to cli leaves Command blank (cleared above while it was
  // hidden), so put the provider's binary back in it.
  if (mode === 'cli') syncAgentCommandDefault();
  syncAgentModelCustomField();
}

function resetAgentForm() {
  const form = elById('workforceAgentForm');
  if (form) form.reset();
  if (els.workforceAgentId) els.workforceAgentId.value = '';
  if (els.workforceAgentSubmit) els.workforceAgentSubmit.textContent = 'Add Agent';
  if (els.workforceAgentModalTitle) els.workforceAgentModalTitle.textContent = 'Add Agent';
  syncAgentSetupMode();
}
function closeAgentEditor() {
  els.workforceAgentModal.hidden = true;
  resetAgentForm();
}
function openAgentEditor() {
  resetAgentForm();
  els.workforceAgentModal.hidden = false;
  qs(document, '#workforceAgentForm input[name="name"]')?.focus();
}
on('workforceAgentForm', 'submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const agentId = els.workforceAgentId ? els.workforceAgentId.value : '';
  const path = agentId ? '/api/workforce/agent/update' : '/api/workforce/agent';
  const payload = formData(form);
  if (payload.model === AGENT_CUSTOM_MODEL) {
    payload.model = (elById('workforceAgentModelCustom')?.value || '').trim();
  }
  await api(path, { method: 'POST', body: JSON.stringify(payload) });
  closeAgentEditor();
  await load(true);
});
on('defaultAgentPresets', 'change', async event => {
  const checkbox = closestFrom(event.target, '.default-agent-preset');
  if (!checkbox) return;
  checkbox.disabled = true;
  try {
    await api('/api/workforce/default-agent/toggle', {
      method: 'POST',
      body: JSON.stringify({ presetKey: checkbox.dataset.presetKey, selected: checkbox.checked })
    });
    await load(true);
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    alert(error.message);
  } finally {
    checkbox.disabled = false;
  }
});
on('defaultAgentPresets', 'click', async event => {
  const button = closestFrom(event.target, '.default-agent-delete');
  if (!button) return;
  // The row is a <label>, so the click must not fall through to the checkbox.
  event.preventDefault();
  event.stopPropagation();
  const custom = button.dataset.presetCustom === 'true';
  const message = custom
    ? 'Delete "' + button.dataset.presetLabel + '" from the default agents table?'
    : 'Remove built-in "' + button.dataset.presetLabel + '" from the table? Restore built-ins brings it back.';
  if (!confirm(message)) return;
  button.disabled = true;
  try {
    await api('/api/workforce/default-agent/delete', {
      method: 'POST',
      body: JSON.stringify({ presetKey: button.dataset.presetKey })
    });
    await load(true);
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
});
on('defaultAgentPresetForm', 'submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const payload = {
    label: formText(data, 'label').trim(),
    provider: data.get('provider'),
    mode: 'cli',
    command: formText(data, 'command').trim(),
    model: formText(data, 'model').trim(),
    reasoningEffort: data.get('reasoningEffort') || '',
    capabilities: formText(data, 'capabilities').trim(),
    description: formText(data, 'description').trim()
  };
  try {
    await api('/api/workforce/default-agent/create', { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    await load(true);
  } catch (error) {
    alert(error.message);
  }
});
on('defaultAgentPresetRestore', 'click', async () => {
  try {
    await api('/api/workforce/default-agent/restore', { method: 'POST', body: '{}' });
    await load(true);
  } catch (error) {
    alert(error.message);
  }
});
onElement(els.defaultAgentSelectAll, 'change', async event => {
  const selectAll = event.currentTarget;
  const selected = selectAll.checked;
  const checkboxes = qsa(els.defaultAgentPresets, '.default-agent-preset');
  selectAll.disabled = true;
  checkboxes.forEach(checkbox => { checkbox.disabled = true; });
  try {
    for (const checkbox of checkboxes) {
      if (checkbox.checked === selected) continue;
      await api('/api/workforce/default-agent/toggle', {
        method: 'POST',
        body: JSON.stringify({ presetKey: checkbox.dataset.presetKey, selected })
      });
    }
    await load(true);
  } catch (error) {
    await load(true);
    alert(error.message);
  } finally {
    selectAll.disabled = false;
    checkboxes.forEach(checkbox => { checkbox.disabled = false; });
  }
});
const closeDefaultAgentPresets = () => { els.defaultAgentPresetsModal.hidden = true; };
on('defaultAgentPresetsOpen', 'click', () => { els.defaultAgentPresetsModal.hidden = false; });
on('defaultAgentPresetsClose', 'click', closeDefaultAgentPresets);
onElement(els.defaultAgentPresetsModal, 'click', event => {
  if (event.target === els.defaultAgentPresetsModal) closeDefaultAgentPresets();
});
on('workforceAgentOpen', 'click', openAgentEditor);
on('workforceAgentCancelEdit', 'click', closeAgentEditor);
on('workforceAgentModalClose', 'click', closeAgentEditor);
onElement(els.workforceAgentModal, 'click', event => {
  if (event.target === els.workforceAgentModal) closeAgentEditor();
});
onElement(els.workforceAgentMode, 'change', syncAgentSetupMode);
// Wired here rather than only in loadOrchestratorCatalog so the command
// prefill still works if the catalog request fails — the seed map in
// providerCommands covers the CLI providers either way.
onElement(elById('workforceAgentProvider'), 'change', syncAgentCommandDefault);
onElement(elById('workforceAgentProvider'), 'change', refreshAgentModelCatalog);
onElement(elById('workforceAgentModel'), 'change', syncAgentModelCustomField);
syncAgentSetupMode();

function selectedLiveEntry(taskId) {
  return (lastState?.liveTasks || []).find(item => item.task.id === taskId);
}

function liveTaskCards() {
  return qsa(els.liveTasks, '.live-task-card');
}

function syncLiveTaskCarousel(smooth = true) {
  const cards = liveTaskCards();
  const selectedIndex = cards.findIndex(card => card.dataset.taskId === selectedLiveTaskId);
  if (els.liveTaskPrev) els.liveTaskPrev.disabled = selectedIndex <= 0;
  if (els.liveTaskNext) els.liveTaskNext.disabled = selectedIndex < 0 || selectedIndex >= cards.length - 1;
  const selectedCard = selectedIndex >= 0 ? cards[selectedIndex] : null;
  if (selectedCard) {
    requestAnimationFrame(() => selectedCard.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', inline: 'center', block: 'nearest' }));
  }
}

function selectLiveTask(taskId, smooth = true) {
  if (!taskId || taskId === selectedLiveTaskId) {
    syncLiveTaskCarousel(smooth);
    return;
  }
  selectedLiveTaskId = taskId;
  contextEditTouched = false;
  if (lastState) renderState(lastState);
  syncLiveTaskCarousel(smooth);
}

function moveLiveTaskSelection(delta) {
  const cards = liveTaskCards();
  if (!cards.length) return;
  const selectedIndex = Math.max(0, cards.findIndex(card => card.dataset.taskId === selectedLiveTaskId));
  const nextIndex = Math.min(cards.length - 1, Math.max(0, selectedIndex + delta));
  const nextId = cards[nextIndex]?.dataset.taskId || '';
  selectLiveTask(nextId, true);
}

function openTaskDetail(title, html) {
  els.taskDetailTitle.textContent = title;
  els.taskDetailBody.innerHTML = html;
  els.taskDetailModal.hidden = false;
}

function closeTaskDetail() {
  els.taskDetailModal.hidden = true;
  els.taskDetailBody.innerHTML = '';
}

function openWorkGitDetail(taskId) {
  const entry = selectedLiveEntry(taskId);
  if (!entry) return;
  const lane = entry.lane;
  const changes = entry.changes || [];
  const leases = entry.leases || [];
  const laneHtml = lane
    ? '<div class="card"><strong>' + escapeHtml(lane.mode + ' / ' + lane.status) + '</strong><div class="meta">Base: ' + escapeHtml(lane.baseRef || 'HEAD') + (lane.worktreePath ? ' | ' + escapeHtml(lane.worktreePath) : '') + '</div></div>'
    : '<div class="muted">No lane configured for this task.</div>';
  openTaskDetail('Work-Git: ' + entry.task.title,
    '<div class="stack">' + laneHtml + '<div class="task-popup-grid"><div><h3>Changes</h3><div class="list">' +
    (changes.length ? changes.map(renderTaskChange).join('') : '<div class="muted">No recorded changes.</div>') +
    '</div></div><div><h3>Leases</h3><div class="list">' +
    (leases.length ? leases.map(renderLease).join('') : '<div class="muted">No active leases.</div>') +
    '</div></div></div></div>'
  );
}

function openTokenDetail(taskId) {
  const entry = selectedLiveEntry(taskId);
  if (!entry) return;
  openTaskDetail('Token Savings: ' + entry.task.title, renderTokenStats(entry.tokenStats || { rawTokens: 0, cleanedTokens: 0, compiledTokens: 0, cacheableTokens: 0, savedTokens: 0, savingsPercent: 0, stages: [] }));
}

on('taskDetailClose', 'click', closeTaskDetail);
on('liveTaskPrev', 'click', () => moveLiveTaskSelection(-1));
on('liveTaskNext', 'click', () => moveLiveTaskSelection(1));
onElement(els.taskDetailModal, 'click', event => {
  if (event.target === els.taskDetailModal) closeTaskDetail();
});
onElement(els.liveTasks, 'keydown', event => {
  const card = closestFrom(event.target, '.live-task-card');
  if (!card) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectLiveTask(card.dataset.taskId || '', true);
  }
});

document.addEventListener('click', async event => {
  // The button is rendered into the Token Savings popup, so it only exists
  // while that popup is open - delegation rather than a bound handler.
  const cacheReport = closestFrom(event.target, '#cacheReportButton');
  if (cacheReport) {
    const body = elById('cacheReportBody');
    cacheReport.disabled = true;
    cacheReport.textContent = 'Reading ccusage...';
    if (body) body.innerHTML = '';
    try {
      const report = await api('/api/cache-report?days=7');
      if (body) body.innerHTML = renderCacheReport(report);
    } catch (error) {
      if (body) body.innerHTML = '<div class="muted">' + escapeHtml(error.message || String(error)) + '</div>';
    } finally {
      cacheReport.disabled = false;
      cacheReport.textContent = 'Measured cache report';
    }
    return;
  }
  const openAgentTerminal = closestFrom(event.target, '.open-agent-terminal');
  if (openAgentTerminal) {
    const agent = openAgentTerminal.dataset.agent || '';
    openAgentTerminal.disabled = true;
    const status = elById('agentTerminalStatus');
    if (status) status.textContent = 'Opening ' + agent + ' terminal...';
    try {
      const data = await api('/api/session/terminal', {
        method: 'POST',
        body: JSON.stringify({ agent })
      });
      if (status) status.textContent = 'Opened ' + agent + ' · window ID ' + (data.terminal.windowId || data.sessionId);
      await load(true);
    } catch (error) {
      if (status) status.textContent = 'Open failed: ' + (error.message || String(error));
    } finally {
      openAgentTerminal.disabled = false;
    }
    return;
  }
  const release = closestFrom(event.target, '.release-lease');
  if (release) {
    const taskId = release.dataset.taskId || selectedLiveTaskId;
    const leaseId = release.dataset.leaseId || '';
    release.disabled = true;
    release.textContent = 'Releasing...';
    els.refreshPill.textContent = 'Releasing lease...';
    els.refreshPill.className = 'pill';
    try {
      await api('/api/orchestration/lease/release', { method: 'POST', body: JSON.stringify({ leaseId }) });
      const card = leaseId ? qs(document, '[data-lease-card="' + cssEscape(leaseId) + '"]') : null;
      if (card) card.remove();
      await load(true);
      if (taskId && els.taskDetailModal && !els.taskDetailModal.hidden) openWorkGitDetail(taskId);
      els.refreshPill.textContent = 'Lease released.';
      els.refreshPill.className = 'pill ok';
    } catch (error) {
      release.disabled = false;
      release.textContent = 'Release';
      els.refreshPill.textContent = 'Release failed: ' + (error.message || String(error));
      els.refreshPill.className = 'pill warn';
    }
    return;
  }
  const openWorkGit = closestFrom(event.target, '.open-workgit');
  if (openWorkGit) {
    openWorkGitDetail(openWorkGit.dataset.taskId || '');
    return;
  }
  const openTaskWindow = closestFrom(event.target, '.open-task-window');
  if (openTaskWindow) {
    const taskId = openTaskWindow.dataset.taskId || '';
    const agent = openTaskWindow.dataset.agent || 'codex';
    const bindCommand = 'agent-bridge session start --agent ' + agent + ' --task ' + taskId;
    selectedLiveTaskId = taskId;
    openTaskWindow.disabled = true;
    els.refreshPill.textContent = 'Focusing task terminal...';
    els.refreshPill.className = 'pill';
    try {
      const data = await api('/api/session/focus', {
        method: 'POST',
        body: JSON.stringify({ taskId, agent: openTaskWindow.dataset.agent || undefined, sessionId: openTaskWindow.dataset.sessionId || undefined })
      });
      await load(true);
      if (data.focus && data.focus.focused) {
        els.refreshPill.textContent = 'Task terminal focused.';
        els.refreshPill.className = 'pill ok';
      } else {
        els.refreshPill.textContent = 'Task terminal not found. Run in that terminal: ' + bindCommand;
        els.refreshPill.className = 'pill warn';
      }
    } catch (error) {
      els.refreshPill.textContent = 'Focus task terminal failed. Run in that terminal: ' + bindCommand;
      els.refreshPill.className = 'pill warn';
    } finally {
      openTaskWindow.disabled = false;
    }
    return;
  }
  const openToken = closestFrom(event.target, '.open-token');
  if (openToken) {
    openTokenDetail(openToken.dataset.taskId || '');
    return;
  }
  const agentToggle = closestFrom(event.target, '.agent-toggle');
  if (agentToggle) {
    agentToggle.disabled = true;
    try {
      await api('/api/workforce/agent/toggle', {
        method: 'POST',
        body: JSON.stringify({ agentId: agentToggle.dataset.agentId, enabled: agentToggle.dataset.enabled })
      });
      await load(true);
    } finally {
      agentToggle.disabled = false;
    }
    return;
  }
  const agentEdit = closestFrom(event.target, '.agent-edit');
  if (agentEdit) {
    const form = elById('workforceAgentForm');
    if (form && els.workforceAgentId) {
      form.elements.name.value = agentEdit.dataset.agentName || '';
      form.elements.description.value = agentEdit.dataset.agentDescription || '';
      form.elements.provider.value = agentEdit.dataset.agentProvider || 'codex';
      form.elements.mode.value = agentEdit.dataset.agentMode || 'cli';
      form.elements.command.value = agentEdit.dataset.agentCommand || '';
      form.elements.baseUrl.value = agentEdit.dataset.agentBaseUrl || '';
      form.elements.credentialRef.value = agentEdit.dataset.agentCredential || '';
      form.elements.capabilities.value = agentEdit.dataset.agentCapabilities || '';
      els.workforceAgentId.value = agentEdit.dataset.agentId || '';
      if (els.workforceAgentSubmit) els.workforceAgentSubmit.textContent = 'Update Agent';
      if (els.workforceAgentModalTitle) els.workforceAgentModalTitle.textContent = 'Edit Agent';
      syncAgentSetupMode();
      // Re-applied after the mode sync: what this agent is actually
      // registered with wins over the provider's default command, and the
      // model and effort level have to be set after their pickers are
      // rebuilt for this provider (the two Model fields share a name, so
      // form.elements.model is a node list whose value assignment silently
      // does nothing).
      syncAgentModelCatalog();
      form.elements.command.value = agentEdit.dataset.agentCommand || '';
      setAgentReasoningValue(agentEdit.dataset.agentReasoning || '');
      const editedModel = agentEdit.dataset.agentModel || '';
      if ((agentEdit.dataset.agentMode || 'cli') === 'api') {
        const apiModel = elById('workforceAgentApiModel');
        if (apiModel) apiModel.value = editedModel;
      } else {
        setAgentModelValue(editedModel);
      }
      selectOrchestratorFormTab('agents');
      els.workforceAgentModal.hidden = false;
      form.elements.name.focus();
    }
    return;
  }
  const agentDelete = closestFrom(event.target, '.agent-delete');
  if (agentDelete) {
    const confirmed = confirm(agentDelete.dataset.agentPreset
      ? 'Remove default agent "' + agentDelete.dataset.agentName + '" from the roster? Your edits will be preserved and restored if you select its preset again.'
      : 'Delete agent "' + agentDelete.dataset.agentName + '"? Historical assignments/runs keep referencing it by id.');
    if (!confirmed) return;
    agentDelete.disabled = true;
    try {
      await api('/api/workforce/agent/delete', { method: 'POST', body: JSON.stringify({ agentId: agentDelete.dataset.agentId }) });
      await load(true);
    } catch (error) {
      // Refused deletes carry the reason (e.g. the agent still leads an
      // unfinished orchestration); swallowing it left the button doing
      // nothing with no explanation.
      alert(error.message);
    } finally {
      agentDelete.disabled = false;
    }
    return;
  }
  const toastClose = closestFrom(event.target, '.request-toast-close');
  if (toastClose) {
    const toast = toastClose.closest('.request-toast');
    if (toast?.classList.contains('run-toast')) {
      closeRunToast(toast.dataset.runId || '');
      return;
    }
    closeRequestToast(toast?.dataset.requestId || '');
    return;
  }
  const requestToast = closestFrom(event.target, '.request-toast');
  if (requestToast) {
    if (requestToast.classList.contains('run-toast')) {
      closeRunToast(requestToast.dataset.runId || '');
      runsFilter = 'cycle';
      qsa(document, '[data-runs-filter]').forEach(button => {
        button.classList.toggle('active', button.dataset.runsFilter === runsFilter);
      });
      activateView('orchestrator');
      await refreshOrchestratorBoard();
      return;
    }
    openRequestToastTask(requestToast.dataset.taskId || '', requestToast.dataset.requestId || '');
    return;
  }
  const liveTaskCard = closestFrom(event.target, '.live-task-card');
  if (liveTaskCard && !closestFrom(event.target, 'button, input, textarea, select, a')) {
    selectLiveTask(liveTaskCard.dataset.taskId || '', true);
    return;
  }
  const requestDelete = closestFrom(event.target, '.request-delete');
  const requestResolve = closestFrom(event.target, '.request-resolve');
  if (requestResolve) {
    requestResolve.disabled = true;
    const resume = requestResolve.dataset.resume === 'true';
    try {
      await api('/api/orchestration/request/' + encodeURIComponent(requestResolve.dataset.requestId) + '/resolve', {
        method: 'POST',
        body: JSON.stringify({
          status: 'resolved',
          response: resume ? 'Resolved and resumed from dashboard.' : 'Resolved from dashboard.',
          resume
        })
      });
      seenRequestToastIds.delete(requestResolve.dataset.requestId || '');
      closeRequestToast(requestResolve.dataset.requestId || '');
      await load(true);
      if (resume) await refreshOrchestratorBoard();
    } catch (error) {
      alert(error.message);
      requestResolve.disabled = false;
    }
    return;
  }
  if (requestDelete) {
    requestDelete.disabled = true;
    try {
      await api('/api/request/delete', { method: 'POST', body: JSON.stringify({ requestId: requestDelete.dataset.requestId }) });
      seenRequestToastIds.delete(requestDelete.dataset.requestId || '');
      closeRequestToast(requestDelete.dataset.requestId || '');
      await load(true);
    } finally {
      requestDelete.disabled = false;
    }
    return;
  }
  const requestClearTask = closestFrom(event.target, '.request-clear-task');
  if (requestClearTask) {
    const container = requestClearTask.closest('.task-card-panel');
    const ids = container ? qsa(container, '.request-card[data-request-id]').map(card => card.dataset.requestId) : [];
    if (!ids.length) return;
    if (!confirm('Delete ' + ids.length + ' request(s) for this task?')) return;
    requestClearTask.disabled = true;
    try {
      await api('/api/request/clear', { method: 'POST', body: JSON.stringify({ ids }) });
      await load(true);
    } finally {
      requestClearTask.disabled = false;
    }
    return;
  }
  const approvalsClear = closestFrom(event.target, '#workforceApprovalsClear');
  if (approvalsClear) {
    const ids = Array.from(els.workforceApprovals ? qsa(els.workforceApprovals, '.request-card[data-request-id]') : []).map(card => card.dataset.requestId);
    if (!ids.length) return;
    if (!confirm('Delete all ' + ids.length + ' approval(s)?')) return;
    approvalsClear.disabled = true;
    try {
      await api('/api/request/clear', { method: 'POST', body: JSON.stringify({ ids }) });
      await load(true);
    } finally {
      approvalsClear.disabled = false;
    }
    return;
  }
});

qsa(document, '.session-action').forEach(button => {
  button.addEventListener('click', async event => {
    const actionButton = event.currentTarget;
    const action = actionButton.dataset.sessionAction;
    const data = formData(els.sessionForm);
    if (action === 'summary' && !String(data.text || '').trim()) {
      els.sessionStatus.textContent = 'Enter a current state first.';
      return;
    }
    actionButton.disabled = true;
    els.sessionStatus.textContent = action === 'summary' ? 'Updating…' : (action === 'start' ? 'Starting…' : 'Ending…');
    try {
      await api('/api/session/' + action, { method: 'POST', body: JSON.stringify(data) });
      if (action === 'summary') els.sessionForm.elements.text.value = '';
      els.sessionStatus.textContent = action === 'summary' ? 'State updated.' : (action === 'start' ? 'Session started.' : 'Session ended.');
      await load(true);
    } catch (error) {
      els.sessionStatus.textContent = error.message;
    } finally {
      actionButton.disabled = false;
    }
  });
});

function setSuggestedMemoryImportance(force = false) {
  if (!force && memoryImportanceTouched) return;
  const suggested = suggestedImportanceByType[els.memoryType.value] || 3;
  els.memoryImportance.value = String(suggested);
}
onElement(els.memoryType, 'change', () => setSuggestedMemoryImportance(true));
onElement(els.memoryImportance, 'input', () => { memoryImportanceTouched = true; });
setSuggestedMemoryImportance(true);

[els.editTaskTitle, els.editTaskGoal, els.editTaskStatus, els.editTaskAgent].filter(Boolean).forEach(input => {
  input.addEventListener('input', () => { taskEditTouched = true; });
  input.addEventListener('change', () => { taskEditTouched = true; });
});
onElement(els.compiledEditor, 'input', () => {
  contextEditTouched = true;
  els.contextSaveStatus.textContent = 'Unsaved changes';
});
on('saveCompiledButton', 'click', async () => {
  els.contextSaveStatus.textContent = 'Saving...';
  try {
    await api('/api/context/save', { method: 'POST', body: JSON.stringify({ taskId: selectedLiveTaskId || els.compileTaskId.value, content: els.compiledEditor.value }) });
    contextEditTouched = false;
    els.contextSaveStatus.textContent = 'Saved.';
    await load(true);
  } catch (error) {
    els.contextSaveStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  }
});

on('optimizeForm', 'submit', async event => {
  event.preventDefault();
  const button = els.optRunButton || elById('optRunButton');
  button.disabled = true;
  els.optStatus.textContent = 'Reading repo-map files and measuring…';
  try {
    const body: Record<string, any> = {};
    if (els.optLimit.value) body.limit = Number(els.optLimit.value);
    if (els.optFocus.value.trim()) body.focus = els.optFocus.value.trim();
    const data = await api('/api/optimize/baseline', { method: 'POST', body: JSON.stringify(body) });
    if (!data.result) {
      els.optStatus.innerHTML = '<span class="error">' + escapeHtml(data.message || 'Nothing to compare.') + '</span>';
    } else {
      els.optStatus.textContent = 'Measured ' + data.result.summary.fileCount + ' files.';
      renderOptimizeResult(data.result);
    }
    await load(true);
  } catch (error) {
    els.optStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  } finally {
    button.disabled = false;
  }
});

function activateView(view) {
  const button = qs(document, '.nav button[data-view="' + view + '"]');
  const panel = elById('view-' + view);
  if (!button || !panel) return;
  qsa(document, '.nav button').forEach(item => item.classList.remove('active'));
  qsa(document, '.view').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  panel.classList.add('active');
  if (view === 'graph' && !graphLoaded) loadGraph();
  if (view === 'orchestrator') { loadOrchestratorCatalog(); refreshOrchestratorBoard(); }
  if (view === 'workforce') loadOrchestratorCatalog();
}

qsa(document, '.nav button').forEach(button => {
  button.addEventListener('click', () => activateView(button.dataset.view));
});

let orchestratorCatalogs = [];
let orchestratorCatalogLoaded = false;
// CLI providers found on PATH, from the catalog probe. A provider with no
// registered agent yet still gets a row here, so ticking it is how the user
// staffs it for the first time.
let installedProviders = [];
let lastRegisteredAgents = [];

// One checkbox per provider, ticked when at least one of its agents is
// enabled. This replaced the per-orchestration "Team providers" allowlist:
// the roster in this tab is now the only thing that decides who may be
// staffed, so disabling a provider here keeps it out of every run.
function renderProviderToggles() {
  const wrap = elById('workforceProviderToggles');
  if (!wrap) return;
  const byProvider = new Map();
  installedProviders.forEach(entry => {
    byProvider.set(entry.provider, { provider: entry.provider, staffable: entry.staffable !== false, total: 0, enabled: 0 });
  });
  lastRegisteredAgents.forEach(agent => {
    const row = byProvider.get(agent.provider) || { provider: agent.provider, staffable: true, total: 0, enabled: 0 };
    row.total += 1;
    if (agent.enabled) row.enabled += 1;
    byProvider.set(agent.provider, row);
  });
  const rows = Array.from(byProvider.values());
  if (!rows.length) {
    wrap.innerHTML = '<span class="meta">No agent CLI found on PATH and no agent registered yet.</span>';
    return;
  }
  wrap.innerHTML = rows.map(row => {
    if (!row.staffable && !row.total) {
      return '<label style="display:inline-flex; align-items:center; gap:6px; opacity:0.55" ' +
        'title="Installed, but it answers inside its own window instead of on stdout, so the orchestrator cannot read the reply back. Register it as a manual agent and drive it by hand.">' +
        '<input type="checkbox" disabled style="width:auto; margin:0">' +
        escapeHtml(row.provider) + ' <span class="meta">(manual only)</span></label>';
    }
    const count = row.total
      ? row.enabled + '/' + row.total + ' agent(s)'
      : 'not registered yet';
    return '<label style="display:inline-flex; align-items:center; gap:6px; font-weight:500">' +
      '<input type="checkbox" class="provider-toggle" value="' + escapeHtml(row.provider) + '"' +
      (row.enabled > 0 ? ' checked' : '') + ' style="width:auto; margin:0">' +
      escapeHtml(row.provider) + ' <span class="meta">(' + escapeHtml(count) + ')</span></label>';
  }).join('');
}

onElement(elById('workforceProviderToggles'), 'change', async event => {
  const box = event.target.closest ? event.target.closest('.provider-toggle') : null;
  if (!box) return;
  box.disabled = true;
  try {
    await api('/api/workforce/agents/provider-enabled', {
      method: 'POST',
      body: JSON.stringify({ provider: box.value, enabled: box.checked })
    });
    await load(true);
  } catch (error) {
    box.checked = !box.checked;
    alert(error.message);
  } finally {
    box.disabled = false;
  }
});

// Explicit user pick from the Showing dropdown. Null means "follow the
// active task", which is only a default — the server falls back to the
// newest orchestration when the active task has none, so the board never
// renders blank just because the active task moved elsewhere.
let selectedOrchestrationTaskId = null;

function currentOrchestratorTaskId() {
  return selectedOrchestrationTaskId
    || (lastState && lastState.currentTask && lastState.currentTask.id)
    || '';
}

function renderOrchestratorPicker(orchestrations, activeTaskId) {
  const picker = elById('orchestratorPicker');
  if (!picker) return;
  const list = orchestrations || [];
  if (!list.length) {
    picker.innerHTML = '<option value="">No orchestrations yet</option>';
    return;
  }
  picker.innerHTML = list.map(item => {
    const title = (item.taskTitle || item.taskId || '').split('\n')[0].slice(0, 70);
    return '<option value="' + escapeHtml(item.taskId) + '"' +
      (item.taskId === activeTaskId ? ' selected' : '') + '>' +
      escapeHtml(item.status) + ' · ' + escapeHtml(title) + '</option>';
  }).join('');
}

function populateModelSelect(select, catalog) {
  select.innerHTML = (catalog ? catalog.models : []).map(model =>
    '<option value="' + escapeHtml(model.value) + '">' + escapeHtml(model.label) + '</option>'
  ).join('');
}

function populateReasoningSelect(select, catalog) {
  if (!select) return;
  const levels = catalog ? catalog.reasoning : [];
  select.innerHTML = '<option value="">default</option>' + levels.map(level =>
    '<option value="' + escapeHtml(level.value) + '">' + escapeHtml(level.label) + '</option>'
  ).join('');
}

function wireProviderTriplet(providerSelect, modelSelect, reasoningSelect) {
  if (!providerSelect || !modelSelect || !reasoningSelect) return;
  const previousProvider = providerSelect.value;
  providerSelect.innerHTML = orchestratorCatalogs.map(catalog =>
    '<option value="' + escapeHtml(catalog.provider) + '">' + escapeHtml(catalog.provider) + '</option>'
  ).join('');
  if (orchestratorCatalogs.some(catalog => catalog.provider === previousProvider)) {
    providerSelect.value = previousProvider;
  }
  const sync = () => {
    const previousModel = modelSelect.value;
    const previousReasoning = reasoningSelect.value;
    const catalog = orchestratorCatalogs.find(item => item.provider === providerSelect.value);
    populateModelSelect(modelSelect, catalog);
    populateReasoningSelect(reasoningSelect, catalog);
    if ([...modelSelect.options].some(option => option.value === previousModel)) modelSelect.value = previousModel;
    if ([...reasoningSelect.options].some(option => option.value === previousReasoning)) reasoningSelect.value = previousReasoning;
  };
  providerSelect.onchange = async () => {
    await refreshProviderCatalog(providerSelect.value);
    sync();
  };
  sync();
}

// Unlike wireProviderTriplet (which owns the provider <select> itself),
// the Agent Registry's provider select already has a fixed option list
// that includes non-catalog providers (deepseek, manual, generic, ...) —
// this only keeps the CLI model datalist and reasoning options in sync
// with whichever catalog-backed provider is currently selected.
// The Custom row only exists to keep models the catalog cannot know about
// reachable (a preview id, a provider with no catalog at all), so it stays
// out of the way until the picker asks for it.
function syncAgentModelCustomField() {
  const select = elById('workforceAgentModel');
  const field = elById('workforceAgentModelCustomField');
  const input = elById('workforceAgentModelCustom');
  if (!select || !field || !input) return;
  const custom = (els.workforceAgentMode?.value || 'cli') === 'cli' && select.value === AGENT_CUSTOM_MODEL;
  field.style.display = custom ? '' : 'none';
  input.disabled = !custom;
}

// A registered agent may hold a model this catalog does not list; keep it
// as its own option so Edit shows what the agent actually runs instead of
// dropping back to the provider default.
function setAgentModelValue(value) {
  const select = elById('workforceAgentModel');
  if (!select) return;
  const wanted = value || '';
  const known = Array.prototype.some.call(select.options, option => option.value === wanted);
  if (wanted && !known) {
    const option = document.createElement('option');
    option.value = wanted;
    option.textContent = wanted;
    select.insertBefore(option, select.options[select.options.length - 1]);
  }
  select.value = wanted;
  syncAgentModelCustomField();
}

// Same rule as setAgentModelValue: an agent may hold an effort level this
// provider's catalog does not list, and Edit must show what the agent
// actually runs with instead of silently resetting it to the default.
function setAgentReasoningValue(value) {
  const select = elById('workforceAgentReasoning');
  if (!select) return;
  const wanted = value || '';
  const known = Array.prototype.some.call(select.options, option => option.value === wanted);
  if (wanted && !known) {
    const option = document.createElement('option');
    option.value = wanted;
    option.textContent = wanted;
    select.appendChild(option);
  }
  select.value = wanted;
}

function syncAgentModelCatalog() {
  const providerSelect = elById('workforceAgentProvider');
  const select = elById('workforceAgentModel');
  if (!providerSelect || !select) return;
  const catalog = orchestratorCatalogs.find(item => item.provider === providerSelect.value);
  const previous = select.value;
  select.innerHTML = '<option value="">Provider default</option>' +
    (catalog ? catalog.models : []).map(model =>
      '<option value="' + escapeHtml(model.value) + '">' + escapeHtml(model.label) + '</option>'
    ).join('') +
    '<option value="' + AGENT_CUSTOM_MODEL + '">Custom — type a model name</option>';
  setAgentModelValue(previous);
  // Rebuilding the level list drops the selection, so put it back — a
  // provider/mode sync must not silently downgrade the agent to default.
  const reasoningSelect = elById('workforceAgentReasoning');
  const previousReasoning = reasoningSelect ? reasoningSelect.value : '';
  populateReasoningSelect(reasoningSelect, catalog);
  setAgentReasoningValue(previousReasoning);
  syncAgentCommandDefault();
}

async function refreshAgentModelCatalog() {
  const provider = elById('workforceAgentProvider')?.value;
  if (provider) await refreshProviderCatalog(provider);
  syncAgentModelCatalog();
}

async function refreshProviderCatalog(provider) {
  if (!orchestratorCatalogs.some(catalog => catalog.provider === provider)) return;
  try {
    const data = await api('/api/workforce/catalog?provider=' + encodeURIComponent(provider));
    const refreshed = data.catalogs && data.catalogs[0];
    if (!refreshed) return;
    orchestratorCatalogs = orchestratorCatalogs.map(catalog =>
      catalog.provider === provider ? refreshed : catalog
    );
  } catch (error) {
    // Keep the last successful catalog when the selected CLI cannot be probed.
  }
}

// Prefills Command with the CLI binary the selected provider actually
// launches — antigravity is "agy", not "antigravity", which is the single
// most common way to register an agent that can never spawn.
//
// Only fills a field that is empty or still holds another provider's
// default: a command the user typed (a wrapper script, an absolute path)
// survives a provider change, and so does the command loaded by Edit.
function syncAgentCommandDefault() {
  const form = elById('workforceAgentForm');
  const providerSelect = elById('workforceAgentProvider');
  if (!form || !providerSelect) return;
  const field = qs(form, '[data-mode-field="cli"] input[name="command"]');
  if (!field) return;
  const next = providerCommands[providerSelect.value] || '';
  const current = field.value.trim();
  const isDefaultOfSomeProvider = Object.values(providerCommands).includes(current);
  if (current && !isDefaultOfSomeProvider) return;
  field.value = next;
  // No CLI for this provider (api-only or manual): say so instead of
  // leaving the generic "codex or claude" hint on a field that must stay
  // empty.
  field.placeholder = next || 'No CLI for this provider';
}

async function loadOrchestratorCatalog() {
  if (orchestratorCatalogLoaded) return;
  try {
    const data = await api('/api/workforce/catalog');
    orchestratorCatalogs = data.catalogs || [];
    if (data.defaultCommands) providerCommands = data.defaultCommands;
    orchestratorCatalogLoaded = true;
    installedProviders = (data.installed || []).map(entry => (typeof entry === 'string' ? { provider: entry, staffable: true } : entry));
    renderProviderToggles();
    wireProviderTriplet(
      elById('orchestratorLeaderProvider'),
      elById('orchestratorLeaderModel'),
      elById('orchestratorLeaderReasoning')
    );
    wireProviderTriplet(
      elById('orchestratorChangeLeaderProvider'),
      elById('orchestratorChangeLeaderModel'),
      elById('orchestratorChangeLeaderReasoning')
    );
    wireProviderTriplet(
      elById('orchestratorSubtaskProvider'),
      elById('orchestratorSubtaskModel'),
      elById('orchestratorSubtaskReasoning')
    );
    syncAgentModelCatalog();
  } catch (error) {
    // Catalog is a convenience for the dropdowns; leave them empty on failure.
  }
}

// Active by default: a finished orchestration leaves dozens of done runs
// behind, and scrolling past them to find the one that matters is the
// whole complaint. Nothing is deleted — the other tabs still show them.
let runsFilter = 'active';

function filterRunsForBoard(runs) {
  // "cycle" and "all" are decided server-side (see the runs= query param);
  // only "active" narrows further here.
  if (runsFilter !== 'active') return runs;
  const active = runs.filter(isRunActive);
  // Never show an empty board just because everything finished: fall back
  // to the newest few so there is always something to look at.
  return active.length ? active : runs.slice(0, 3);
}

function isRunActive(run) {
  return run.status === 'starting' || run.status === 'running' || run.status === 'waiting';
}

// Running agents first — they are the ones worth watching — then the most
// recently finished, so the newest result is never buried behind old runs.
function sortRunsForBoard(runs) {
  return runs.slice().sort((a, b) => {
    const activeDelta = (isRunActive(b) ? 1 : 0) - (isRunActive(a) ? 1 : 0);
    if (activeDelta) return activeDelta;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function sortNewestFirst(items) {
  return items.slice().sort((a, b) => {
    const createdDelta = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    return createdDelta || String(b.id || '').localeCompare(String(a.id || ''));
  });
}

function renderOrchestratorRun(run, agentsById) {
  const agent = agentsById[run.agentId];
  const agentName = agent ? agent.name : run.agentId;
  const modelLabel = [run.provider || (agent && agent.provider), run.model || (agent && agent.model)].filter(Boolean).join(' · ');
  // Effort is spelled out even when unset, so "provider default" is a
  // visible choice instead of a blank the reader has to interpret.
  const effort = run.reasoningEffort || (agent && agent.reasoningEffort) || '';
  const effortLabel = 'effort: ' + (effort || 'default');
  const progress = run.progressPercent != null ? run.progressPercent + '%' : '';
  const originTag = run.origin === 'adopted' ? '<span class="tag">adopted</span>' : '';
  const statusClass = run.status === 'failed' ? 'warn' : (run.status === 'done' ? 'ok' : '');
  const isActive = isRunActive(run);
  const cardClass = isActive ? 'is-running' : (run.status === 'failed' ? 'is-failed' : 'is-done');
  const logTail = run.logTail || '';
  // "s1: Build the parser" — the plan key and subtask title, so a strip of
  // cards says what each agent is working on without opening a log.
  const planLabel = [run.planKey, run.planTitle].filter(Boolean).join(': ');
  return '<div class="card run-card ' + cardClass + '" data-run-id="' + escapeHtml(run.id) + '">' +
    '<div class="toolbar" style="justify-content:space-between"><strong>' +
    (isActive ? '<span class="run-live-dot"></span>' : '') + escapeHtml(planLabel || agentName) +
    '</strong><span class="pill ' + statusClass + '">' + escapeHtml(run.status) + '</span></div>' +
    '<div class="meta">' + (planLabel ? escapeHtml(agentName) + ' · ' : '') +
    escapeHtml(run.phase || '') + (modelLabel ? ' · ' + escapeHtml(modelLabel) : '') +
    ' · <span class="tag' + (effort ? ' ok' : '') + '">' + escapeHtml(effortLabel) + '</span>' + (progress ? ' · ' + escapeHtml(progress) : '') +
    (originTag ? ' ' + originTag : '') + '</div>' +
    // A finished run's tail is not sent with the board any more (it never
    // changes, and re-sending every one of them dominated the payload).
    '<pre class="run-card-log" data-run-log="' + escapeHtml(run.id) + '">' +
    escapeHtml(logTail || (isActive ? 'Waiting for output…' : 'Finished — open Full log to read it.')) + '</pre>' +
    '<div class="toolbar">' +
    (isActive ? '<button class="ghost run-stop" data-run-id="' + escapeHtml(run.id) + '" type="button">Stop</button><button class="ghost run-set-model" data-run-id="' + escapeHtml(run.id) + '" type="button">Model…</button>' : '') +
    '<button class="ghost run-log" data-run-id="' + escapeHtml(run.id) + '" type="button">Full log</button>' +
    '</div></div>';
}

function renderOrchestratorSubtask(subtask) {
  return '<div class="card"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(subtask.title) + '</strong><span class="pill">' + escapeHtml(subtask.status) + '</span></div>' +
    (subtask.goal ? '<div class="meta">' + escapeHtml(subtask.goal) + '</div>' : '') +
    (subtask.statusReason ? '<div class="meta"><strong>Reason:</strong> ' + escapeHtml(subtask.statusReason) + '</div>' : '') + '</div>';
}

function renderOrchestratorReview(review) {
  const verdictClass = review.verdict === 'pass' ? 'ok' : (review.verdict === 'block' ? 'warn' : '');
  return '<div class="card"><div class="toolbar" style="justify-content:space-between"><span class="pill ' + verdictClass + '">' + escapeHtml(review.verdict) + '</span>' +
    (review.score != null ? '<span class="meta help help-inline" tabindex="0" data-tip="Reviewer score for this subtask (self-reported by the reviewer agent, usually out of 100). Informational only: the leader sees it when adjudicating and it goes into the final report, but nothing reruns or blocks on it — the verdict decides.">' + escapeHtml(String(review.score)) + '</span>' : '') + '</div>' +
    '<div class="meta">' + escapeHtml(review.summary) + '</div>' +
    '<div class="meta">' + (review.consumedAt ? 'consumed' : 'pending adjudication') + '</div></div>';
}

function renderOrchestratorEvent(event) {
  return '<div class="meta">' + escapeHtml(event.createdAt) + ' · ' + escapeHtml(event.kind) + ' (' + escapeHtml(event.phase) + ') — ' + escapeHtml(event.summary || '') + '</div>';
}

function renderAdoptableSession(event) {
  return '<div class="card"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(event.agent || 'unknown agent') + '</strong><span class="meta">' + escapeHtml(event.sessionId) + '</span></div>' +
    '<div class="meta">' + escapeHtml(event.summary || event.kind) + '</div>' +
    '<div class="toolbar" style="margin-top:6px"><button class="secondary session-adopt" data-session-id="' + escapeHtml(event.sessionId) + '" type="button">Adopt</button></div></div>';
}

function updateRunsCarousel() {
  const grid = elById('orchestratorRuns');
  const prev = elById('orchestratorRunsPrev');
  const next = elById('orchestratorRunsNext');
  if (!grid || !prev || !next) return;
  const maxScroll = grid.scrollWidth - grid.clientWidth;
  // Disabled arrows stay hidden even on hover, so a board that fits in one
  // page shows no chrome at all.
  prev.disabled = grid.scrollLeft <= 1;
  next.disabled = grid.scrollLeft >= maxScroll - 1;
}

function scrollRunsByPage(direction) {
  const grid = elById('orchestratorRuns');
  if (!grid) return;
  grid.scrollBy({ left: direction * grid.clientWidth, behavior: 'smooth' });
}

function renderRunsBoard(runs, agentsById) {
  const grid = elById('orchestratorRuns');
  if (!grid) return;
  // The board re-renders on every poll. Remember where the user had
  // scrolled the page strip and each log, so a refresh mid-read doesn't
  // yank them back to the start.
  const previousScrollLeft = grid.scrollLeft;
  const logScroll = {};
  qsa(grid, '[data-run-log]').forEach(pre => {
    logScroll[pre.dataset.runLog] = { top: pre.scrollTop, atBottom: pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24 };
  });

  grid.innerHTML = runs.length
    ? runs.map(run => renderOrchestratorRun(run, agentsById)).join('')
    : '<div class="muted">No runs yet.</div>';

  qsa(grid, '[data-run-log]').forEach(pre => {
    const remembered = logScroll[pre.dataset.runLog];
    // New cards and logs the user was already reading at the bottom follow
    // the live output; anything scrolled back stays put.
    pre.scrollTop = !remembered || remembered.atBottom ? pre.scrollHeight : remembered.top;
  });
  grid.scrollLeft = Math.min(previousScrollLeft, Math.max(0, grid.scrollWidth - grid.clientWidth));
  updateRunsCarousel();
}

function renderAdoptablePanel(sessions) {
  const el = elById('orchestratorAdoptable');
  if (!el) return;
  el.innerHTML = sessions.length ? sessions.map(renderAdoptableSession).join('') : '<div class="muted">No external sessions waiting to be adopted.</div>';
}

async function refreshOrchestratorBoard() {
  const summaryEl = elById('orchestratorSummary');
  if (!summaryEl) return;
  const taskId = currentOrchestratorTaskId();
  try {
    const data = await api('/api/workforce/board?task=' + encodeURIComponent(taskId) +
      (runsFilter === 'all' ? '&runs=all' : ''));
    renderOrchestratorPicker(data.orchestrations, data.orchestration && data.orchestration.taskId);
    if (!data.orchestration) {
      summaryEl.textContent = 'No orchestrations yet. Start one with the form on the left.';
      elById('orchestratorRuns').innerHTML = '';
      elById('orchestratorSubtasks').innerHTML = '';
      elById('orchestratorReviews').innerHTML = '';
      elById('orchestratorEvents').innerHTML = '';
      renderAdoptablePanel([]);
      return;
    }
    const orchestration = data.orchestration;
    // Keep every action button (Step/Pause/Stop/…) pointed at whatever is
    // actually on screen, not at a stale active task.
    selectedOrchestrationTaskId = orchestration.taskId;
    renderAutoRunState(Boolean(data.autoRun));
    renderAutonomySelect(orchestration.autonomy);
    renderPauseToggle(orchestration.status);
    renderLeaderQuestions(data.questions || []);
    renderOrchestrationLeader(orchestration, data.leaderAgent);
    renderSpawnApprovals(data.approvals || [], data.registeredAgents || []);
    const heading = data.taskTitle
      ? '<div><strong>' + escapeHtml(String(data.taskTitle).split('\n')[0].slice(0, 90)) + '</strong></div>'
      : '';
    const fellBack = data.fellBackFromTaskId
      ? '<div class="muted">Active task has no orchestration; showing the most recent one.</div>'
      : '';
    summaryEl.innerHTML = heading + fellBack +
      'status: <strong>' + escapeHtml(orchestration.status) + '</strong> · <span title="Rework rounds used. Only a rework decision advances this; accepted work costs nothing.">rework cycle ' +
      escapeHtml(String(orchestration.cycle)) + '/' + escapeHtml(String(orchestration.maxCycles)) + '</span>' +
      (orchestration.complexity ? ' · ' + escapeHtml(orchestration.complexity) : '') +

      (orchestration.lastError ? ' · <span class="error">' + escapeHtml(orchestration.lastError) + '</span>' : '') +
      // "reporting" is a dead end for Step — say so instead of letting the
      // user click it over and over.
      (orchestration.status === 'reporting'
        ? '<div class="muted">Work is done; Step cannot advance past this. Click <strong>Generate report</strong> to finish the orchestration.</div>'
        : '') +
      // The context folder is where a human goes to see what the agents
      // actually told each other: the plan and its revision log, who was
      // assigned what, and each task's report/review/adjudication rounds.
      (orchestration.planPath
        ? '<div class="muted" title="Plan, assignment log, and one folder per task holding its report, review, adjudication and summary. This is the context the agents read from each other.">Context: '
          + escapeHtml(orchestration.planPath.replace(/[\\/]plan\.md$/, '')) + '</div>'
        : '') +
      (orchestration.reportPath
        ? '<div class="muted">Report: ' + escapeHtml(orchestration.reportPath) + '</div>'
        : '');
    const agentsById = {};
    (data.registeredAgents || []).forEach(agent => { agentsById[agent.id] = agent; });
    const sentRuns = data.runs || [];
    syncRunCompletionToasts(sentRuns, agentsById);
    const shownRuns = filterRunsForBoard(sortRunsForBoard(sentRuns));
    // runsTotal counts every run on the task, including the ones the
    // server did not send for this scope.
    const totalRuns = data.runsTotal == null ? sentRuns.length : data.runsTotal;
    const countEl = elById('orchestratorRunsCount');
    if (countEl) countEl.textContent = shownRuns.length === totalRuns
      ? totalRuns + ' run(s)'
      : shownRuns.length + ' of ' + totalRuns;
    renderRunsBoard(shownRuns, agentsById);
    const subtasks = sortNewestFirst(data.subtasks || []);
    elById('orchestratorSubtasks').innerHTML = subtasks.length
      ? subtasks.map(renderOrchestratorSubtask).join('')
      : '<div class="muted">No subtasks yet.</div>';
    const reviews = sortNewestFirst(data.reviews || []);
    elById('orchestratorReviews').innerHTML = reviews.length
      ? reviews.map(renderOrchestratorReview).join('')
      : '<div class="muted">No reviews yet.</div>';
    const events = data.events || [];
    elById('orchestratorEvents').innerHTML = events.length
      ? events.map(renderOrchestratorEvent).join('')
      : '<div class="muted">No activity yet.</div>';
    renderAdoptablePanel(data.adoptable || []);
  } catch (error) {
    summaryEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  }
}

on('orchestratorStartForm', 'submit', async event => {
  event.preventDefault();
  const form = event.target;
  const statusEl = elById('orchestratorStartStatus');
  statusEl.textContent = 'Starting…';
  try {
    const body = {
      prompt: form.prompt.value,
      leaderProvider: form.leaderProvider.value,
      leaderModel: form.leaderModel.value || undefined,
      leaderReasoning: form.leaderReasoning.value || undefined,
      autonomy: form.autonomy.value,
      maxParallel: Number(form.maxParallel.value || 3),
      maxCycles: Number(form.maxCycles.value || 8),
      // 0 is a deliberate setting ("never stop to ask"), so an empty box
      // is the only thing that falls back to the server default.
      maxQuestionRounds: form.maxQuestionRounds.value === '' ? undefined : Number(form.maxQuestionRounds.value),
      // Always send the exact checked set. "All currently visible" is a
      // concrete team choice: omitting it prevented the backend from
      // provisioning those providers and made the leader fall back to the
      // first already-registered agent instead.
    };
    const data = await api('/api/workforce/orchestration/start', { method: 'POST', body: JSON.stringify(body) });
    statusEl.textContent = data.summary || 'Started.';
    // The board follows an explicit pick until the user changes it, so a
    // freshly started orchestration has to claim that pick — otherwise the
    // panel keeps showing whichever one was on screen before.
    selectedOrchestrationTaskId =
      (data.orchestration && data.orchestration.taskId) || (data.task && data.task.id) || null;
    await load(true);
    await refreshOrchestratorBoard();
  } catch (error) {
    statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  }
});

// Start Orchestration and Add Subtask & Spawn share one panel; the tab
// strip swaps which body is visible. Start is the default because it is
// the entry point — Add Subtask only makes sense once one exists.
function selectOrchestratorFormTab(name) {
  qsa(document, '[data-orch-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.orchTab === name);
  });
  qsa(document, '[data-orch-panel]').forEach(panel => {
    panel.hidden = panel.dataset.orchPanel !== name;
  });
}

qsa(document, '[data-orch-tab]').forEach(button => {
  onElement(button, 'click', () => selectOrchestratorFormTab(button.dataset.orchTab));
});

qsa(document, '[data-runs-filter]').forEach(button => {
  onElement(button, 'click', () => {
    runsFilter = button.dataset.runsFilter;
    qsa(document, '[data-runs-filter]').forEach(other => {
      other.classList.toggle('active', other.dataset.runsFilter === runsFilter);
    });
    refreshOrchestratorBoard();
  });
});

on('orchestratorRunsPrev', 'click', () => scrollRunsByPage(-1));
on('orchestratorRunsNext', 'click', () => scrollRunsByPage(1));
on('orchestratorRuns', 'scroll', updateRunsCarousel);
window.addEventListener('resize', updateRunsCarousel);

on('orchestratorPicker', 'change', async event => {
  selectedOrchestrationTaskId = event.target.value || null;
  await refreshOrchestratorBoard();
});

// Only the corner toast is clamped: it is a fixed-size popup, and an agent
// request whose title carries a log tail would otherwise cover the screen.
// Every panel keeps the full text — that is where you go to read it.
function clampText(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value;
}

function approvalPayload(approval) {
  // The agent the orchestrator picked and what it is for ride in the
  // payload. A malformed one just degrades to no preselection.
  try {
    return (approval.payload ? JSON.parse(approval.payload) : null) || {};
  } catch (error) {
    return {};
  }
}

// Rejecting a subtask assignment only blocks that subtask; rejecting a
// plan/adjudicate/review turn leaves nothing to continue with, so it pauses
// the whole orchestration. The button has to say which one this is.
function rejectEffect(approval) {
  return String(approvalPayload(approval).key || '').indexOf('implement:') === 0 ? 'skip' : 'pause';
}

// Mirrors isLeaderOnlyAgent in core: a row whose only capability is "lead"
// is orchestration plumbing, not staff. The Agents tab never receives these
// rows; the board does (run cards need their names), so anything here that
// offers agents to pick from has to skip them itself.
function isLeaderOnlyAgent(agent) {
  const capabilities = (agent && agent.capabilities || [])
    .map(capability => String(capability).trim().toLowerCase())
    .filter(Boolean);
  return capabilities.length === 1 && capabilities[0] === 'lead';
}

function describeAgentShort(agent) {
  return agent.name + ' · ' + agent.provider + (agent.model ? '/' + agent.model : '') +
    (agent.reasoningEffort ? ' (' + agent.reasoningEffort + ')' : '');
}

// The leader lives outside the Agents tab on purpose, so this line is the
// only place a human can see — or repair — who is leading the run.
function renderOrchestrationLeader(orchestration, leader) {
  const el = elById('orchestratorLeader');
  if (!el) return;
  const form = elById('orchestratorLeaderForm');
  if (leader) {
    el.innerHTML = 'leader: <strong>' + escapeHtml(describeAgentShort(leader)) + '</strong> ' +
      '<button type="button" class="ghost" id="orchestratorLeaderChangeButton" style="padding:2px 8px">Change leader</button>' +
      '<span class="help help-inline" tabindex="0" data-tip="The leader plans the work and adjudicates reviews. It is a dedicated row that never does implement/review work, which is why it is not listed in the Agents tab. Changing it takes effect on the next turn.">?</span>';
  } else {
    el.innerHTML = '<span class="error">Leader agent is missing (its row was deleted). ' +
      'Every step fails until you pick a new leader.</span> ' +
      '<button type="button" class="ghost" id="orchestratorLeaderChangeButton" style="padding:2px 8px">Pick a leader</button>';
    // Nothing else in this panel works until it is fixed, so open the form
    // instead of hiding the repair behind another click.
    if (form && form.hidden) form.hidden = false;
  }
  onElement(elById('orchestratorLeaderChangeButton'), 'click', () => {
    if (!form) return;
    form.hidden = !form.hidden;
  });
}

async function submitLeaderChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = elById('orchestratorLeaderStatus');
  const taskId = currentOrchestratorTaskId();
  if (!taskId) return;
  if (status) status.textContent = 'Changing leader…';
  try {
    const result = await api('/api/workforce/orchestration/leader', {
      method: 'POST',
      body: JSON.stringify({
        taskId,
        leaderProvider: form.leaderProvider.value,
        leaderModel: form.leaderModel.value || undefined,
        leaderReasoning: form.leaderReasoning.value || undefined
      })
    });
    if (status) {
      status.textContent = result.changed
        ? 'Leader is now ' + describeAgentShort(result.leader) + '. Click Step (or Auto-run) to continue.'
        : 'That is already the leader.';
    }
    form.hidden = true;
    refreshOrchestratorBoard();
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

onElement(elById('orchestratorLeaderForm'), 'submit', submitLeaderChange);
on('orchestratorLeaderCancel', 'click', () => {
  const form = elById('orchestratorLeaderForm');
  if (form) form.hidden = true;
});

function renderSpawnApprovals(approvals, agents) {
  const panel = elById('orchestratorApprovals');
  const list = elById('orchestratorApprovalList');
  if (!panel || !list) return;
  panel.hidden = !approvals.length;
  if (!approvals.length) {
    list.innerHTML = '';
    delete list.dataset.signature;
    return;
  }
  // The board polls every few seconds. Re-rendering unconditionally would
  // reset a dropdown the user is in the middle of changing, so only redraw
  // when the set of pending approvals actually changes.
  const signature = approvals.map(approval => approval.id).join('|');
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const usable = (agents || []).filter(agent => agent.enabled !== false);
  list.innerHTML = approvals.map(approval => {
    const payload = approvalPayload(approval);
    const intended = payload.agentId || '';
    const effect = rejectEffect(approval);
    // Leader rows are not staff and must not be offered as an override —
    // except when this approval IS the leader's own turn, where dropping it
    // from the list would silently hand the turn to someone else.
    const options = usable.filter(agent =>
      isLeaderOnlyAgent(agent) ? agent.id === intended : true
    ).map(agent =>
      '<option value="' + escapeHtml(agent.id) + '"' + (agent.id === intended ? ' selected' : '') + '>' +
      escapeHtml(agent.name + ' · ' + agent.provider + (agent.model ? '/' + agent.model : '')) +
      '</option>'
    ).join('');
    const waited = approval.createdAt
      ? '<div class="muted">asked at ' + escapeHtml(new Date(approval.createdAt).toLocaleTimeString()) + '</div>'
      : '';
    // Approving is not only yes/no: the dropdown is the third answer —
    // "yes, but this agent does it" — and it is what actually gets spawned.
    const picker = options
      ? '<label style="display:flex; align-items:center; gap:6px; margin:0">Agent ' +
        '<select class="approve-agent" data-request-id="' + escapeHtml(approval.id) + '" ' +
        'data-intended="' + escapeHtml(intended) + '">' + options + '</select></label>'
      : '';
    return '<div class="card" style="display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap">' +
      '<span style="min-width:0">' + escapeHtml(approval.title) + waited + '</span>' +
      '<span class="toolbar" style="flex:0 0 auto">' + picker +
      // An instruction typed here rides along with the yes and is replayed to
      // the leader's own turns, so "go ahead, but stop after this" is honoured
      // instead of being lost the moment the approval is recorded.
      '<input type="text" class="approve-note" data-request-id="' + escapeHtml(approval.id) + '" ' +
      'placeholder="Instruction for the leader (optional)" style="min-width:220px">' +
      '<button type="button" class="secondary approve-spawn" data-request-id="' + escapeHtml(approval.id) + '">Approve</button>' +
      '<button type="button" class="ghost reject-spawn" data-request-id="' + escapeHtml(approval.id) + '" ' +
      'data-reject-effect="' + effect + '" title="' +
      (effect === 'skip'
        ? 'Blocks just this subtask; the rest of the run continues.'
        : 'Nothing can continue past this turn, so the orchestration pauses.') +
      '" style="color:var(--red)">Reject</button>' +
      '</span></div>';
  }).join('');
}

on('orchestratorApprovalList', 'click', async event => {
  const button = closestFrom(event.target, '.approve-spawn, .reject-spawn');
  if (!button) return;
  const taskId = currentOrchestratorTaskId();
  const statusEl = elById('orchestratorApprovalStatus');
  if (!taskId) return;
  const approve = button.classList.contains('approve-spawn');
  if (!approve && !confirm('Reject this agent call?\n\n' + (button.dataset.rejectEffect === 'skip'
    ? 'Only this subtask is dropped (marked blocked); the rest of the run keeps going, and the leader can re-plan around it.'
    : 'Nothing can continue past this turn, so the orchestration pauses until you resume it.'))) return;
  const requestId = button.dataset.requestId;
  const picker = qs(document, '.approve-agent[data-request-id="' + requestId + '"]');
  // Only sent when the user actually changed it: an unchanged dropdown is a
  // plain "yes", and recording it as a reassignment would be misleading.
  const agentId = approve && picker && picker.value && picker.value !== picker.dataset.intended
    ? picker.value
    : undefined;
  const noteEl = qs(document, '.approve-note[data-request-id="' + requestId + '"]');
  const note = approve && noteEl && noteEl.value.trim() ? noteEl.value.trim() : undefined;
  button.disabled = true;
  statusEl.textContent = approve ? (agentId ? 'Approving with a different agent…' : 'Approving…') : 'Rejecting…';
  try {
    const result = await api('/api/workforce/orchestration/approve-spawn', {
      method: 'POST',
      body: JSON.stringify({ taskId, requestId, approve, agentId, note })
    });
    statusEl.textContent = result.summary || '';
  } catch (error) {
    statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
    button.disabled = false;
    return;
  }
  await refreshOrchestratorBoard();
});

function renderLeaderQuestions(questions) {
  const panel = elById('orchestratorQuestions');
  const list = elById('orchestratorQuestionList');
  if (!panel || !list) return;
  if (!questions.length) {
    panel.hidden = true;
    list.innerHTML = '';
    delete list.dataset.signature;
    return;
  }
  panel.hidden = false;

  // The board polls every 3s. Replacing innerHTML then rips the focused
  // textarea out of the DOM mid-sentence — the caret jumps and keystrokes
  // land nowhere. The question set almost never changes between polls, so
  // only rebuild when it actually did, and never while the user is typing
  // or tabbing inside the panel.
  const signature = questions.map(question => question.id).join('|');
  if (list.dataset.signature === signature) return;
  if (list.contains(document.activeElement)) return;

  list.dataset.signature = signature;
  list.innerHTML = questions.map(renderLeaderQuestion).join('');
  syncQuestionOtherFields();
}

function questionOptions(question) {
  // Options ride in the request payload; a malformed one just degrades to
  // a free-text answer rather than breaking the panel.
  try {
    const parsed = question.payload ? JSON.parse(question.payload) : null;
    return Array.isArray(parsed && parsed.options) ? parsed.options.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function renderLeaderQuestion(question) {
  const id = escapeHtml(question.id);
  const options = questionOptions(question);
  if (!options.length) {
    return '<label>' + escapeHtml(question.title) +
      '<textarea rows="2" data-question-id="' + id + '"></textarea></label>';
  }
  // Pick-one, with a final "Something else" that reveals the free-text box —
  // the leader's options should cover it, but must not be a cage.
  const choice = (value, label, checked) =>
    '<label class="question-option">' +
    '<input type="radio" name="q-' + id + '" data-option-for="' + id + '" value="' + escapeHtml(value) + '"' +
    (checked ? ' checked' : '') + '>' +
    '<span>' + escapeHtml(label) + '</span></label>';
  return '<div class="question-card"><div class="question-title">' + escapeHtml(question.title) + '</div>' +
    '<div class="question-options">' +
    options.map((option, index) => choice(option, option, index === 0)).join('') +
    choice('', 'Something else…', false) +
    '</div>' +
    '<textarea rows="2" data-question-id="' + id + '" data-needs-other="1" placeholder="Your own answer" hidden></textarea></div>';
}

// A radio answer wins unless "Something else…" is selected, in which case
// the free-text box becomes the answer.
function syncQuestionOtherFields() {
  qsa(document, '#orchestratorQuestionList [data-needs-other]').forEach(field => {
    const id = field.dataset.questionId;
    const selected = qs(document, '[data-option-for="' + CSS.escape(id) + '"]:checked');
    field.hidden = Boolean(selected && selected.value);
  });
}

on('orchestratorQuestionList', 'change', event => {
  if (event.target && datasetOf(event.target) && datasetOf(event.target).optionFor) syncQuestionOtherFields();
});

async function submitLeaderAnswers(dismiss) {
  const taskId = currentOrchestratorTaskId();
  const statusEl = elById('orchestratorQuestionStatus');
  if (!taskId) return;
  const answers = [];
  const answered = new Set();
  qsa(document, '#orchestratorQuestionList [data-option-for]:checked').forEach(radio => {
    if (!radio.value) return; // "Something else…" defers to the textarea below
    answers.push({ id: radio.dataset.optionFor, answer: radio.value });
    answered.add(radio.dataset.optionFor);
  });
  qsa(document, '#orchestratorQuestionList [data-question-id]').forEach(field => {
    if (answered.has(field.dataset.questionId)) return;
    if (field.value.trim()) answers.push({ id: field.dataset.questionId, answer: field.value.trim() });
  });
  statusEl.textContent = dismiss ? 'Skipping…' : 'Sending answers…';
  try {
    const result = await api('/api/workforce/orchestration/answer-questions', {
      method: 'POST',
      body: JSON.stringify({ taskId, answers, dismiss })
    });
    statusEl.textContent = (result.answered ? 'Sent ' + result.answered + ' answer(s). ' : '') +
      (result.spawnedRunIds && result.spawnedRunIds.length
        ? 'Leader is re-planning now.'
        : (result.summary || ''));
  } catch (error) {
    statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
    return;
  }
  await refreshOrchestratorBoard();
}

on('orchestratorAnswerButton', 'click', () => submitLeaderAnswers(false));
on('orchestratorDismissQuestionsButton', 'click', () => {
  if (!confirm('Skip these questions?\n\nThe leader will plan using its own assumptions instead.')) return;
  submitLeaderAnswers(true);
});

// Auto-run used to be its own button, which meant two controls for one
// decision: Autonomy already says whether the server should keep stepping
// (auto and approve-each) or the user drives (manual). This is now a
// read-out of what the server is actually doing, so a loop that stopped
// itself — an approval nobody answered — is visible instead of silent.
function renderAutoRunState(active) {
  const label = elById('orchestratorAutoRunState');
  if (!label) return;
  label.textContent = active ? 'auto-run: on' : 'auto-run: off';
  label.title = active
    ? 'The server is stepping this orchestration on its own.'
    : 'Nothing is stepping this orchestration; use Step, or set Autonomy to auto/approve-each.';
  label.style.color = active ? 'var(--accent)' : '';
}

// The board polls every few seconds; writing the value back while the user
// has the select open would yank their choice away mid-pick.
function renderAutonomySelect(autonomy) {
  const select = elById('orchestratorAutonomy');
  if (!select || document.activeElement === select) return;
  select.value = autonomy || 'manual';
}

on('orchestratorAutonomy', 'change', async event => {
  const taskId = currentOrchestratorTaskId();
  if (!taskId) return;
  const select = event.target;
  select.disabled = true;
  try {
    await api('/api/workforce/orchestration/autonomy', {
      method: 'POST',
      body: JSON.stringify({ taskId, autonomy: select.value })
    });
  } catch (error) {
    alert(error.message);
  } finally {
    select.disabled = false;
  }
  await refreshOrchestratorBoard();
});

on('orchestratorStepButton', 'click', async () => {
  const taskId = currentOrchestratorTaskId();
  if (!taskId) return;
  try {
    await api('/api/workforce/orchestration/step', { method: 'POST', body: JSON.stringify({ taskId }) });
  } catch (error) {
    alert(error.message);
  }
  await refreshOrchestratorBoard();
});

// One button, two directions: which one it is follows the orchestration's
// own status rather than a local flag, so it stays right after a reload or
// when something else (a rejected approval, a failed step) pauses the run.
function renderPauseToggle(status) {
  const button = elById('orchestratorPauseToggle');
  if (!button) return;
  const paused = status === 'paused';
  button.textContent = paused ? 'Resume' : 'Pause';
  button.dataset.paused = paused ? '1' : '';
  button.disabled = status === 'done' || status === 'failed';
}

on('orchestratorPauseToggle', 'click', async () => {
  const taskId = currentOrchestratorTaskId();
  if (!taskId) return;
  const button = elById('orchestratorPauseToggle');
  const path = button.dataset.paused === '1' ? 'resume' : 'pause';
  try {
    await api('/api/workforce/orchestration/' + path, { method: 'POST', body: JSON.stringify({ taskId }) });
  } catch (error) {
    alert(error.message);
  }
  await refreshOrchestratorBoard();
});

on('orchestratorStopButton', 'click', async () => {
  const taskId = currentOrchestratorTaskId();
  if (!taskId) return;
  if (!confirm('Stop the orchestration and every active run?')) return;
  await api('/api/workforce/orchestration/stop', { method: 'POST', body: JSON.stringify({ taskId }) });
  await refreshOrchestratorBoard();
});

on('orchestratorReportButton', 'click', async (event) => {
  const taskId = currentOrchestratorTaskId();
  if (!taskId) return;
  // An orchestration parks in "reporting" until this runs — Step
  // deliberately no-ops there, so without this button it never closes out.
  // The reporter is a spawned agent turn, so the first click starts it and
  // a later click turns its output into the final report.
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Generating...';
  try {
    const result = await api('/api/workforce/orchestration/report', { method: 'POST', body: JSON.stringify({ taskId }) });
    if (result.status === 'written') {
      alert('Report written (' + result.source + '):\n' + result.reportPath + (result.note ? '\n\n' + result.note : ''));
    } else {
      alert(result.message);
    }
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
  await refreshOrchestratorBoard();
});

on('orchestratorRequestChangesButton', 'click', () => {
  const form = elById('orchestratorChangeForm');
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) form.request.focus();
});

on('orchestratorChangeCancel', 'click', () => {
  const form = elById('orchestratorChangeForm');
  if (!form) return;
  form.hidden = true;
  form.request.value = '';
  elById('orchestratorChangeStatus').textContent = '';
});

on('orchestratorChangeForm', 'submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const statusEl = elById('orchestratorChangeStatus');
  const taskId = currentOrchestratorTaskId();
  if (!taskId) {
    statusEl.innerHTML = '<span class="error">No orchestration selected.</span>';
    return;
  }
  const request = form.request.value.trim();
  if (!request) {
    statusEl.innerHTML = '<span class="error">Describe what should change.</span>';
    return;
  }
  statusEl.textContent = 'Reopening…';
  try {
    // Reopens the same orchestration at "planning" with the previous plan,
    // reviews and report as context, so the change lands on the existing
    // work instead of starting a second task from scratch.
    const result = await api('/api/workforce/orchestration/request-changes', {
      method: 'POST',
      body: JSON.stringify({ taskId, request })
    });
    const stopped = (result.stoppedRuns || []).length;
    const spawned = (result.spawnedRunIds || []).length;
    statusEl.textContent = 'Reopened' + (stopped ? ', stopped ' + stopped + ' active run(s)' : '') + '. ' +
      (spawned ? 'Leader is re-planning now — watch the Runs board.' : (result.summary || 'Click Step to advance.'));
    form.request.value = '';
    form.hidden = true;
  } catch (error) {
    statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
    return;
  }
  await refreshOrchestratorBoard();
});

on('orchestratorRemoveButton', 'click', async () => {
  const taskId = currentOrchestratorTaskId();
  if (!taskId) return;
  // Spell out the blast radius: this deletes the owning task too, so it
  // also disappears from Work Board, and it cannot be undone.
  const shown = elById('orchestratorPicker');
  const label = shown && shown.selectedOptions[0] ? shown.selectedOptions[0].textContent : taskId;
  if (!confirm('Remove this orchestration AND its task?\n\n' + label +
    '\n\nThis also deletes its runs, subtasks, reviews, assignments and activity, and removes the task from Work Board. This cannot be undone.')) return;
  try {
    await api('/api/task/delete', { method: 'POST', body: JSON.stringify({ taskId }) });
  } catch (error) {
    alert(error.message);
    return;
  }
  // The selection pointed at a task that no longer exists; fall back to
  // the server's default pick rather than re-requesting a dead id.
  selectedOrchestrationTaskId = null;
  await load(true);
  await refreshOrchestratorBoard();
});

on('orchestratorSubtaskForm', 'submit', async event => {
  event.preventDefault();
  const form = event.target;
  const statusEl = elById('orchestratorSubtaskStatus');
  const taskId = currentOrchestratorTaskId();
  if (!taskId) {
    statusEl.innerHTML = '<span class="error">No active task.</span>';
    return;
  }
  statusEl.textContent = 'Adding…';
  try {
    const body = {
      taskId,
      title: form.title.value,
      goal: form.goal.value || undefined,
      criteria: form.criteria.value || undefined,
      provider: form.provider.value,
      model: form.model.value || undefined,
      reasoningEffort: form.reasoningEffort.value || undefined
    };
    await api('/api/workforce/subtask/add-and-spawn', { method: 'POST', body: JSON.stringify(body) });
    statusEl.textContent = 'Spawned.';
    form.reset();
    await refreshOrchestratorBoard();
  } catch (error) {
    statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  }
});

on('orchestratorRuns', 'click', async event => {
  const stopButton = closestFrom(event.target, '.run-stop');
  const logButton = closestFrom(event.target, '.run-log');
  const modelButton = closestFrom(event.target, '.run-set-model');
  try {
    if (stopButton) {
      if (!confirm('Stop this run?')) return;
      await api('/api/workforce/run/stop', { method: 'POST', body: JSON.stringify({ runId: stopButton.dataset.runId }) });
      await refreshOrchestratorBoard();
    } else if (logButton) {
      const data = await api('/api/workforce/run/log?run=' + encodeURIComponent(logButton.dataset.runId) + '&tail=200');
      alert(data.log || '(no output captured yet)');
    } else if (modelButton) {
      const model = prompt('New model:');
      if (!model) return;
      const reasoningEffort = prompt('New reasoning effort (optional):') || undefined;
      await api('/api/workforce/run/set-model', { method: 'POST', body: JSON.stringify({ runId: modelButton.dataset.runId, model, reasoningEffort }) });
      await refreshOrchestratorBoard();
    }
  } catch (error) {
    alert(error.message);
  }
});

on('orchestratorAdoptable', 'click', async event => {
  const adoptButton = closestFrom(event.target, '.session-adopt');
  if (!adoptButton) return;
  const role = prompt('Role for this agent (e.g. implementer, reviewer):', 'implementer');
  if (!role) return;
  try {
    await api('/api/workforce/run/adopt', { method: 'POST', body: JSON.stringify({ sessionId: adoptButton.dataset.sessionId, role }) });
    await refreshOrchestratorBoard();
  } catch (error) {
    alert(error.message);
  }
});

loadOrchestratorCatalog();
setInterval(() => {
  const view = elById('view-orchestrator');
  if (live && view && view.classList.contains('active')) refreshOrchestratorBoard();
}, 3000);

on('searchButton', 'click', async () => {
  const q = elById('searchQuery').value;
  const data = await api('/api/memory/search?q=' + encodeURIComponent(q));
  els.searchResults.innerHTML = data.results.length ? data.results.map(renderMemory).join('') : '<div class="muted">No matches.</div>';
});

on('refreshButton', 'click', () => load(true));
on('installClaudeHookButton', 'click', async event => {
  const confirmed = confirm('Install Claude Code hooks for this project? Restart Claude Code after installing.');
  if (!confirmed) return;
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = 'Installing...';
  try {
    await api('/api/claude/install-hooks', { method: 'POST', body: '{}' });
    await load(true);
  } catch (error) {
    els.refreshPill.textContent = 'Claude hook install failed: ' + error.message;
    els.refreshPill.className = 'pill warn';
  } finally {
    event.currentTarget.disabled = false;
    event.currentTarget.textContent = 'Install Claude Hook';
  }
});
on('installAntigravityHookButton', 'click', async event => {
  const confirmed = confirm('Install Antigravity (agy) hooks for this project? Start a new agy session after installing.');
  if (!confirmed) return;
  const label = event.currentTarget.textContent;
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = 'Installing...';
  try {
    await api('/api/antigravity/install-hooks', { method: 'POST', body: '{}' });
    await load(true);
  } catch (error) {
    els.refreshPill.textContent = 'Antigravity hook install failed: ' + error.message;
    els.refreshPill.className = 'pill warn';
  } finally {
    event.currentTarget.disabled = false;
    event.currentTarget.textContent = label;
  }
});
onElement(els.watcherToggleButton, 'click', async event => {
  const running = event.currentTarget.dataset.running === '1';
  event.currentTarget.disabled = true;
  els.watcherStatus.textContent = running ? 'Stopping...' : 'Starting...';
  try {
    await api(running ? '/api/watch/stop' : '/api/watch/start', { method: 'POST', body: '{}' });
    els.watcherStatus.textContent = '';
    await load(true);
  } catch (error) {
    els.watcherStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  } finally {
    event.currentTarget.disabled = false;
  }
});
on('toggleLiveButton', 'click', event => {
  live = !live;
  event.currentTarget.textContent = live ? 'Pause Live' : 'Resume Live';
  els.refreshPill.textContent = live ? 'Live refresh: on' : 'Live refresh: paused';
  els.refreshPill.className = live ? 'pill ok' : 'pill';
});

document.addEventListener('click', async event => {
  const editRepoMemoryButton = closestFrom(event.target, '.edit-repo-memory');
  if (editRepoMemoryButton) {
    openRepoMemoryEditor((lastState?.repoMemories || []).find(memory => memory.id === editRepoMemoryButton.dataset.memoryId));
    return;
  }
  const deleteRepoMemoryButton = closestFrom(event.target, '.delete-repo-memory');
  if (deleteRepoMemoryButton) {
    const memory = (lastState?.repoMemories || []).find(item => item.id === deleteRepoMemoryButton.dataset.memoryId);
    if (!memory || !confirm('Delete this repository memory?\n\n' + memory.content)) return;
    deleteRepoMemoryButton.disabled = true;
    try {
      await api('/api/repo-memory/delete', { method: 'POST', body: JSON.stringify({ id: memory.id }) });
      if (els.repoMemoryEditId.value === memory.id) closeRepoMemoryEditor();
      await load(true);
    } finally {
      deleteRepoMemoryButton.disabled = false;
    }
    return;
  }
  const candidateButton = closestFrom(event.target, '.review-candidate');
  if (candidateButton) {
    candidateButton.disabled = true;
    try {
      await api('/api/repo-memory/candidates/' + encodeURIComponent(candidateButton.dataset.candidateId || '') + '/review', {
        method: 'POST', body: JSON.stringify({ action: candidateButton.dataset.action })
      });
      await load(true);
    } finally {
      candidateButton.disabled = false;
    }
    return;
  }
  const laneTaskButton = closestFrom(event.target, '.lane-task-card');
  if (laneTaskButton) {
    selectedLiveTaskId = laneTaskButton.dataset.taskId || '';
    if (lastState) renderState(lastState);
    if (selectedLiveTaskId) {
      els.laneTaskId.value = selectedLiveTaskId;
    }
    els.laneTaskId?.scrollIntoView({ block: 'center' });
    if (els.laneTaskId) els.laneTaskId.focus();
    return;
  }
  const stopTaskCardButton = closestFrom(event.target, '.stop-task-card');
  if (stopTaskCardButton) {
    const taskId = stopTaskCardButton.dataset.taskId || '';
    if (!taskId) return;
    stopTaskCardButton.disabled = true;
    try {
      await api('/api/task/stop', { method: 'POST', body: JSON.stringify({ taskId, reason: 'Stop requested from work board.' }) });
      selectedLiveTaskId = taskId;
      await load(true);
    } finally {
      stopTaskCardButton.disabled = false;
    }
    return;
  }
  const editButton = closestFrom(event.target, '.edit-task');
  if (editButton) {
    const task = lastTasks.find(item => item.id === editButton.dataset.taskId);
    fillTaskEditor(task);
    return;
  }

  const deleteButton = closestFrom(event.target, '.delete-task');
  if (deleteButton) {
    const task = lastTasks.find(item => item.id === deleteButton.dataset.taskId);
    if (!task) return;
    const confirmed = confirm('Delete task "' + task.title + '" and its task-scoped memory, handoff, decision, and run records?');
    if (!confirmed) return;
    deleteButton.disabled = true;
    deleteButton.textContent = 'Deleting...';
    try {
      await api('/api/task/delete', { method: 'POST', body: JSON.stringify({ taskId: task.id }) });
      taskEditTouched = false;
      await load(true);
    } catch (error) {
      els.refreshPill.textContent = 'Delete failed: ' + error.message;
      els.refreshPill.className = 'pill warn';
      deleteButton.disabled = false;
      deleteButton.textContent = 'Delete';
    }
    return;
  }

  const button = closestFrom(event.target, '.install-tool');
  if (!button) return;
  const tool = button.dataset.tool;
  if (!tool) return;
  const confirmed = confirm('Install ' + tool + ' globally with npm? This may download packages from npm.');
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = 'Installing...';
  try {
    await api('/api/tools/install', { method: 'POST', body: JSON.stringify({ name: tool }) });
    await load(true);
  } catch (error) {
    els.refreshPill.textContent = 'Install failed: ' + error.message;
    els.refreshPill.className = 'pill warn';
    button.disabled = false;
    button.textContent = 'Install';
  }
});

on('graphBuildButton', 'click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  els.graphBuildStatus.textContent = 'Scanning repo...';
  try {
    const data = await api('/api/graph/build', {
      method: 'POST',
      body: JSON.stringify({
        includePaths: els.graphIncludePaths.value,
        ignorePaths: els.graphIgnorePaths.value
      })
    });
    const s = data.stats || {};
    els.graphBuildStatus.textContent = 'Built: ' + (s.files || 0) + ' files, ' + (s.symbols || 0) + ' symbols, ' + (s.internalEdges || 0) + ' internal imports.';
    await loadGraph();
    await load(true);
  } catch (error) {
    els.graphBuildStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  } finally {
    button.disabled = false;
  }
});

on('briefAutoAllButton', 'click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  els.graphBuildStatus.textContent = 'Refreshing all briefs…';
  try {
    const data = await api('/api/graph/brief-auto-all', { method: 'POST', body: '{}' });
    els.graphBuildStatus.textContent = data.refreshed
      ? 'Refreshed ' + data.refreshed + ' briefs.'
      : (data.message || 'No briefs to refresh.');
    await loadGraph();
    await load(true);
  } catch (error) {
    els.graphBuildStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  } finally {
    button.disabled = false;
  }
});

onElement(els.injectRepoMap, 'change', () => { graphSettingsTouched = true; });
onElement(els.autoBriefOnToolUse, 'change', () => { graphSettingsTouched = true; });
onElement(els.watchAutoBrief, 'change', () => { graphSettingsTouched = true; });
onElement(els.repoMapLimit, 'input', () => { graphSettingsTouched = true; });
onElement(els.graphIncludePaths, 'input', () => { graphSettingsTouched = true; });
onElement(els.graphIgnorePaths, 'input', () => { graphSettingsTouched = true; });

on('graphSettingsForm', 'submit', async event => {
  event.preventDefault();
  els.graphSettingsStatus.textContent = 'Saving...';
  try {
    await api('/api/config/graph', {
      method: 'POST',
      body: JSON.stringify({
        injectRepoMap: els.injectRepoMap.checked,
        autoBriefOnToolUse: els.autoBriefOnToolUse.checked,
        watchAutoBrief: els.watchAutoBrief.checked,
        repoMapLimit: Number(els.repoMapLimit.value) || 30,
        includePaths: els.graphIncludePaths.value,
        ignorePaths: els.graphIgnorePaths.value
      })
    });
    graphSettingsTouched = false;
    els.graphSettingsStatus.textContent = 'Saved.';
    await load(true);
  } catch (error) {
    els.graphSettingsStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  }
});

on('graphBriefForm', 'submit', async event => {
  event.preventDefault();
  els.graphBriefStatus.textContent = 'Saving...';
  try {
    await api('/api/graph/brief', {
      method: 'POST',
      body: JSON.stringify({
        path: els.graphBriefPath.value,
        summary: els.graphBriefSummary.value,
        manualPriority: els.graphBriefPriority.value || undefined,
        ranges: els.graphBriefRanges.value,
        taskEdited: els.graphBriefTaskEdited.checked
      })
    });
    els.graphBriefStatus.textContent = 'Saved.';
    await loadGraph();
    await load(true);
  } catch (error) {
    els.graphBriefStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  }
});

on('graphReloadButton', 'click', () => loadGraph());

async function loadGraph() {
  const focus = encodeURIComponent(elById('graphFocus').value || '');
  const limit = Number(elById('graphLimit').value) || 120;
  try {
    const data = await api('/api/graph?limit=' + limit + '&focus=' + focus);
    graphLoaded = true;
    els.repoMap.textContent = data.repoMap || 'No graph yet. Click Build.';
    renderGraph(data.nodes || [], data.edges || []);
  } catch (error) {
    els.graphCanvas.innerHTML = '<div class="error" style="padding:20px">' + escapeHtml(error.message) + '</div>';
  }
}

function fillGraphBrief(node) {
  if (!node) return;
  selectedGraphPath = node.path;
  els.graphBriefPath.value = node.path;
  els.graphBriefPriority.value = node.manualPriority ? String(node.manualPriority) : '';
  els.graphBriefSummary.value = node.brief || '';
  els.graphBriefTaskEdited.checked = node.recentKind === 'edit';
  els.graphBriefStatus.textContent = 'Selected ' + node.path;
}

// Lightweight force-directed layout rendered to SVG (no external libraries).
function renderGraph(rawNodes, rawEdges) {
  if (graphAnim) { cancelAnimationFrame(graphAnim); graphAnim = null; }
  if (!rawNodes.length) {
    els.graphCanvas.innerHTML = '<div class="muted" style="padding:20px">No files in graph. Build it first.</div>';
    els.graphHint.textContent = '';
    return;
  }
  const W = 1000, H = 600;
  const byId: Record<string, any> = {};
  const nodes = rawNodes.map((n, i) => {
    const angle = (i / rawNodes.length) * Math.PI * 2;
    const node = {
      id: n.id, path: n.path, language: n.language, symbols: n.symbols, usedBy: n.usedBy, imports: n.imports,
      brief: n.brief, manualPriority: n.manualPriority, briefStale: n.briefStale,
      recentKind: n.recentKind, recentRank: n.recentRank, recentTotal: n.recentTotal,
      x: W / 2 + Math.cos(angle) * 220 + (i % 7) * 4,
      y: H / 2 + Math.sin(angle) * 180 + (i % 5) * 4,
      vx: 0, vy: 0, fixed: false
    };
    byId[n.id] = node;
    return node;
  });
  const edges = rawEdges.map(e => ({ s: byId[e.source], t: byId[e.target] })).filter(e => e.s && e.t);

  const maxDegree = Math.max(1, ...nodes.map(n => n.usedBy + n.imports));
  const radius = n => 5 + Math.round(16 * Math.sqrt((n.usedBy + n.imports) / maxDegree));
  const recentStrength = n => n.recentRank ? 1 - ((n.recentRank - 1) / Math.max(1, (n.recentTotal || 1) - 1)) : 0;
  const color = n => {
    const strength = recentStrength(n);
    if (n.recentKind === 'edit') {
      const r = 255, g = Math.round(92 - strength * 70), b = Math.round(138 - strength * 92);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }
    if (n.recentKind === 'read') {
      const r = Math.round(56 - strength * 30), g = Math.round(189 + strength * 52), b = 248;
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }
    const ratio = (n.usedBy + n.imports) / maxDegree;
    const v = Math.round(62 + ratio * 58);
    return 'rgb(' + v + ',' + (v + 8) + ',' + (v + 18) + ')';
  };
  const glow = n => {
    if (n.recentKind === 'edit') return '#ff2e63';
    if (n.recentKind === 'read') return '#22d3ee';
    return '#0b1220';
  };
  const label = n => n.path.split('/').pop();
  const showLabel = n => n.usedBy >= 2 || n.imports >= 4 || nodes.length <= 40;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#475569"/></marker></defs>';
  const viewportGroup = document.createElementNS(svgNs, 'g');
  const edgeGroup = document.createElementNS(svgNs, 'g');
  const nodeGroup = document.createElementNS(svgNs, 'g');
  viewportGroup.appendChild(edgeGroup);
  viewportGroup.appendChild(nodeGroup);
  svg.appendChild(viewportGroup);

  const edgeEls = edges.map(e => {
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('class', 'edge');
    line.setAttribute('marker-end', 'url(#arrow)');
    edgeGroup.appendChild(line);
    return line;
  });
  const nodeEls = nodes.map(n => {
    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('class', 'node');
    circle.setAttribute('r', String(radius(n)));
    circle.setAttribute('fill', color(n));
    circle.setAttribute('fill-opacity', n.recentKind ? '1' : '0.55');
    circle.dataset.id = n.id;
    nodeGroup.appendChild(circle);
    let text = null;
    if (showLabel(n)) {
      text = document.createElementNS(svgNs, 'text');
      text.textContent = label(n);
      nodeGroup.appendChild(text);
    }
    return { node: n, circle, text };
  });

  function updateNodeStyles() {
    for (const item of nodeEls) {
      const selected = item.node.path === selectedGraphPath;
      item.circle.setAttribute('stroke', selected ? '#f8fafc' : (item.node.briefStale ? '#f59e0b' : glow(item.node)));
      item.circle.setAttribute('stroke-width', selected ? '4' : (item.node.recentKind ? '3.5' : (item.node.brief ? '2' : '1.25')));
    }
  }
  updateNodeStyles();

  els.graphCanvas.innerHTML = '';
  els.graphCanvas.appendChild(svg);
  let tooltip = qs(els.graphCanvas, '.graph-tooltip');
  if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'graph-tooltip'; els.graphCanvas.appendChild(tooltip); }
  els.graphHint.innerHTML = 'Showing ' + nodes.length + ' files and ' + edges.length + ' import edges. ' +
    '<span style="color:#ff2e63;font-weight:750">edit recent</span> · ' +
    '<span style="color:#22d3ee;font-weight:750">read recent</span> · gray = older. ' +
    'Click a node to load its brief; drag nodes to rearrange; wheel to zoom.';

  const view = { x: 0, y: 0, k: 1 };
  const minZoom = 0.35, maxZoom = 5;
  function clampZoom(value) {
    return Math.max(minZoom, Math.min(maxZoom, value));
  }
  function applyView() {
    viewportGroup.setAttribute('transform', 'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')');
  }
  function svgPoint(evt) {
    const rect = svg.getBoundingClientRect();
    return { x: ((evt.clientX - rect.left) / rect.width) * W, y: ((evt.clientY - rect.top) / rect.height) * H };
  }
  function graphPoint(evt) {
    const p = svgPoint(evt);
    return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
  }
  function zoomAt(point, factor) {
    const next = clampZoom(view.k * factor);
    const world = { x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k };
    view.k = next;
    view.x = point.x - world.x * view.k;
    view.y = point.y - world.y * view.k;
    applyView();
  }
  applyView();

  let alpha = 1;
  function tick() {
    alpha *= 0.985;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      a.vx += (W / 2 - a.x) * 0.0015;
      a.vy += (H / 2 - a.y) * 0.0015;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy; if (d2 < 0.01) { d2 = 0.01; dx = Math.random(); dy = Math.random(); }
        const f = (4200 * alpha) / d2;
        const d = Math.sqrt(d2);
        const ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
      }
    }
    for (const e of edges) {
      let dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 80) * 0.02 * alpha;
      const ux = dx / d, uy = dy / d;
      e.s.vx += ux * f; e.s.vy += uy * f; e.t.vx -= ux * f; e.t.vy -= uy * f;
    }
    for (const n of nodes) {
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x = Math.max(12, Math.min(W - 12, n.x + n.vx));
      n.y = Math.max(12, Math.min(H - 12, n.y + n.vy));
    }
    edges.forEach((e, i) => {
      edgeEls[i].setAttribute('x1', e.s.x); edgeEls[i].setAttribute('y1', e.s.y);
      edgeEls[i].setAttribute('x2', e.t.x); edgeEls[i].setAttribute('y2', e.t.y);
    });
    for (const item of nodeEls) {
      item.circle.setAttribute('cx', item.node.x);
      item.circle.setAttribute('cy', item.node.y);
      if (item.text) { item.text.setAttribute('x', item.node.x + radius(item.node) + 2); item.text.setAttribute('y', item.node.y + 3); }
    }
    if (alpha > 0.02) graphAnim = requestAnimationFrame(tick); else graphAnim = null;
  }
  tick();

  // Drag, pan, zoom + tooltip via SVG coordinate mapping.
  let dragging = null;
  let pendingNode = null;
  let panning = null;
  svg.addEventListener('mousedown', evt => {
    const id = datasetOf(evt.target) && datasetOf(evt.target).id;
    if (id) {
      pendingNode = { node: byId[id], start: graphPoint(evt) };
      svg.style.cursor = 'pointer';
      return;
    }
    panning = { start: svgPoint(evt), x: view.x, y: view.y };
    svg.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', evt => {
    if (pendingNode && !dragging) {
      const p = graphPoint(evt);
      const dx = p.x - pendingNode.start.x, dy = p.y - pendingNode.start.y;
      if (dx * dx + dy * dy > 16) {
        dragging = pendingNode.node;
        dragging.fixed = true;
        pendingNode = null;
        alpha = Math.max(alpha, 0.12); if (!graphAnim) tick();
      }
    }
    if (dragging) { const p = graphPoint(evt); dragging.x = p.x; dragging.y = p.y; return; }
    if (panning) {
      const p = svgPoint(evt);
      view.x = panning.x + p.x - panning.start.x;
      view.y = panning.y + p.y - panning.start.y;
      applyView();
    }
  });
  window.addEventListener('mouseup', () => {
    if (pendingNode) {
      fillGraphBrief(pendingNode.node);
      updateNodeStyles();
      pendingNode = null;
    }
    if (dragging) { dragging.fixed = false; dragging = null; }
    if (panning) panning = null;
    svg.style.cursor = 'grab';
  });
  svg.addEventListener('wheel', evt => {
    evt.preventDefault();
    if (evt.shiftKey) {
      view.x -= evt.deltaY * 0.9;
      view.y -= evt.deltaX * 0.9;
      applyView();
      return;
    }
    zoomAt(svgPoint(evt), Math.exp(-evt.deltaY * 0.0015));
  }, { passive: false });
  elById('graphZoomOutButton').onclick = () => zoomAt({ x: W / 2, y: H / 2 }, 0.8);
  elById('graphZoomInButton').onclick = () => zoomAt({ x: W / 2, y: H / 2 }, 1.25);
  elById('graphResetViewButton').onclick = () => {
    view.x = 0; view.y = 0; view.k = 1; applyView();
  };
  svg.addEventListener('mousemove', evt => {
    const id = datasetOf(evt.target) && datasetOf(evt.target).id;
    if (!id) { tooltip.style.display = 'none'; return; }
    const n = byId[id];
    tooltip.innerHTML = '<strong>' + escapeHtml(n.path) + '</strong><br>' + escapeHtml(n.language || '?') + ' | ' + n.symbols + ' symbols<br>imports ' + n.imports + ' | used by ' + n.usedBy +
      (n.manualPriority ? '<br>manual priority ' + escapeHtml(n.manualPriority) : '') +
      (n.recentKind ? '<br>recent ' + escapeHtml(n.recentKind) + ' #' + escapeHtml(n.recentRank || '') : '') +
      (n.briefStale ? '<br><span style="color:#fbbf24">brief stale</span>' : '') +
      (n.brief ? '<br>' + escapeHtml(n.brief) : '');
    tooltip.style.display = 'block';
    const rect = els.graphCanvas.getBoundingClientRect();
    tooltip.style.left = (evt.clientX - rect.left + 12) + 'px';
    tooltip.style.top = (evt.clientY - rect.top + 12) + 'px';
  });
  svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

const helpTip = elById('helpTooltip');
function showHelpTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  helpTip.textContent = text;
  helpTip.style.display = 'block';
  const icon = target.getBoundingClientRect();
  const tip = helpTip.getBoundingClientRect();
  const margin = 8;
  // Prefer below the icon; flip above when there is not enough room.
  let top = icon.bottom + 6;
  if (top + tip.height + margin > window.innerHeight) {
    const above = icon.top - tip.height - 6;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - tip.height - margin);
  }
  // Align to icon, then clamp within the viewport so edges are never clipped.
  let left = icon.right - tip.width;
  left = Math.min(Math.max(left, margin), window.innerWidth - tip.width - margin);
  helpTip.style.left = left + 'px';
  helpTip.style.top = top + 'px';
}
function hideHelpTip() { helpTip.style.display = 'none'; }
document.addEventListener('mouseover', event => {
  const target = closestFrom(event.target, '.help');
  if (target) showHelpTip(target);
});
document.addEventListener('mouseout', event => {
  if (closestFrom(event.target, '.help')) hideHelpTip();
});
document.addEventListener('focusin', event => {
  const target = closestFrom(event.target, '.help');
  if (target) showHelpTip(target);
});
document.addEventListener('focusout', event => {
  if (closestFrom(event.target, '.help')) hideHelpTip();
});
window.addEventListener('scroll', hideHelpTip, true);

function populateSkillFromFile(file) {
  if (!file) return;
  if (file.size > 512 * 1024) {
    els.skillStatus.innerHTML = '<span class="error">Skill files must not exceed 512 KB.</span>';
    return;
  }
  file.text().then(text => {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
    let instructions = normalized.trim();
    if (frontmatter) {
      const metadata = frontmatter[1] || '';
      const name = /^name:\s*(.+)$/m.exec(metadata);
      const description = /^description:\s*(.+)$/m.exec(metadata);
      if (name) els.skillName.value = name[1].trim().replace(/^['"]|['"]$/g, '');
      if (description) els.skillDescription.value = description[1].trim().replace(/^['"]|['"]$/g, '');
      instructions = (frontmatter[2] || '').trim();
    } else if (!els.skillName.value) {
      els.skillName.value = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    if (!els.skillDescription.value) els.skillDescription.value = 'Imported from ' + file.name;
    els.skillContent.value = instructions;
    els.skillStatus.textContent = 'Loaded ' + file.name + '.';
  }).catch(error => {
    els.skillStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  });
}

on('skillFile', 'change', event => populateSkillFromFile(event.currentTarget.files && event.currentTarget.files[0]));
['dragenter', 'dragover'].forEach(type => els.skillDropZone.addEventListener(type, event => {
  event.preventDefault();
  els.skillDropZone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach(type => els.skillDropZone.addEventListener(type, event => {
  event.preventDefault();
  els.skillDropZone.classList.remove('is-dragging');
}));
els.skillDropZone.addEventListener('drop', event => {
  populateSkillFromFile(event.dataTransfer && event.dataTransfer.files[0]);
});

on('skillForm', 'submit', async event => {
  event.preventDefault();
  const submit = qs(event.currentTarget, 'button[type="submit"]');
  submit.disabled = true;
  els.skillStatus.textContent = 'Saving...';
  try {
    await api('/api/skills/save', {
      method: 'POST',
      body: JSON.stringify({
        scope: els.skillScope.value,
        name: els.skillName.value,
        description: els.skillDescription.value,
        content: els.skillContent.value
      })
    });
    const scope = els.skillScope.value;
    event.currentTarget.reset();
    els.skillScope.value = scope;
    els.skillStatus.textContent = 'Skill saved.';
    await load(true);
  } catch (error) {
    els.skillStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  } finally {
    submit.disabled = false;
  }
});

async function handleSkillListClick(event) {
  const button = closestFrom(event.target, '.delete-skill');
  if (!button) return;
  if (!confirm('Delete skill $' + button.dataset.name + '?')) return;
  button.disabled = true;
  try {
    await api('/api/skills/delete', {
      method: 'POST',
      body: JSON.stringify({ scope: button.dataset.scope, name: button.dataset.name })
    });
    await load(true);
  } catch (error) {
    els.skillStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
    button.disabled = false;
  }
}
els.repoSkills.addEventListener('click', handleSkillListClick);
els.globalSkills.addEventListener('click', handleSkillListClick);

function isGitHubTokenMissing(error) {
  return String(error && error.message || error).includes('GitHub token is not visible to the running Agent Bridge process.');
}

function openGitHubTokenHelp(error) {
  els.githubSkillStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  els.githubTokenHelpModal.hidden = false;
  els.githubTokenHelpClose.focus();
}

function closeGitHubTokenHelp() {
  els.githubTokenHelpModal.hidden = true;
  els.githubSkillQuery.focus();
}

on('githubTokenHelpClose', 'click', closeGitHubTokenHelp);
els.githubTokenHelpModal.addEventListener('click', event => {
  if (event.target === els.githubTokenHelpModal) closeGitHubTokenHelp();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !els.githubTokenHelpModal.hidden) closeGitHubTokenHelp();
});

function renderGitHubSkillResults(results) {
  els.githubSkillResults.innerHTML = results.length ? results.map((result, index) => {
    const stars = Math.max(0, Number(result.stars) || 0).toLocaleString();
    const updatedDate = result.updatedAt ? new Date(result.updatedAt) : null;
    const updated = updatedDate && !Number.isNaN(updatedDate.getTime())
      ? updatedDate.toLocaleDateString()
      : 'unknown';
    return '<div class="card skill-card"><div class="toolbar" style="justify-content:space-between;align-items:flex-start"><div>' +
      '<div><a href="' + escapeHtml(result.repositoryUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(result.repository) + '</a></div>' +
      '<div class="muted">' + escapeHtml(result.description || 'No repository description.') + '</div>' +
      '<div class="meta">★ ' + escapeHtml(stars) + ' stars · updated ' + escapeHtml(updated) + ' · ' + escapeHtml(result.path) + ' · ' + escapeHtml(result.ref) + '</div></div>' +
      '<div class="toolbar"><a class="button ghost" href="' + escapeHtml(result.skillUrl) + '" target="_blank" rel="noreferrer">View</a>' +
      '<button class="secondary install-github-skill" data-result-index="' + index + '" type="button">Install</button></div></div></div>';
  }).join('') : '<div class="muted">No SKILL.md files matched that search.</div>';
  els.githubSkillResults._results = results;
}

on('githubSkillSearchForm', 'submit', async event => {
  event.preventDefault();
  const submit = qs(event.currentTarget, 'button[type="submit"]');
  submit.disabled = true;
  els.githubSkillStatus.textContent = 'Searching GitHub...';
  try {
    const data = await api('/api/skills/github/search?q=' + encodeURIComponent(els.githubSkillQuery.value));
    renderGitHubSkillResults(data.results || []);
    els.githubSkillStatus.textContent = (data.results || []).length + ' result(s).';
  } catch (error) {
    if (isGitHubTokenMissing(error)) openGitHubTokenHelp(error);
    else els.githubSkillStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
  } finally {
    submit.disabled = false;
  }
});

async function requestGitHubSkillInstall(result, overwrite) {
  return api('/api/skills/github/install', {
    method: 'POST',
    body: JSON.stringify({
      repository: result.repository,
      path: result.path,
      ref: result.ref,
      scope: els.githubSkillScope.value,
      overwrite
    })
  });
}

els.githubSkillResults.addEventListener('click', async event => {
  const button = closestFrom(event.target, '.install-github-skill');
  if (!button) return;
  const result = (els.githubSkillResults._results || [])[Number(button.dataset.resultIndex)];
  if (!result) return;
  button.disabled = true;
  els.githubSkillStatus.textContent = 'Downloading and validating skill...';
  try {
    let data;
    try {
      data = await requestGitHubSkillInstall(result, false);
    } catch (error) {
      if (!/already exists/i.test(error.message) || !confirm(error.message + '\n\nReplace the existing skill?')) throw error;
      data = await requestGitHubSkillInstall(result, true);
    }
    els.githubSkillStatus.textContent = 'Installed $' + data.skill.name + ' ' + (data.skill.scope === 'global' ? 'globally.' : 'in this repository.');
    await load(true);
  } catch (error) {
    if (isGitHubTokenMissing(error)) openGitHubTokenHelp(error);
    else els.githubSkillStatus.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
    button.disabled = false;
  }
});

setInterval(() => { if (live) load(false); }, 2000);
load(true);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}
