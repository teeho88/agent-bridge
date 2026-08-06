export function renderDashboardHtml(initialWorkspace = "Workspace"): string {
  const workspaceLabel = escapeStaticHtml(initialWorkspace || "Workspace");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agent-bridge dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #fff;
      --soft: #f9fafb;
      --line: #d8dee6;
      --text: #101828;
      --muted: #667085;
      --accent: #0f766e;
      --blue: #2563eb;
      --red: #b42318;
      --amber: #b54708;
      --green-bg: #ecfdf3;
      --blue-bg: #eff6ff;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    header {
      min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--line);
      position: sticky; top: 0; z-index: 3;
    }
    h1 { margin: 0 0 4px; font-size: 18px; line-height: 1.2; letter-spacing: 0; }
    h2 { margin: 0; font-size: 14px; letter-spacing: 0; }
    h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: 0; }
    main { max-width: 1440px; margin: 0 auto; padding: 16px; display: grid; gap: 14px; }
    .muted, .meta { color: var(--muted); font-size: 12px; line-height: 1.45; }
    .topline, .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 4px 9px;
      border-radius: 999px; background: var(--soft); border: 1px solid var(--line);
      color: var(--muted); font-size: 12px; white-space: nowrap;
    }
    .pill.ok { color: var(--accent); background: var(--green-bg); border-color: #abefc6; }
    .pill.warn { color: var(--amber); background: #fffaeb; border-color: #fedf89; }
    .nav {
      display: flex; gap: 6px; padding: 5px; background: var(--panel); border: 1px solid var(--line);
      border-radius: 8px; box-shadow: var(--shadow); overflow-x: auto;
    }
    .nav button, .tab-button {
      min-height: 36px; border: 1px solid transparent; border-radius: 6px; padding: 8px 11px;
      font: inherit; font-size: 13px; font-weight: 750; cursor: pointer; background: transparent; color: var(--muted);
      white-space: nowrap;
    }
    .nav button.active { background: var(--blue-bg); color: var(--blue); border-color: #bfdbfe; }
    .panel-tabs { display: flex; gap: 4px; min-width: 0; overflow-x: auto; }
    .tab-button.active { background: var(--blue-bg); color: var(--blue); border-color: #bfdbfe; }
    button {
      min-height: 36px; border: 1px solid transparent; border-radius: 6px; padding: 8px 11px;
      font: inherit; font-size: 13px; font-weight: 750; cursor: pointer; background: var(--accent); color: #fff;
    }
    button.secondary { background: #fff; color: var(--blue); border-color: var(--line); }
    button.ghost { background: var(--soft); color: var(--text); border-color: var(--line); }
    .view { display: none; }
    .view.active { display: grid; gap: 14px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; }
    .panel-head { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 13px; border-bottom: 1px solid var(--line); }
    .panel-body { padding: 13px; }
    .action-grid .panel-body { padding-top: 11px; }
    .panel-section { display: grid; gap: 9px; padding-top: 12px; border-top: 1px solid var(--line); }
    .panel-section:first-child { padding-top: 0; border-top: 0; }
    .stack { display: grid; gap: 11px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .graph-layout { display: grid; grid-template-columns: minmax(280px, 0.9fr) minmax(320px, 1fr) minmax(420px, 1.35fr); gap: 12px; align-items: stretch; }
    .stat { padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; min-height: 66px; }
    .stat span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 6px; }
    .stat strong { display: block; font-size: 21px; line-height: 1; }
    .task-carousel-shell { position: relative; overflow: hidden; padding: 0; }
    .live-task-grid {
      display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden;
      padding: 34px max(48px, calc((100% - 720px) / 2)) 36px;
      scroll-snap-type: x mandatory; scroll-behavior: smooth; scrollbar-width: none;
      perspective: 1200px;
    }
    .live-task-grid::-webkit-scrollbar { display: none; }
    .live-task-card {
      position: relative; flex: 0 0 min(720px, calc(100vw - 160px)); min-height: 560px; padding: 14px;
      border-left: 4px solid #0f766e; scroll-snap-align: center;
      display: grid; grid-template-rows: auto auto 1fr auto; gap: 10px; cursor: pointer;
      transform: translateY(16px) scale(0.86) rotateY(0deg); transform-origin: center;
      opacity: 0.64; filter: saturate(0.72); z-index: 1;
      transition: transform 220ms ease, opacity 220ms ease, filter 220ms ease, box-shadow 220ms ease;
    }
    .live-task-card.is-active { border-color: #0f766e; background: linear-gradient(135deg, #ecfdf5, #fff); box-shadow: 0 0 0 1px #a7f3d0, 0 8px 18px rgba(15, 118, 110, 0.12); }
    .live-task-card.is-idle { border-color: #94a3b8; background: #fff; }
    .live-task-card.has-alert { border-color: #b54708; background: #fffbeb; }
    .live-task-card.is-before { transform: translateY(18px) scale(0.84) rotateY(5deg); }
    .live-task-card.is-after { transform: translateY(18px) scale(0.84) rotateY(-5deg); }
    .live-task-card.is-selected {
      outline: 2px solid #2563eb; outline-offset: -2px;
      transform: translateY(0) scale(1) rotateY(0deg);
      opacity: 1; filter: saturate(1); z-index: 3;
      box-shadow: 0 18px 42px rgba(15, 23, 42, 0.2);
    }
    .task-carousel-button {
      position: absolute; top: 50%; z-index: 5; width: 42px; height: 56px; min-height: 0; padding: 0;
      transform: translateY(-50%); border-radius: 999px; border-color: rgba(148, 163, 184, 0.55);
      background: rgba(255,255,255,0.92); color: var(--text); box-shadow: 0 10px 24px rgba(15, 23, 42, 0.18);
      opacity: 0; pointer-events: none; font-size: 28px; line-height: 1;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .task-carousel-button.prev { left: 12px; }
    .task-carousel-button.next { right: 12px; }
    .task-carousel-shell:hover .task-carousel-button:not(:disabled),
    .task-carousel-button:focus-visible { opacity: 1; pointer-events: auto; }
    .task-carousel-button:hover { transform: translateY(-50%) scale(1.05); }
    .task-carousel-button:disabled { opacity: 0; pointer-events: none; }
    /* Runs board: a 2-row x 3-column page of agent cards that scrolls
       horizontally one full page at a time once there are more than six. */
    .run-carousel-shell { position: relative; overflow: hidden; padding: 0; }
    .run-grid {
      display: grid; grid-auto-flow: column; grid-template-rows: repeat(2, minmax(0, 1fr));
      grid-auto-columns: calc((100% - 24px) / 3);
      gap: 12px; padding: 12px; overflow-x: auto; overflow-y: hidden;
      scroll-snap-type: x mandatory; scroll-behavior: smooth; scrollbar-width: none;
    }
    .run-grid::-webkit-scrollbar { display: none; }
    .run-card {
      min-width: 0; scroll-snap-align: start; display: grid; gap: 6px;
      grid-template-rows: auto auto 1fr auto; border-left: 4px solid var(--line);
    }
    .run-card.is-running { border-left-color: #0f766e; background: linear-gradient(135deg, #ecfdf5, #fff); }
    .run-card.is-done { border-left-color: #94a3b8; opacity: 0.82; }
    .run-card.is-failed { border-left-color: #b54708; background: #fffbeb; opacity: 1; }
    .run-card-log {
      margin: 0; min-height: 84px; max-height: 132px; overflow: auto;
      background: #0f172a; color: #e2e8f0; border-radius: 6px; padding: 8px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.45;
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .run-live-dot {
      display: inline-block; width: 7px; height: 7px; border-radius: 999px; background: #0f766e;
      margin-right: 5px; animation: run-pulse 1.2s ease-in-out infinite;
    }
    @keyframes run-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) { .run-live-dot { animation: none; } }
    .run-carousel-shell:hover .task-carousel-button:not(:disabled) { opacity: 1; pointer-events: auto; }
    @media (max-width: 1100px) { .run-grid { grid-auto-columns: calc((100% - 12px) / 2); } }
    @media (max-width: 760px) { .run-grid { grid-auto-columns: 100%; grid-template-rows: minmax(0, 1fr); } }
    .task-card-section { min-width: 0; display: grid; gap: 7px; align-content: start; }
    .task-card-section h3 { margin: 0; }
    .task-card-panel { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,0.78); padding: 9px; }
    .task-card-list { display: grid; gap: 6px; max-height: 150px; overflow: auto; }
    .task-card-list .request-card { padding: 8px; }
    .task-popup-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
    .task-status { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: 11px; font-weight: 750; }
    .task-status.active { background: #ccfbf1; color: #0f766e; }
    .task-status.waiting { background: #f8fafc; color: #64748b; }
    .task-card-title { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
    .metric-pill { min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 6px 7px; background: var(--soft); }
    .metric-pill strong { display: block; font-size: 14px; line-height: 1; }
    .metric-pill span { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .task-control-row { margin-top: 9px; justify-content: space-between; }
    .live-task-state { margin-top: 7px; color: #475569; font-size: 12px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .request-card { border-left: 4px solid #b54708; }
    .request-card textarea { min-height: 54px; }
    .request-queue { max-height: 360px; }
    /* Leader questions: the options are the primary control, so they read as
       one connected group of chips rather than a scattered column of oversized
       browser radios. */
    .question-card { display: grid; gap: 7px; }
    .question-title { font-size: 13px; font-weight: 650; color: var(--text); line-height: 1.35; }
    .question-options { display: flex; flex-wrap: wrap; gap: 6px; }
    .question-option {
      display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 5px 10px;
      border: 1px solid var(--line); border-radius: 999px; background: var(--panel);
      color: var(--text); font-size: 12px; font-weight: 550; line-height: 1.3;
      cursor: pointer; transition: border-color 120ms ease, background 120ms ease;
    }
    .question-option:hover { border-color: var(--blue); }
    .question-option input { width: 13px; height: 13px; min-height: 0; margin: 0; flex: 0 0 auto; accent-color: var(--blue); }
    .question-option:has(input:checked) { border-color: var(--blue); background: var(--blue-bg); color: var(--blue); font-weight: 700; }
    .question-option:has(input:focus-visible) { outline: 2px solid var(--blue); outline-offset: 1px; }
    #orchestratorQuestionList > label { gap: 6px; }
    #orchestratorQuestionList > label, .question-title { color: var(--text); }
    .request-toast-stack {
      position: fixed; right: 16px; bottom: 16px; z-index: 20;
      display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 32px));
      pointer-events: none;
    }
    .request-toast {
      border: 1px solid #fedf89; border-left: 4px solid #b54708; border-radius: 8px;
      background: #fffbeb; box-shadow: 0 14px 34px rgba(15, 23, 42, 0.2);
      padding: 10px; cursor: pointer; pointer-events: auto;
    }
    .request-toast:hover { border-color: #fdb022; }
    .run-toast.is-success { border-color: #a6f4c5; border-left-color: #067647; background: #ecfdf3; }
    .run-toast.is-failure { border-color: #fecdca; border-left-color: #b42318; background: #fef3f2; }
    .request-toast-title { margin-right: 8px; font-size: 13px; line-height: 1.25; }
    .request-toast-meta { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .request-toast-close {
      width: 28px; height: 28px; min-height: 0; padding: 0; flex: 0 0 auto;
      background: rgba(255,255,255,0.75); color: var(--text); border-color: #fedf89;
    }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; font-weight: 650; }
    /* label is a grid, so a bare help bubble next to the caption drops onto its
       own row. This keeps the two on one line. */
    .label-row { display: flex; align-items: center; gap: 6px; }
    input, textarea, select {
      width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 8px 9px;
      font: inherit; font-size: 13px; color: var(--text); background: #fff; min-height: 38px;
    }
    textarea { min-height: 78px; resize: vertical; }
    .card, .memory-row, .tool-row {
      border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 10px;
    }
    .memory-content { white-space: pre-wrap; word-break: break-word; }
    .git-diff { margin-top: 8px; min-height: 0; max-height: 360px; background: #0f172a; color: #e5e7eb; border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.45; white-space: pre; overflow: auto; }
    .git-diff-line.add { color: #86efac; }
    .git-diff-line.del { color: #fca5a5; }
    .git-diff-line.meta { color: #93c5fd; }
    .candidate-row { border-left: 4px solid #f59e0b; background: #fffbeb; }
    .list { display: grid; gap: 8px; max-height: 520px; overflow: auto; }
    .tag {
      display: inline-flex; align-items: center; min-height: 20px; padding: 2px 6px; margin: 6px 4px 0 0;
      border-radius: 999px; background: var(--blue-bg); color: var(--blue); font-size: 12px;
    }
    .help {
      position: relative; display: inline-flex; align-items: center; justify-content: center;
      width: 19px; height: 19px; border-radius: 999px; background: var(--soft); border: 1px solid var(--line);
      color: var(--muted); font-size: 12px; cursor: help; flex: 0 0 auto;
    }
    #helpTooltip {
      position: fixed; z-index: 9999; display: none; pointer-events: none;
      max-width: min(320px, 90vw); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line);
      background: #111827; color: #fff; box-shadow: var(--shadow); font-size: 12px; line-height: 1.4;
      white-space: normal; word-break: break-word;
    }
    .modal-backdrop {
      position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 18px;
      background: rgba(15, 23, 42, 0.38);
    }
    .modal-backdrop[hidden] { display: none; }
    .modal-card { width: min(560px, 100%); max-height: min(720px, 92vh); overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22); padding: 14px; }
    .modal-card.wide { width: min(920px, 100%); }
    pre {
      margin: 0; min-height: 420px; max-height: 680px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      background: #111827; color: #f9fafb; border-radius: 8px; padding: 13px; font-size: 12px; line-height: 1.5;
    }
    .error { color: var(--red); font-size: 12px; }
    .graph-canvas {
      position: relative; width: 100%; height: 520px; background: #0b1220; border: 1px solid var(--line);
      border-radius: 8px; overflow: hidden;
    }
    .graph-canvas svg { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
    .graph-canvas svg text { fill: #cbd5e1; font-size: 9px; pointer-events: none; }
    .graph-canvas .edge { stroke: #334155; stroke-width: 1; }
    .graph-canvas .node { cursor: pointer; stroke: #0b1220; stroke-width: 1.5; }
    .graph-tooltip {
      position: absolute; pointer-events: none; background: #111827; color: #f9fafb; border: 1px solid #334155;
      border-radius: 6px; padding: 6px 8px; font-size: 11px; line-height: 1.4; max-width: 280px; display: none; z-index: 4;
    }
    @media (max-width: 980px) {
      .grid-2, .grid-3, .grid-4, .graph-layout, .task-popup-grid { grid-template-columns: 1fr; }
      .live-task-grid { padding-inline: 28px; }
      .live-task-card { flex-basis: min(92vw, 620px); }
      .live-task-card { min-height: 620px; }
      header { align-items: flex-start; flex-direction: column; }
      main { padding: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>agent-bridge dashboard</h1>
      <div class="topline">
        <span class="pill" id="workspacePill">${workspaceLabel}</span>
        <span class="pill warn" id="hookPill">Claude hook unknown</span>
        <span class="pill ok" id="refreshPill">Live refresh: on</span>
      </div>
    </div>
    <div class="toolbar">
      <button class="secondary" id="installClaudeHookButton" type="button">Install Claude Hook</button>
      <button class="secondary" id="refreshButton" type="button">Refresh</button>
      <button class="ghost" id="toggleLiveButton" type="button">Pause Live</button>
    </div>
  </header>

  <div id="helpTooltip" role="tooltip"></div>
  <div class="modal-backdrop" id="taskDetailModal" hidden>
    <div class="modal-card wide stack">
      <div class="toolbar" style="justify-content:space-between">
        <h2 id="taskDetailTitle">Task Detail</h2>
        <button class="ghost" id="taskDetailClose" type="button">Close</button>
      </div>
      <div id="taskDetailBody"></div>
    </div>
  </div>

  </div>

  <div class="request-toast-stack" id="requestToastStack" aria-live="polite" aria-atomic="false"></div>

  <main>
    <nav class="nav" aria-label="Dashboard sections">
      <button class="active" data-view="overview" type="button">Work Board</button>
      <button data-view="orchestrator" type="button">Orchestrator</button>
      <button data-view="task" type="button">Task</button>
      <button data-view="memory" type="button">Knowledge</button>
      <button data-view="context" type="button">Context</button>
      <button data-view="graph" type="button">Graph</button>
      <button data-view="handoff" type="button">Handoff</button>
      <button data-view="tools" type="button">Tools</button>
    </nav>

    <section class="view active" id="view-overview">
      <section class="panel">
        <div class="panel-head"><h2>Live Task Board</h2><div class="toolbar"><span class="meta" id="liveTaskSummary">0 live tasks</span><span class="help" data-tip="Only direct agent sessions are shown. Orchestrator agents stay in Orchestrator → Runs. Hover either side to move between live task cards.">?</span></div></div>
        <div class="panel-body task-carousel-shell" id="liveTaskShell">
          <button class="task-carousel-button prev" id="liveTaskPrev" type="button" aria-label="Previous live task">&lsaquo;</button>
          <div class="live-task-grid" id="liveTasks"></div>
          <button class="task-carousel-button next" id="liveTaskNext" type="button" aria-label="Next live task">&rsaquo;</button>
        </div>
      </section>
      <div hidden>
        <div id="overviewSessionState"></div>
        <div id="overviewTimeline"></div>
        <span id="agentRequestSummary"></span>
        <div id="agentRequestQueue"></div>
        <div id="tokenSavings"></div>
        <select id="laneTaskId"></select>
        <div id="workChanges"></div>
        <div id="workLeases"></div>
      </div>
    </section>
    <section class="view" id="view-orchestrator">
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head">
            <div class="panel-tabs">
              <button class="tab-button active" data-orch-tab="start" type="button">Start Orchestration</button>
              <button class="tab-button" data-orch-tab="subtask" type="button">Add Subtask &amp; Spawn</button>
              <button class="tab-button" data-orch-tab="agents" type="button">Agents</button>
            </div>
            <span class="help" data-tip="Start Orchestration creates a task, picks a leader, and spawns its plan turn. Add Subtask &amp; Spawn puts one agent straight onto a subtask of the current task, outside the leader's plan.">?</span>
          </div>
          <div class="panel-body" data-orch-panel="start">
            <form id="orchestratorStartForm" class="stack">
              <label>Request <textarea name="prompt" required placeholder="Build the report module"></textarea></label>
              <div class="grid-3">
                <label>Leader provider <select name="leaderProvider" id="orchestratorLeaderProvider"></select></label>
                <label>Model <select name="leaderModel" id="orchestratorLeaderModel"></select></label>
                <label>Reasoning <select name="leaderReasoning" id="orchestratorLeaderReasoning"></select></label>
              </div>
              <div class="grid-3">
                <label>Autonomy <select name="autonomy">
                  <option value="auto">Auto — run to the report on its own</option>
                  <option value="approve-each">Approve each — ask before every agent</option>
                  <option value="manual">Manual — advance with Step</option>
                </select></label>
                <label>Max parallel <input name="maxParallel" type="number" value="3" min="1"></label>
                <label>Max cycles <input name="maxCycles" type="number" value="8" min="1"></label>
              </div>
              <label><span class="label-row">Team providers <span class="help" data-tip="Which CLIs the leader may staff implementers and reviewers from. Leave them all ticked to let the leader mix providers — that spreads the work across each vendor's quota instead of spending one provider's allowance on the whole project.">?</span></span></label>
              <div id="orchestratorTeamProviders" style="display:flex; flex-wrap:wrap; gap:6px 14px; margin-top:-4px"></div>
              <button type="submit">Start Project</button>
              <div class="meta" id="orchestratorStartStatus"></div>
            </form>
          </div>
          <div class="panel-body" data-orch-panel="subtask" hidden>
            <form id="orchestratorSubtaskForm" class="stack">
              <label>Title <input name="title" required placeholder="Fix the empty-state bug"></label>
              <label>Goal <input name="goal" placeholder="optional"></label>
              <label>Acceptance criteria (comma-separated) <input name="criteria" placeholder="tests pass, no regression"></label>
              <div class="grid-3">
                <label>Provider <select name="provider" id="orchestratorSubtaskProvider"></select></label>
                <label>Model <select name="model" id="orchestratorSubtaskModel"></select></label>
                <label>Reasoning <select name="reasoningEffort" id="orchestratorSubtaskReasoning"></select></label>
              </div>
              <button type="submit">Add &amp; Spawn</button>
              <div class="meta" id="orchestratorSubtaskStatus"></div>
            </form>
          </div>
          <div class="panel-body" data-orch-panel="agents" hidden>
            <div class="list" id="workforceAgents" style="margin-bottom:12px"></div>
          <div id="workforceAgentFormWrap">
            <form id="workforceAgentForm" class="stack">
              <input type="hidden" name="agentId" id="workforceAgentId">
              <div class="grid-2">
                <label>Name <input name="name" required placeholder="deepseek-reviewer"></label>
                <label>Provider
                  <select name="provider" id="workforceAgentProvider">
                    <option value="codex">codex</option>
                    <option value="claude">claude</option>
                    <option value="gemini">gemini</option>
                    <option value="antigravity">antigravity</option>
                    <option value="openai-compatible">openai-compatible</option>
                    <option value="deepseek">deepseek</option>
                    <option value="kimi">kimi</option>
                    <option value="glm">glm</option>
                    <option value="manual">manual</option>
                    <option value="generic">generic</option>
                  </select>
                </label>
                <label>Mode
                  <select name="mode" id="workforceAgentMode">
                    <option value="cli">cli</option>
                    <option value="api">api</option>
                    <option value="manual">manual</option>
                  </select>
                </label>
                <label data-mode-field="cli">Command <input name="command" placeholder="codex or claude"></label>
                <label data-mode-field="cli">Model <input name="model" list="workforceCliModels" placeholder="Choose or enter a model"></label>
                <label data-mode-field="cli">Reasoning / effort <select name="reasoningEffort" id="workforceAgentReasoning"><option value="">Provider default</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option><option>ultra</option></select></label>
                <label data-mode-field="api">Base URL <input name="baseUrl" placeholder="https://api.example.com"></label>
                <label data-mode-field="api">Model <input name="model" placeholder="model name"></label>
                <label data-mode-field="api">Credential ref <input name="credentialRef" placeholder="DEEPSEEK_API_KEY"></label>
                <label>Capabilities <input name="capabilities" placeholder="implement, review, adjudicate, report"></label>
              </div>
              <button type="submit" id="workforceAgentSubmit">Add Agent</button>
              <button type="button" id="workforceAgentCancelEdit" class="ghost" style="display:none">Cancel Edit</button>
            </form>
            <!-- Static fallback shown before the real catalog loads (see loadOrchestratorCatalog / syncAgentModelCatalog below); kept in sync with packages/adapters/src/catalog.ts's seed models. -->
            <datalist id="workforceCliModels"><option value="gpt-5.6-sol"><option value="gpt-5.6-terra"><option value="gpt-5.6-luna"><option value="gpt-5.5"></datalist>
          </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Orchestration</h2><span class="help" data-tip="Step advances the leader/implementer/reviewer loop by exactly one transition. Auto-run keeps stepping on the server every few seconds until the orchestration finishes, generating the final report too; it is the same switch as the Autonomy field on the left.">?</span></div>
          <div class="panel-body">
            <label>Showing <select id="orchestratorPicker"></select></label>
            <div class="meta" id="orchestratorSummary" style="margin-top:8px">No orchestration for the current task.</div>
            <div class="toolbar" style="margin-top:10px">
              <button type="button" class="secondary" id="orchestratorAutoRunButton">Auto-run</button>
              <button type="button" class="secondary" id="orchestratorStepButton">Step</button>
              <button type="button" class="ghost" id="orchestratorPauseToggle">Pause</button>
              <button type="button" class="ghost" id="orchestratorStopButton">Stop</button>
              <button type="button" class="secondary" id="orchestratorReportButton">Generate report</button>
              <button type="button" class="secondary" id="orchestratorRequestChangesButton">Request changes</button>
              <button type="button" class="ghost" id="orchestratorRemoveButton" style="margin-left:auto; color:var(--red)">Remove</button>
            </div>
            <div id="orchestratorApprovals" hidden style="margin-top:10px; border:1px solid var(--blue); border-radius:8px; padding:10px; background:var(--blue-bg)">
              <strong>Waiting for your approval</strong>
              <div class="meta">Autonomy is set to approve-each, so nothing is launched until you say so.</div>
              <div id="orchestratorApprovalList" style="margin-top:8px; display:grid; gap:8px"></div>
              <div class="meta" id="orchestratorApprovalStatus"></div>
            </div>
            <div id="orchestratorQuestions" hidden style="margin-top:10px; border:1px solid var(--amber); border-radius:8px; padding:10px; background:#fffbeb">
              <strong>Leader needs answers before it can plan</strong>
              <div class="meta">These were guesses the leader refused to make on its own. Answers become settled requirements in the next plan.</div>
              <div id="orchestratorQuestionList" style="margin-top:8px; display:grid; gap:10px"></div>
              <div class="toolbar" style="margin-top:10px">
                <button type="button" class="secondary" id="orchestratorAnswerButton">Send answers &amp; re-plan</button>
                <button type="button" class="ghost" id="orchestratorDismissQuestionsButton">Skip — let the leader decide</button>
              </div>
              <div class="meta" id="orchestratorQuestionStatus"></div>
            </div>
            <form id="orchestratorChangeForm" style="margin-top:10px" hidden>
              <label>What should change?
                <textarea name="request" rows="4" placeholder="e.g. Add sound effects for flap and collision, plus a mute toggle. Keep the existing gameplay and file layout."></textarea>
              </label>
              <label><span class="label-row">Team providers <span class="help" data-tip="Providers allowed for implementers and reviewers in the new plan. This is enforced again when every agent is spawned.">?</span></span></label>
              <div id="orchestratorChangeTeamProviders" style="display:flex; flex-wrap:wrap; gap:6px 14px; margin:6px 0"></div>
              <div class="toolbar" style="margin-top:8px">
                <button type="submit" class="secondary">Reopen &amp; re-plan</button>
                <button type="button" class="ghost" id="orchestratorChangeCancel">Cancel</button>
              </div>
              <div class="meta" id="orchestratorChangeStatus"></div>
            </form>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Runs</h2>
          <span class="help" data-tip="Every spawned/adopted agent process for this orchestration: role, model, phase, status, and live log output. Running agents come first. Finished runs keep their full log behind the Full log button.">?</span>
          <div class="panel-tabs" style="margin-left:auto">
            <button class="tab-button active" data-runs-filter="active" type="button">Active</button>
            <button class="tab-button" data-runs-filter="cycle" type="button">This cycle</button>
            <button class="tab-button" data-runs-filter="all" type="button">All</button>
          </div>
          <span class="meta" id="orchestratorRunsCount"></span>
        </div>
        <div class="panel-body run-carousel-shell" id="orchestratorRunsShell">
          <button class="task-carousel-button prev" id="orchestratorRunsPrev" type="button" aria-label="Previous runs">&lsaquo;</button>
          <div class="run-grid" id="orchestratorRuns"></div>
          <button class="task-carousel-button next" id="orchestratorRunsNext" type="button" aria-label="More runs">&rsaquo;</button>
        </div>
      </section>
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Subtasks</h2></div>
          <div class="panel-body list" id="orchestratorSubtasks"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Reviews</h2></div>
          <div class="panel-body list" id="orchestratorReviews"></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>External Sessions</h2><span class="help" data-tip="Agents already running in this repo via hooks that are not yet part of any team. Adopt one to bring it onto the board.">?</span></div>
        <div class="panel-body list" id="orchestratorAdoptable"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Activity</h2></div>
        <div class="panel-body list" id="orchestratorEvents"></div>
      </section>
    </section>
    <section class="view" id="view-task">
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Start Task</h2><span class="help" data-tip="Use this when no agent hook has created a task yet, or when you want to override the active task.">?</span></div>
          <div class="panel-body">
            <form id="taskForm" class="stack">
              <label>Title <input name="title" required placeholder="Fix checkout validation bug"></label>
              <label>Goal <textarea name="goal" placeholder="Expected outcome"></textarea></label>
              <label>Agent
                <select name="agent">
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="antigravity">Antigravity</option>
                  <option value="generic">Generic</option>
                </select>
              </label>
              <button type="submit">Start Task</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Edit Selected Task</h2><span class="help" data-tip="Click Edit on any task in Recent Tasks, then update title, goal, status, or owner. This rewrites .agent-memory/current-task.md when the selected task is active.">?</span></div>
          <div class="panel-body">
            <form id="taskEditForm" class="stack">
              <input name="taskId" id="editTaskId" type="hidden">
              <label>Title <input name="title" id="editTaskTitle" placeholder="Current task title"></label>
              <label>Goal <textarea name="goal" id="editTaskGoal" placeholder="Current task goal"></textarea></label>
              <div class="grid-2">
                <label>Status
                  <select name="status" id="editTaskStatus">
                    <option value="todo">todo</option>
                    <option value="in_progress">in_progress</option>
                    <option value="blocked">blocked</option>
                    <option value="done">done</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </label>
                <label>Agent
                  <select name="agent" id="editTaskAgent">
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                    <option value="antigravity">Antigravity</option>
                    <option value="generic">Generic</option>
                  </select>
                </label>
              </div>
              <button type="submit">Save Task</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Recent Tasks</h2><span class="help" data-tip="Most recently updated tasks in the local SQLite memory database.">?</span></div>
          <div class="panel-body list" id="tasks"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Session Tracking</h2><span class="help" data-tip="Use this for Codex, Antigravity, or any agent without a native hook. Claude sessions are captured automatically when its hook is installed.">?</span></div>
          <div class="panel-body">
            <form id="sessionForm" class="stack">
              <div class="grid-2">
                <label>Agent
                  <select name="agent" id="sessionAgent">
                    <option value="codex">Codex</option>
                    <option value="antigravity">Antigravity</option>
                    <option value="generic">Generic</option>
                    <option value="claude">Claude</option>
                  </select>
                </label>
                <label>Task <select name="taskId" id="sessionTaskId"></select></label>
              </div>
              <label>Current state <textarea name="text" placeholder="Optional for start/end; required when updating state"></textarea></label>
              <div class="toolbar">
                <button class="secondary session-action" data-session-action="start" type="button">Start</button>
                <button class="secondary session-action" data-session-action="summary" type="button">Update state</button>
                <button class="ghost session-action" data-session-action="end" type="button">End</button>
                <span class="meta" id="sessionStatus"></span>
              </div>
            </form>
          </div>
        </div>
      </section>
    </section>

    <section class="view" id="view-memory">
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Add Memory</h2><span class="help" data-tip="Save durable facts only: decisions, constraints, bugs, test results, or useful notes.">?</span></div>
          <div class="panel-body">
            <form id="memoryForm" class="stack">
              <label>Content <textarea name="content" required placeholder="Fact, bug, decision, test result, or constraint"></textarea></label>
              <div class="grid-2">
                <label>Type
                  <select name="type" id="memoryType">
                    <option value="note">note</option>
                    <option value="bug">bug</option>
                    <option value="constraint">constraint</option>
                    <option value="decision">decision</option>
                    <option value="test">test</option>
                    <option value="file">file</option>
                  </select>
                </label>
                <label>Importance <input name="importance" id="memoryImportance" type="number" min="1" max="5" value="3"></label>
              </div>
              <div class="grid-2">
                <label>Scope
                  <select name="scope" id="memoryScope"><option value="repo">Repository shared</option><option value="task">Selected task</option></select>
                </label>
                <label>Task
                  <select name="taskId" id="memoryTaskId"></select>
                </label>
              </div>
              <label>Tags <input name="tags" placeholder="auth,cookie,session"></label>
              <button type="submit">Save Memory</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Search Memory</h2><span class="help" data-tip="Keyword search over content, summary, and tags. Higher importance appears first.">?</span></div>
          <div class="panel-body stack">
            <div class="toolbar">
              <input id="searchQuery" placeholder="session cookie">
              <button class="secondary" id="searchButton" type="button">Search</button>
            </div>
            <div class="list" id="searchResults"></div>
          </div>
        </div>
      </section>
      <section class="panel">
          <div class="panel-head"><h2>Session State</h2><span class="help" data-tip="The latest agent summary used to orient the next agent turn. Older summaries are hidden from active context.">?</span></div>
        <div class="panel-body" id="sessionState">No session state yet.</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Current Task Memories</h2><span class="help" data-tip="These entries feed the context compiler for Claude, Codex, Antigravity, or generic agents.">?</span></div>
        <div class="panel-body list" id="memories"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Repository Memory</h2><span class="help" data-tip="Shared facts for every task in this repository. The knowledge graph is also repository-wide and is included in task context when enabled.">?</span></div>
        <div class="panel-body list" id="repoMemories"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Repository Memory Inbox</h2><span class="help" data-tip="Potential shared instructions and discoveries captured from sessions. Promote only facts that should guide every task in this repository.">?</span></div>
        <div class="panel-body list" id="repoMemoryCandidates"></div>
      </section>
    </section>

    <section class="view" id="view-context">
      <section class="panel">
        <div class="panel-head"><h2>Compile Context</h2><span class="help" data-tip="Builds .agent-memory/compiled-context.md from current task, memory, handoff, and decisions under a token budget.">?</span></div>
        <div class="panel-body">
          <form id="compileForm" class="grid-3">
            <label>Task
              <select name="taskId" id="compileTaskId"></select>
            </label>
            <label>Target agent
              <select name="agent">
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="antigravity">Antigravity</option>
                <option value="generic">Generic</option>
              </select>
            </label>
            <label>Token budget <input name="budget" type="number" value="4000"></label>
            <label>&nbsp;<button type="submit">Compile Context</button></label>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Compiled Context</h2><span class="help" data-tip="This is the compact brief to give to agents instead of pasting full chat history or long logs.">?</span></div>
        <div class="panel-body stack">
          <textarea id="compiledEditor" style="min-height:420px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; line-height:1.5"></textarea>
          <div class="toolbar">
            <button class="secondary" id="saveCompiledButton" type="button">Save Edited Context</button>
            <span class="meta" id="contextSaveStatus"></span>
          </div>
        </div>
      </section>
    </section>

    <section class="view" id="view-optimize">
      <section class="grid-4">
        <div class="stat"><span>Baseline saved</span><strong id="optSavedPctStat">—</strong></div>
        <div class="stat"><span>Tokens saved (latest)</span><strong id="optSavedTokensStat">—</strong></div>
        <div class="stat"><span>Files compared</span><strong id="optFilesStat">—</strong></div>
        <div class="stat"><span>Compiled brief avg</span><strong id="optCompiledAvgStat">—</strong></div>
      </section>
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Repository Savings Measurement</h2><span class="help" data-tip="Reads the repo-map files' raw source and compares it against the compact repo map index that replaces that reading. Models orientation cost: what an agent would spend reading files to understand the repo. Needs a built graph.">?</span></div>
          <div class="panel-body">
            <form id="optimizeForm" class="grid-3">
              <label>Files (limit) <input name="limit" id="optLimit" type="number" min="1" max="500" placeholder="repo map limit"></label>
              <label>Focus paths <input name="focus" id="optFocus" placeholder="packages/core, src/auth"></label>
              <label>&nbsp;<button type="submit" id="optRunButton">Measure Savings</button></label>
            </form>
            <div class="meta" id="optStatus" style="margin-top:8px"></div>
            <div id="optResult" class="stack" style="margin-top:12px"></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Savings History</h2><span class="help" data-tip="Recorded baseline runs (most recent first). Each row is one measurement; the percentage is tokens saved versus reading the files raw.">?</span></div>
          <div class="panel-body list" id="optHistory"><div class="muted">No baseline runs recorded yet. Click Measure Savings.</div></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Most Expensive Files If Read Raw</h2><span class="help" data-tip="The files in the repo map that would cost the most tokens to read in full. These are exactly what the repo map index lets an agent skip.">?</span></div>
        <div class="panel-body list" id="optTopFiles"><div class="muted">Run a measurement to see per-file costs.</div></div>
      </section>
    </section>

    <section class="view" id="view-graph">
      <section class="grid-4">
        <div class="stat"><span>Files</span><strong id="graphFilesStat">0</strong></div>
        <div class="stat"><span>Symbols</span><strong id="graphSymbolsStat">0</strong></div>
        <div class="stat"><span>Internal imports</span><strong id="graphInternalStat">0</strong></div>
        <div class="stat"><span>External imports</span><strong id="graphExternalStat">0</strong></div>
      </section>
      <section class="graph-layout">
        <div class="panel">
          <div class="panel-head"><h2>Graph Settings</h2><span class="help" data-tip="Build scans the repo to map files, symbols, and imports. The repo map is a compact overview injected into compiled context so agents understand the repo without reading every file.">?</span></div>
          <div class="panel-body stack">
            <div class="toolbar">
              <button id="graphBuildButton" type="button">Build / Rebuild Graph</button>
              <button class="secondary" id="briefAutoAllButton" type="button">Refresh All Briefs</button>
              <span class="help" data-tip="Regenerates the auto-brief for every indexed file from its header comment and role. Run after a build, since Build/Rebuild leaves briefs untouched. Preserves each file's importance.">?</span>
              <span class="meta" id="graphBuildStatus"></span>
            </div>
            <form id="graphSettingsForm" class="stack">
              <label class="toolbar" style="font-weight:650; color:var(--text)">
                <input type="checkbox" name="injectRepoMap" id="injectRepoMap" style="width:auto; min-height:0; margin:0">
                Inject repo map into compiled context
              </label>
              <label class="toolbar" style="font-weight:650; color:var(--text)">
                <input type="checkbox" name="autoBriefOnToolUse" id="autoBriefOnToolUse" style="width:auto; min-height:0; margin:0">
                Auto-brief files Claude reads/edits
                <span class="help" data-tip="When on, Claude's PostToolUse hook regenerates the brief for each source file it reads or edits, keeping the graph index warm for fast search. Off skips this; the hook stays installed.">?</span>
              </label>
              <label class="toolbar" style="font-weight:650; color:var(--text)">
                <input type="checkbox" name="watchAutoBrief" id="watchAutoBrief" style="width:auto; min-height:0; margin:0">
                Auto-brief on file change (watcher)
                <span class="help" data-tip="When on, the watcher briefs source files as they change on disk — works for any agent (codex/antigravity), edits only. This checkbox pauses/resumes briefing; use Start/Stop Watcher below to run or kill the watcher process itself.">?</span>
              </label>
              <label>Repo map file limit <input name="repoMapLimit" id="repoMapLimit" type="number" min="1" max="500" value="30"></label>
              <label>Scan only these paths <textarea name="graphIncludePaths" id="graphIncludePaths" placeholder="src, app, firmware/Core"></textarea></label>
              <label>Ignore extra paths <textarea name="graphIgnorePaths" id="graphIgnorePaths" placeholder="Drivers, Middlewares, third_party, vendor"></textarea></label>
              <div class="toolbar">
                <button class="secondary" type="submit">Save Settings</button>
                <span class="meta" id="graphSettingsStatus"></span>
              </div>
            </form>
            <div class="toolbar" style="margin-top:8px">
              <span class="pill warn" id="watcherPill">Watcher unknown</span>
              <button class="secondary" id="watcherToggleButton" type="button">Start Watcher</button>
              <span class="help" data-tip="Runs 'agent-bridge watch' as a background process for this repo so any agent's edits get briefed automatically. Stops when the UI server stops. Recursive watch is full on Windows/macOS, top-level only on Linux.">?</span>
              <span class="meta" id="watcherStatus"></span>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>File Brief</h2><span class="help" data-tip="Save sparse briefs only for important or already-used files. Stale briefs are flagged when the file changes after the brief was saved.">?</span></div>
          <div class="panel-body">
            <form id="graphBriefForm" class="stack">
              <label>File path <input name="path" id="graphBriefPath" placeholder="packages/core/src/context-compiler.ts" required></label>
              <div class="grid-2">
                <label>Manual priority <input name="manualPriority" id="graphBriefPriority" type="number" min="1" max="5" placeholder="Optional"></label>
                <label class="toolbar" style="font-weight:650; color:var(--text); align-content:end">
                  <input type="checkbox" name="taskEdited" id="graphBriefTaskEdited" style="width:auto; min-height:0; margin:0">
                  Recent task edit
                </label>
              </div>
              <label>Brief <textarea name="summary" id="graphBriefSummary" required placeholder="Short role, key responsibilities, and when an agent should open it"></textarea></label>
              <label>Important ranges <input name="ranges" id="graphBriefRanges" placeholder="24-80, 140-180"></label>
              <div class="toolbar">
                <button class="secondary" type="submit">Save Brief</button>
                <span class="meta" id="graphBriefStatus"></span>
              </div>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Repo Map</h2><span class="help" data-tip="Compiled context uses task matches, their direct graph neighbours, then structural fallback. This panel shows the current map text.">?</span></div>
          <div class="panel-body"><pre id="repoMap" style="min-height:320px; max-height:460px">No graph yet. Click Build.</pre></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Dependency Graph</h2>
          <div class="toolbar">
            <input id="graphFocus" placeholder="focus: src,auth" style="min-height:32px; width:200px">
            <input id="graphLimit" type="number" min="10" max="400" value="120" style="min-height:32px; width:80px" title="max files">
            <button class="secondary" id="graphReloadButton" type="button">Reload</button>
            <button class="secondary" id="graphZoomOutButton" type="button" title="Zoom out">-</button>
            <button class="secondary" id="graphZoomInButton" type="button" title="Zoom in">+</button>
            <button class="secondary" id="graphResetViewButton" type="button">Reset view</button>
            <span class="help" data-tip="Each node is a file; arrows point from importer to imported. Larger/greener nodes are imported by more files (more central). Drag nodes to rearrange; hover for details.">?</span>
          </div>
        </div>
        <div class="panel-body">
          <div id="graphCanvas" class="graph-canvas"><div class="muted" style="padding:20px">No graph yet. Build it from Graph Settings.</div></div>
          <div class="meta" id="graphHint" style="margin-top:8px"></div>
        </div>
      </section>
    </section>

    <section class="view" id="view-handoff">
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Create Handoff</h2><span class="help" data-tip="Use this when one agent stops and another agent should continue with minimal context.">?</span></div>
          <div class="panel-body">
            <form id="handoffForm" class="stack">
              <div class="grid-2">
                <label>From <select name="from"><option value="claude">Claude</option><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="generic">Generic</option></select></label>
                <label>To <select name="to"><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option><option value="generic">Generic</option></select></label>
              </div>
              <label>Summary <textarea name="summary" required placeholder="What changed or what the next agent needs to know"></textarea></label>
              <div class="grid-2">
                <label>Done <textarea name="done" placeholder="Comma or newline separated"></textarea></label>
                <label>Next <textarea name="next" placeholder="Comma or newline separated"></textarea></label>
              </div>
              <label>Risks <input name="risks" placeholder="Do not touch payment flow"></label>
              <button type="submit">Create Handoff</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Latest Handoff</h2><span class="help" data-tip="Last saved handoff packet for the selected task. Edit and save to create a corrected latest handoff. Also written to .agent-memory/handoff.md and handoff.json.">?</span></div>
          <div class="panel-body stack">
            <div id="handoff">No handoff yet.</div>
            <div class="panel-section">
              <h3>Edit Latest Handoff</h3>
              <form id="latestHandoffEditForm" class="stack">
                <input name="handoffId" id="latestHandoffId" type="hidden">
                <input name="taskId" id="latestHandoffTaskId" type="hidden">
                <div class="grid-2">
                  <label>From <select name="from" id="latestHandoffFrom"><option value="">None</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="generic">Generic</option></select></label>
                  <label>To <select name="to" id="latestHandoffTo"><option value="">None</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option><option value="generic">Generic</option></select></label>
                </div>
                <label>Summary <textarea name="summary" id="latestHandoffSummary" required placeholder="What changed or what the next agent needs to know"></textarea></label>
                <div class="grid-2">
                  <label>Done <textarea name="done" id="latestHandoffDone" placeholder="Comma or newline separated"></textarea></label>
                  <label>Next <textarea name="next" id="latestHandoffNext" placeholder="Comma or newline separated"></textarea></label>
                </div>
                <div class="grid-2">
                  <label>Risks <textarea name="risks" id="latestHandoffRisks" placeholder="Comma or newline separated"></textarea></label>
                  <label>Files Changed <textarea name="filesChanged" id="latestHandoffFilesChanged" placeholder="Comma or newline separated"></textarea></label>
                </div>
                <button type="submit">Save Edited Handoff</button>
              </form>
            </div>
          </div>
        </div>
      </section>
    </section>

    <section class="view" id="view-tools">
      <section class="panel">
        <div class="panel-head"><h2>Token Stack & Optional Tools</h2><span class="help" data-tip="Core stack layers run locally. Optional tools add repository packing and usage inspection.">?</span></div>
        <div class="panel-body stack">
          <h3>Active stack</h3>
          <div class="list" id="tokenStack"></div>
          <h3>Optional CLIs</h3>
          <div class="list" id="tools"></div>
          <div class="card">
            <h3>Install command</h3>
            <pre style="min-height: 0; max-height: 120px;">powershell -ExecutionPolicy Bypass -File .\\scripts\\install-token-tools.ps1 -InstallGlobal -CloneRepos</pre>
          </div>
        </div>
      </section>
    </section>
  </main>

  <script>
    const els = {
      workspacePill: document.getElementById('workspacePill'),
      hookPill: document.getElementById('hookPill'),
      installClaudeHookButton: document.getElementById('installClaudeHookButton'),
      refreshPill: document.getElementById('refreshPill'),
      liveTaskSummary: document.getElementById('liveTaskSummary'),
      liveTaskShell: document.getElementById('liveTaskShell'),
      liveTasks: document.getElementById('liveTasks'),
      liveTaskPrev: document.getElementById('liveTaskPrev'),
      liveTaskNext: document.getElementById('liveTaskNext'),
      editTaskId: document.getElementById('editTaskId'),
      editTaskTitle: document.getElementById('editTaskTitle'),
      editTaskGoal: document.getElementById('editTaskGoal'),
      editTaskStatus: document.getElementById('editTaskStatus'),
      editTaskAgent: document.getElementById('editTaskAgent'),
      sessionForm: document.getElementById('sessionForm'),
      sessionTaskId: document.getElementById('sessionTaskId'),
      sessionStatus: document.getElementById('sessionStatus'),
      memoryType: document.getElementById('memoryType'),
      memoryImportance: document.getElementById('memoryImportance'),
      memoryScope: document.getElementById('memoryScope'),
      memoryTaskId: document.getElementById('memoryTaskId'),
      sessionState: document.getElementById('sessionState'),
      overviewSessionState: document.getElementById('overviewSessionState'),
      tokenSavings: document.getElementById('tokenSavings'),
      overviewTimeline: document.getElementById('overviewTimeline'),
      tasks: document.getElementById('tasks'),
      memories: document.getElementById('memories'),
      overviewMemories: document.getElementById('overviewMemories'),
      repoMemories: document.getElementById('repoMemories'),
      repoMemoryCandidates: document.getElementById('repoMemoryCandidates'),
      handoff: document.getElementById('handoff'),
      latestHandoffForm: document.getElementById('latestHandoffEditForm'),
      latestHandoffId: document.getElementById('latestHandoffId'),
      latestHandoffTaskId: document.getElementById('latestHandoffTaskId'),
      latestHandoffFrom: document.getElementById('latestHandoffFrom'),
      latestHandoffTo: document.getElementById('latestHandoffTo'),
      latestHandoffSummary: document.getElementById('latestHandoffSummary'),
      latestHandoffDone: document.getElementById('latestHandoffDone'),
      latestHandoffNext: document.getElementById('latestHandoffNext'),
      latestHandoffRisks: document.getElementById('latestHandoffRisks'),
      latestHandoffFilesChanged: document.getElementById('latestHandoffFilesChanged'),
      compiledEditor: document.getElementById('compiledEditor'),
      compileTaskId: document.getElementById('compileTaskId'),
      contextSaveStatus: document.getElementById('contextSaveStatus'),
      searchResults: document.getElementById('searchResults'),
      tools: document.getElementById('tools'),
      tokenStack: document.getElementById('tokenStack'),
      overviewTools: document.getElementById('overviewTools'),
      optSavedPctStat: document.getElementById('optSavedPctStat'),
      optSavedTokensStat: document.getElementById('optSavedTokensStat'),
      optFilesStat: document.getElementById('optFilesStat'),
      optCompiledAvgStat: document.getElementById('optCompiledAvgStat'),
      optLimit: document.getElementById('optLimit'),
      optFocus: document.getElementById('optFocus'),
      optStatus: document.getElementById('optStatus'),
      optResult: document.getElementById('optResult'),
      optHistory: document.getElementById('optHistory'),
      optTopFiles: document.getElementById('optTopFiles'),
      graphFilesStat: document.getElementById('graphFilesStat'),
      graphSymbolsStat: document.getElementById('graphSymbolsStat'),
      graphInternalStat: document.getElementById('graphInternalStat'),
      graphExternalStat: document.getElementById('graphExternalStat'),
      injectRepoMap: document.getElementById('injectRepoMap'),
      autoBriefOnToolUse: document.getElementById('autoBriefOnToolUse'),
      watchAutoBrief: document.getElementById('watchAutoBrief'),
      repoMapLimit: document.getElementById('repoMapLimit'),
      graphIncludePaths: document.getElementById('graphIncludePaths'),
      graphIgnorePaths: document.getElementById('graphIgnorePaths'),
      repoMap: document.getElementById('repoMap'),
      graphCanvas: document.getElementById('graphCanvas'),
      graphHint: document.getElementById('graphHint'),
      graphBuildStatus: document.getElementById('graphBuildStatus'),
      graphSettingsStatus: document.getElementById('graphSettingsStatus'),
      watcherPill: document.getElementById('watcherPill'),
      watcherToggleButton: document.getElementById('watcherToggleButton'),
      watcherStatus: document.getElementById('watcherStatus'),
      graphBriefPath: document.getElementById('graphBriefPath'),
      graphBriefPriority: document.getElementById('graphBriefPriority'),
      graphBriefSummary: document.getElementById('graphBriefSummary'),
      graphBriefRanges: document.getElementById('graphBriefRanges'),
      graphBriefTaskEdited: document.getElementById('graphBriefTaskEdited'),
      graphBriefStatus: document.getElementById('graphBriefStatus'),
      laneTaskId: document.getElementById('laneTaskId'),
      workChanges: document.getElementById('workChanges'),
      workLeases: document.getElementById('workLeases'),
      agentRequestQueue: document.getElementById('agentRequestQueue'),
      agentRequestSummary: document.getElementById('agentRequestSummary'),
      requestToastStack: document.getElementById('requestToastStack'),
      workforceAgentMode: document.getElementById('workforceAgentMode'),
      workforceAgentId: document.getElementById('workforceAgentId'),
      workforceAgentSubmit: document.getElementById('workforceAgentSubmit'),
      workforceAgentCancelEdit: document.getElementById('workforceAgentCancelEdit'),
      taskDetailModal: document.getElementById('taskDetailModal'),
      taskDetailTitle: document.getElementById('taskDetailTitle'),
      taskDetailBody: document.getElementById('taskDetailBody'),
      workforceAgents: document.getElementById('workforceAgents'),
    };
    let live = true;
    let lastFingerprint = '';
    let graphLoaded = false;
    let graphSettingsTouched = false;
    let taskEditTouched = false;
    let contextEditTouched = false;
    let memoryImportanceTouched = false;
    let handoffEditTouched = false;
    let lastTasks = [];
    let lastState = null;
    let selectedLiveTaskId = '';
    let graphAnim = null;
    let selectedGraphPath = '';
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

    async function api(path, options = {}) {
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
          liveTasks: (state.liveTasks || []).map(item => [item.task.id, item.task.updatedAt, item.sessionState && item.sessionState.updatedAt, item.handoff && item.handoff.id, item.compiledContext].join(':')).join('|'),
          repoMemories: (state.repoMemories || []).map(m => m.id + m.updatedAt).join('|'),
          repoMemoryCandidates: (state.repoMemoryCandidates || []).map(c => c.id + c.status).join('|'),
          memories: state.memories.map(m => m.id + m.updatedAt).join('|'),
          compiledContextLength: (state.compiledContext || '').length,
          handoff: state.handoff && state.handoff.id,
          tools: (state.optionalTools || []).map(t => t.name + t.installed).join('|'),
          tokenStack: (state.tokenStack || []).map(t => t.id + t.enabled + t.installed).join('|'),
          graphStats: JSON.stringify(state.graphStats || {}),
          optimizeStats: JSON.stringify(state.optimizeStats || {}),
          work: JSON.stringify({
            lanes: state.taskLanes || [],
            leases: state.fileLeases || [],
            changes: state.taskChanges || [],
            requests: state.agentRequests || [],
            agents: state.registeredAgents || []
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
      const repoMemoryHtml = state.repoMemories?.length ? state.repoMemories.map(renderMemory).join('') : '<div class="muted">No saved repository facts yet. Add one above with scope “Repository shared”.</div>';
      els.repoMemories.innerHTML = graphKnowledge + repoMemoryHtml;
      els.repoMemoryCandidates.innerHTML = state.repoMemoryCandidates?.length
        ? state.repoMemoryCandidates.map(renderMemoryCandidate).join('')
        : '<div class="muted">Inbox is clear. Session discoveries that look repository-wide will appear here for review.</div>';
      const activeHandoff = selected?.handoff || state.handoff;
      els.handoff.innerHTML = activeHandoff ? renderHandoff(activeHandoff) : '<div class="muted">No handoff yet.</div>';
      populateLatestHandoffEditor(activeHandoff, current?.id || state.currentTask?.id || '');
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
        els.graphIncludePaths.value = (g.includePaths || []).join('\\n');
        els.graphIgnorePaths.value = (g.ignorePaths || []).join('\\n');
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
        '<div class="muted" style="margin-top:8px">Cacheable: ' + escapeHtml(String(stats.cacheableTokens)) + ' tokens.</div>';
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
      const taskSession = (entry.sessions || []).find(session => session.agent === task.ownerAgent) || (entry.sessions || [])[0] || {};
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
      if (previous && Array.from(select.options).some(option => option.value === previous)) select.value = previous;
    }


    function renderWorkforceState(state) {
      const agents = state.registeredAgents || [];
      els.workforceAgents.innerHTML = agents.length ? agents.map(agent => {
        const caps = (agent.capabilities || []).slice(0, 4).map(item => '<span class="tag">' + escapeHtml(item) + '</span>').join('');
        return '<div class="card"><div class="toolbar" style="justify-content:space-between"><strong>' + escapeHtml(agent.name) + '</strong><span class="pill ' + (agent.enabled ? 'ok' : 'warn') + '">' + (agent.enabled ? 'enabled' : 'disabled') + '</span></div>' +
          '<div class="meta">' + escapeHtml(agent.provider) + ' | ' + escapeHtml(agent.mode) + (agent.model ? ' | ' + escapeHtml(agent.model) : '') + '</div>' +
          '<div>' + caps + '</div><div class="toolbar" style="margin-top:8px">' +
          '<button class="ghost agent-toggle" data-agent-id="' + escapeHtml(agent.id) + '" data-enabled="' + (agent.enabled ? 'false' : 'true') + '" type="button">' + (agent.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="ghost agent-edit" data-agent-id="' + escapeHtml(agent.id) + '" data-agent-name="' + escapeHtml(agent.name) + '" data-agent-provider="' + escapeHtml(agent.provider) + '" data-agent-mode="' + escapeHtml(agent.mode) + '" data-agent-command="' + escapeHtml(agent.command || '') + '" data-agent-base-url="' + escapeHtml(agent.baseUrl || '') + '" data-agent-model="' + escapeHtml(agent.model || '') + '" data-agent-reasoning="' + escapeHtml(agent.reasoningEffort || '') + '" data-agent-credential="' + escapeHtml(agent.credentialRef || '') + '" data-agent-capabilities="' + escapeHtml((agent.capabilities || []).join(',')) + '" type="button">Edit</button>' +
          '<button class="ghost agent-delete" data-agent-id="' + escapeHtml(agent.id) + '" data-agent-name="' + escapeHtml(agent.name) + '" type="button">Delete</button>' +
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
      return String(diff || '').split('\\n').map(line => {
        const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff --git')
          ? ' meta'
          : line.startsWith('+')
            ? ' add'
            : line.startsWith('-')
              ? ' del'
              : '';
        return '<span class="git-diff-line' + cls + '">' + escapeHtml(line || ' ') + '</span>';
      }).join('\\n');
    }

    function renderLease(lease) {
      return '<div class="card" data-lease-card="' + escapeHtml(lease.id) + '"><div class="toolbar" style="justify-content:space-between"><code class="meta">' + escapeHtml(lease.path) + '</code><span class="pill ok">' + escapeHtml(lease.mode) + '</span></div>' +
        '<div class="meta">' + escapeHtml(lease.agent || 'unknown') + ' | expires ' + escapeHtml(lease.expiresAt) + '</div>' +
        '<div class="toolbar"><button class="ghost release-lease" data-lease-id="' + escapeHtml(lease.id) + '" data-task-id="' + escapeHtml(lease.taskId || '') + '" type="button">Release</button></div></div>';
    }

    function renderAgentRequest(request, options = {}) {
      const task = lastTasks.find(item => item.id === request.taskId);
      return '<div class="card request-card candidate-row" data-request-id="' + escapeHtml(request.id) + '">' +
        '<div class="toolbar" style="justify-content:space-between;align-items:flex-start"><div><strong>' + escapeHtml(request.title) + '</strong>' +
        '<div class="meta">' + escapeHtml(request.agent || 'unknown') + ' | ' + escapeHtml(request.status) + (task ? ' | ' + escapeHtml(task.title) : '') + '</div></div>' +
        '<span class="toolbar" style="align-items:flex-start"><span class="pill warn">' + escapeHtml(request.type) + '</span>' +
        '<button class="ghost request-delete" data-request-id="' + escapeHtml(request.id) + '" type="button" aria-label="Delete notification" title="Delete notification">×</button></span></div></div>';
    }

    function syncRequestToasts(requests) {
      if (!els.requestToastStack) return;
      const pendingIds = new Set((requests || []).filter(request => request.taskId).map(request => request.id));
      Array.from(els.requestToastStack.querySelectorAll('.request-toast')).forEach(toast => {
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
        '<div class="request-toast-meta">' + escapeHtml(request.agent || 'unknown') + ' | ' + escapeHtml(request.type || 'request') + (task ? ' | ' + escapeHtml(task.title) : '') + '</div>';
      els.requestToastStack.appendChild(toast);
      requestToastTimers.set(request.id, window.setTimeout(() => closeRequestToast(request.id), 15000));
    }

    function closeRequestToast(requestId) {
      if (!requestId || !els.requestToastStack) return;
      const timer = requestToastTimers.get(requestId);
      if (timer) window.clearTimeout(timer);
      requestToastTimers.delete(requestId);
      const toast = els.requestToastStack.querySelector('.request-toast[data-request-id="' + cssEscape(requestId) + '"]');
      if (toast) toast.remove();
    }

    function closeRunToast(runId) {
      if (!runId || !els.requestToastStack) return;
      const timer = runToastTimers.get(runId);
      if (timer) window.clearTimeout(timer);
      runToastTimers.delete(runId);
      const toast = els.requestToastStack.querySelector('.run-toast[data-run-id="' + cssEscape(runId) + '"]');
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
      selectedLiveTaskId = taskId;
      contextEditTouched = false;
      activateView('overview');
      if (lastState) renderState(lastState);
      syncLiveTaskCarousel(true);
    }

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
      return String(value).replace(/["\\\\]/g, '\\\\$&');
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
        if (Array.from(select.options).some(option => option.value === wanted)) select.value = wanted;
      });
    }

    function populateSessionTaskSelect(tasks, currentId) {
      const selectable = tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled');
      const wanted = els.sessionTaskId.value || currentId || '';
      els.sessionTaskId.innerHTML = selectable.map(task => '<option value="' + escapeHtml(task.id) + '">' + escapeHtml(task.title) + '</option>').join('') || '<option value="">No active task</option>';
      if (Array.from(els.sessionTaskId.options).some(option => option.value === wanted)) els.sessionTaskId.value = wanted;
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

    function renderSessionState(memory) {
      if (!memory) return '<div class="muted">No latest response captured yet.</div>';
      const content = String(memory.content || '').replace(/^(?:claude|codex|antigravity|generic) latest response:\s*/i, '');
      return '<div class="memory-row"><div class="meta">latest response | importance ' + memory.importance + ' | ' + escapeHtml(memory.sourceAgent || 'unknown') + '</div>' +
        '<div class="memory-content">' + escapeHtml(content) + '</div></div>';
    }

    function renderHandoff(handoff) {
      return '<div class="card"><div class="meta">' + escapeHtml(handoff.fromAgent || 'unknown') + ' -> ' + escapeHtml(handoff.toAgent || 'unknown') + '</div>' +
        '<strong>' + escapeHtml(handoff.summary) + '</strong>' +
        '<div class="meta" style="margin-top:8px">Next: ' + escapeHtml((handoff.next || []).join(', ') || 'None recorded') + '</div>' +
        '<div class="meta">Risks: ' + escapeHtml((handoff.risks || []).join(', ') || 'None recorded') + '</div></div>';
    }

    function populateLatestHandoffEditor(handoff, taskId) {
      if (handoffEditTouched && document.activeElement && els.latestHandoffForm.contains(document.activeElement)) return;
      const joinList = value => (value || []).join('\\n');
      els.latestHandoffId.value = handoff?.id || '';
      els.latestHandoffTaskId.value = handoff?.taskId || taskId || '';
      els.latestHandoffFrom.value = handoff?.fromAgent || '';
      els.latestHandoffTo.value = handoff?.toAgent || '';
      els.latestHandoffSummary.value = handoff?.summary || '';
      els.latestHandoffDone.value = joinList(handoff?.done);
      els.latestHandoffNext.value = joinList(handoff?.next);
      els.latestHandoffRisks.value = joinList(handoff?.risks);
      els.latestHandoffFilesChanged.value = joinList(handoff?.filesChanged);
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
      const element = document.getElementById(id);
      if (element) element.addEventListener(type, handler);
    }

    function onElement(element, type, handler) {
      if (element) element.addEventListener(type, handler);
    }

    function bindForm(id, path, options = {}) {
      const formElement = document.getElementById(id);
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
    bindForm('handoffForm', '/api/handoff/create');
    bindForm('latestHandoffEditForm', '/api/handoff/update', { reset: false, onSuccess: () => { handoffEditTouched = false; } });
    onElement(els.latestHandoffForm, 'input', () => { handoffEditTouched = true; });
    bindForm('laneForm', '/api/orchestration/lane', { reset: false });
    // Provider -> CLI command. Keep this initialized before syncAgentSetupMode()
    // is first called below. The catalog response later replaces these seeds.
    let providerCommands = { codex: 'codex', claude: 'claude', antigravity: 'agy', gemini: 'gemini' };

    function syncAgentSetupMode() {
      const form = document.getElementById('workforceAgentForm');
      if (!form) return;
      const mode = els.workforceAgentMode?.value || 'cli';
      form.querySelectorAll('[data-mode-field]').forEach(field => {
        const visible = field.dataset.modeField === mode;
        field.style.display = visible ? '' : 'none';
        field.querySelectorAll('input, select, textarea').forEach(input => {
          input.disabled = !visible;
          if (!visible) input.value = '';
        });
      });
      // Switching back to cli leaves Command blank (cleared above while it was
      // hidden), so put the provider's binary back in it.
      if (mode === 'cli') syncAgentCommandDefault();
    }

    function resetAgentForm() {
      const form = document.getElementById('workforceAgentForm');
      if (form) form.reset();
      if (els.workforceAgentId) els.workforceAgentId.value = '';
      if (els.workforceAgentSubmit) els.workforceAgentSubmit.textContent = 'Add Agent';
      if (els.workforceAgentCancelEdit) els.workforceAgentCancelEdit.style.display = 'none';
      syncAgentSetupMode();
    }
    on('workforceAgentForm', 'submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const agentId = els.workforceAgentId ? els.workforceAgentId.value : '';
      const path = agentId ? '/api/workforce/agent/update' : '/api/workforce/agent';
      await api(path, { method: 'POST', body: JSON.stringify(formData(form)) });
      resetAgentForm();
      await load(true);
    });
    on('workforceAgentCancelEdit', 'click', resetAgentForm);
    onElement(els.workforceAgentMode, 'change', syncAgentSetupMode);
    // Wired here rather than only in loadOrchestratorCatalog so the command
    // prefill still works if the catalog request fails — the seed map in
    // providerCommands covers the CLI providers either way.
    onElement(document.getElementById('workforceAgentProvider'), 'change', syncAgentCommandDefault);
    syncAgentSetupMode();

    function selectedLiveEntry(taskId) {
      return (lastState?.liveTasks || []).find(item => item.task.id === taskId);
    }

    function liveTaskCards() {
      return Array.from(els.liveTasks?.querySelectorAll('.live-task-card') || []);
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
      const card = event.target.closest && event.target.closest('.live-task-card');
      if (!card) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectLiveTask(card.dataset.taskId || '', true);
      }
    });

    document.addEventListener('click', async event => {
      const release = event.target.closest && event.target.closest('.release-lease');
      if (release) {
        const taskId = release.dataset.taskId || selectedLiveTaskId;
        const leaseId = release.dataset.leaseId || '';
        release.disabled = true;
        release.textContent = 'Releasing...';
        els.refreshPill.textContent = 'Releasing lease...';
        els.refreshPill.className = 'pill';
        try {
          await api('/api/orchestration/lease/release', { method: 'POST', body: JSON.stringify({ leaseId }) });
          const card = leaseId ? document.querySelector('[data-lease-card="' + cssEscape(leaseId) + '"]') : null;
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
      const openWorkGit = event.target.closest && event.target.closest('.open-workgit');
      if (openWorkGit) {
        openWorkGitDetail(openWorkGit.dataset.taskId || '');
        return;
      }
      const openTaskWindow = event.target.closest && event.target.closest('.open-task-window');
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
      const openToken = event.target.closest && event.target.closest('.open-token');
      if (openToken) {
        openTokenDetail(openToken.dataset.taskId || '');
        return;
      }
      const agentToggle = event.target.closest && event.target.closest('.agent-toggle');
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
      const agentEdit = event.target.closest && event.target.closest('.agent-edit');
      if (agentEdit) {
        const form = document.getElementById('workforceAgentForm');
        if (form && els.workforceAgentId) {
          form.elements.name.value = agentEdit.dataset.agentName || '';
          form.elements.provider.value = agentEdit.dataset.agentProvider || 'codex';
          form.elements.mode.value = agentEdit.dataset.agentMode || 'cli';
          form.elements.command.value = agentEdit.dataset.agentCommand || '';
          form.elements.baseUrl.value = agentEdit.dataset.agentBaseUrl || '';
          form.elements.model.value = agentEdit.dataset.agentModel || '';
          form.elements.reasoningEffort.value = agentEdit.dataset.agentReasoning || '';
          form.elements.credentialRef.value = agentEdit.dataset.agentCredential || '';
          form.elements.capabilities.value = agentEdit.dataset.agentCapabilities || '';
          els.workforceAgentId.value = agentEdit.dataset.agentId || '';
          if (els.workforceAgentSubmit) els.workforceAgentSubmit.textContent = 'Update Agent';
          if (els.workforceAgentCancelEdit) els.workforceAgentCancelEdit.style.display = '';
          syncAgentSetupMode();
          // Re-applied after the mode sync: what this agent is actually
          // registered with wins over the provider's default command.
          form.elements.command.value = agentEdit.dataset.agentCommand || '';
          // The form lives in the Orchestrator tab's Agents pane now.
          selectOrchestratorFormTab('agents');
          form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return;
      }
      const agentDelete = event.target.closest && event.target.closest('.agent-delete');
      if (agentDelete) {
        const confirmed = confirm('Delete agent "' + agentDelete.dataset.agentName + '"? Historical assignments/runs keep referencing it by id.');
        if (!confirmed) return;
        agentDelete.disabled = true;
        try {
          await api('/api/workforce/agent/delete', { method: 'POST', body: JSON.stringify({ agentId: agentDelete.dataset.agentId }) });
          await load(true);
        } finally {
          agentDelete.disabled = false;
        }
        return;
      }
      const toastClose = event.target.closest && event.target.closest('.request-toast-close');
      if (toastClose) {
        const toast = toastClose.closest('.request-toast');
        if (toast?.classList.contains('run-toast')) {
          closeRunToast(toast.dataset.runId || '');
          return;
        }
        closeRequestToast(toast?.dataset.requestId || '');
        return;
      }
      const requestToast = event.target.closest && event.target.closest('.request-toast');
      if (requestToast) {
        if (requestToast.classList.contains('run-toast')) {
          closeRunToast(requestToast.dataset.runId || '');
          runsFilter = 'cycle';
          document.querySelectorAll('[data-runs-filter]').forEach(button => {
            button.classList.toggle('active', button.dataset.runsFilter === runsFilter);
          });
          activateView('orchestrator');
          await refreshOrchestratorBoard();
          return;
        }
        openRequestToastTask(requestToast.dataset.taskId || '', requestToast.dataset.requestId || '');
        return;
      }
      const liveTaskCard = event.target.closest && event.target.closest('.live-task-card');
      if (liveTaskCard && !event.target.closest('button, input, textarea, select, a')) {
        selectLiveTask(liveTaskCard.dataset.taskId || '', true);
        return;
      }
      const requestDelete = event.target.closest && event.target.closest('.request-delete');
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
      const requestClearTask = event.target.closest && event.target.closest('.request-clear-task');
      if (requestClearTask) {
        const container = requestClearTask.closest('.task-card-panel');
        const ids = container ? Array.from(container.querySelectorAll('.request-card[data-request-id]')).map(card => card.dataset.requestId) : [];
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
      const approvalsClear = event.target.closest && event.target.closest('#workforceApprovalsClear');
      if (approvalsClear) {
        const ids = Array.from(els.workforceApprovals ? els.workforceApprovals.querySelectorAll('.request-card[data-request-id]') : []).map(card => card.dataset.requestId);
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

    document.querySelectorAll('.session-action').forEach(button => {
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
      const button = els.optRunButton || document.getElementById('optRunButton');
      button.disabled = true;
      els.optStatus.textContent = 'Reading repo-map files and measuring…';
      try {
        const body = {};
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
      const button = document.querySelector('.nav button[data-view="' + view + '"]');
      const panel = document.getElementById('view-' + view);
      if (!button || !panel) return;
      document.querySelectorAll('.nav button').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.view').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      panel.classList.add('active');
      if (view === 'graph' && !graphLoaded) loadGraph();
      if (view === 'orchestrator') { loadOrchestratorCatalog(); refreshOrchestratorBoard(); }
      if (view === 'workforce') loadOrchestratorCatalog();
    }

    document.querySelectorAll('.nav button').forEach(button => {
      button.addEventListener('click', () => activateView(button.dataset.view));
    });

    let orchestratorCatalogs = [];
    let orchestratorCatalogLoaded = false;
    let currentOrchestrationTeamProviders;
    const START_TEAM_PROVIDERS_KEY = 'agent-bridge:team-providers:start';

    function changeTeamProvidersKey(taskId) {
      return 'agent-bridge:team-providers:change:' + taskId;
    }

    function readTeamProviderSelection(key) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : undefined;
      } catch (_) {
        return undefined;
      }
    }

    function writeTeamProviderSelection(key, providers) {
      try { localStorage.setItem(key, JSON.stringify(providers)); } catch (_) { /* storage may be disabled */ }
    }

    function providerValuesIn(container) {
      return Array.prototype.slice.call(container.querySelectorAll('input[name="teamProviders"]'))
        .filter(box => box.checked)
        .map(box => box.value);
    }

    function applyTeamProviderSelection(id, selected) {
      document.querySelectorAll('#' + id + ' input[name="teamProviders"]').forEach(box => {
        box.checked = !selected || selected.includes(box.value);
      });
    }

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
      const picker = document.getElementById('orchestratorPicker');
      if (!picker) return;
      const list = orchestrations || [];
      if (!list.length) {
        picker.innerHTML = '<option value="">No orchestrations yet</option>';
        return;
      }
      picker.innerHTML = list.map(item => {
        const title = (item.taskTitle || item.taskId || '').split('\\n')[0].slice(0, 70);
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
      providerSelect.innerHTML = orchestratorCatalogs.map(catalog =>
        '<option value="' + escapeHtml(catalog.provider) + '">' + escapeHtml(catalog.provider) + '</option>'
      ).join('');
      const sync = () => {
        const catalog = orchestratorCatalogs.find(item => item.provider === providerSelect.value);
        populateModelSelect(modelSelect, catalog);
        populateReasoningSelect(reasoningSelect, catalog);
      };
      providerSelect.addEventListener('change', sync);
      sync();
    }

    // Unlike wireProviderTriplet (which owns the provider <select> itself),
    // the Agent Registry's provider select already has a fixed option list
    // that includes non-catalog providers (deepseek, manual, generic, ...) —
    // this only keeps the CLI model datalist and reasoning options in sync
    // with whichever catalog-backed provider is currently selected.
    function syncAgentModelCatalog() {
      const providerSelect = document.getElementById('workforceAgentProvider');
      const datalist = document.getElementById('workforceCliModels');
      if (!providerSelect || !datalist) return;
      const catalog = orchestratorCatalogs.find(item => item.provider === providerSelect.value);
      datalist.innerHTML = (catalog ? catalog.models : []).map(model =>
        '<option value="' + escapeHtml(model.value) + '" label="' + escapeHtml(model.label) + '">'
      ).join('');
      populateReasoningSelect(document.getElementById('workforceAgentReasoning'), catalog);
      syncAgentCommandDefault();
    }

    // Prefills Command with the CLI binary the selected provider actually
    // launches — antigravity is "agy", not "antigravity", which is the single
    // most common way to register an agent that can never spawn.
    //
    // Only fills a field that is empty or still holds another provider's
    // default: a command the user typed (a wrapper script, an absolute path)
    // survives a provider change, and so does the command loaded by Edit.
    function syncAgentCommandDefault() {
      const form = document.getElementById('workforceAgentForm');
      const providerSelect = document.getElementById('workforceAgentProvider');
      if (!form || !providerSelect) return;
      const field = form.querySelector('[data-mode-field="cli"] input[name="command"]');
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

    // Every installed CLI provider, ticked by default: an all-one-provider team
    // is exactly what this is meant to avoid, so opting a provider out is a
    // deliberate act rather than the starting position. A provider that is
    // installed but cannot answer headlessly (a CLI that only drives a GUI) is
    // shown disabled with the reason, rather than hidden — the user installed
    // it and would otherwise just wonder where it went.
    function renderTeamProviders(installed) {
      const entries = (installed && installed.length)
        ? installed.map(entry => (typeof entry === 'string' ? { provider: entry, staffable: true } : entry))
        : orchestratorCatalogs.map(catalog => ({ provider: catalog.provider, staffable: catalog.headless !== false }));
      const renderInto = (id, selected) => {
        const wrap = document.getElementById(id);
        if (!wrap) return;
        if (!entries.length) {
          wrap.innerHTML = '<span class="meta">No agent CLI found on PATH; the leader will use whatever agents are registered.</span>';
          return;
        }
        wrap.innerHTML = entries.map(entry => {
          if (entry.staffable === false) {
            return '<label style="display:inline-flex; align-items:center; gap:6px; opacity:0.55" ' +
              'title="Installed, but it answers inside its own window instead of on stdout, so the orchestrator cannot read the reply back. Register it as a manual agent and drive it by hand.">' +
              '<input type="checkbox" disabled style="width:auto; margin:0">' +
              escapeHtml(entry.provider) + ' <span class="meta">(manual only)</span></label>';
          }
          const checked = !selected || selected.includes(entry.provider) ? ' checked' : '';
          return '<label style="display:inline-flex; align-items:center; gap:6px; font-weight:500">' +
            '<input type="checkbox" name="teamProviders" value="' + escapeHtml(entry.provider) + '"' + checked + ' style="width:auto; margin:0">' +
            escapeHtml(entry.provider) + '</label>';
        }).join('');
      };
      renderInto('orchestratorTeamProviders', readTeamProviderSelection(START_TEAM_PROVIDERS_KEY));
      const taskId = currentOrchestratorTaskId();
      const savedChangeProviders = taskId ? readTeamProviderSelection(changeTeamProvidersKey(taskId)) : undefined;
      renderInto('orchestratorChangeTeamProviders', savedChangeProviders ?? currentOrchestrationTeamProviders);
    }

    onElement(document.getElementById('orchestratorTeamProviders'), 'change', event => {
      if (!event.target.matches('input[name="teamProviders"]')) return;
      writeTeamProviderSelection(START_TEAM_PROVIDERS_KEY, providerValuesIn(event.currentTarget));
    });
    onElement(document.getElementById('orchestratorChangeTeamProviders'), 'change', event => {
      if (!event.target.matches('input[name="teamProviders"]')) return;
      const taskId = currentOrchestratorTaskId();
      if (taskId) writeTeamProviderSelection(changeTeamProvidersKey(taskId), providerValuesIn(event.currentTarget));
    });

    async function loadOrchestratorCatalog() {
      if (orchestratorCatalogLoaded) return;
      try {
        const data = await api('/api/workforce/catalog');
        orchestratorCatalogs = data.catalogs || [];
        if (data.defaultCommands) providerCommands = data.defaultCommands;
        orchestratorCatalogLoaded = true;
        renderTeamProviders(data.installed || []);
        wireProviderTriplet(
          document.getElementById('orchestratorLeaderProvider'),
          document.getElementById('orchestratorLeaderModel'),
          document.getElementById('orchestratorLeaderReasoning')
        );
        wireProviderTriplet(
          document.getElementById('orchestratorSubtaskProvider'),
          document.getElementById('orchestratorSubtaskModel'),
          document.getElementById('orchestratorSubtaskReasoning')
        );
        onElement(document.getElementById('workforceAgentProvider'), 'change', syncAgentModelCatalog);
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
      const progress = run.progressPercent != null ? run.progressPercent + '%' : '';
      const originTag = run.origin === 'adopted' ? '<span class="tag">adopted</span>' : '';
      const statusClass = run.status === 'failed' ? 'warn' : (run.status === 'done' ? 'ok' : '');
      const isActive = isRunActive(run);
      const cardClass = isActive ? 'is-running' : (run.status === 'failed' ? 'is-failed' : 'is-done');
      const logTail = run.logTail || '';
      return '<div class="card run-card ' + cardClass + '" data-run-id="' + escapeHtml(run.id) + '">' +
        '<div class="toolbar" style="justify-content:space-between"><strong>' +
        (isActive ? '<span class="run-live-dot"></span>' : '') + escapeHtml(agentName) +
        '</strong><span class="pill ' + statusClass + '">' + escapeHtml(run.status) + '</span></div>' +
        '<div class="meta">' + escapeHtml(run.phase || '') + (modelLabel ? ' · ' + escapeHtml(modelLabel) : '') + (progress ? ' · ' + escapeHtml(progress) : '') +
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
        (subtask.goal ? '<div class="meta">' + escapeHtml(subtask.goal) + '</div>' : '') + '</div>';
    }

    function renderOrchestratorReview(review) {
      const verdictClass = review.verdict === 'pass' ? 'ok' : (review.verdict === 'block' ? 'warn' : '');
      return '<div class="card"><div class="toolbar" style="justify-content:space-between"><span class="pill ' + verdictClass + '">' + escapeHtml(review.verdict) + '</span>' +
        (review.score != null ? '<span class="meta">' + escapeHtml(String(review.score)) + '</span>' : '') + '</div>' +
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
      const grid = document.getElementById('orchestratorRuns');
      const prev = document.getElementById('orchestratorRunsPrev');
      const next = document.getElementById('orchestratorRunsNext');
      if (!grid || !prev || !next) return;
      const maxScroll = grid.scrollWidth - grid.clientWidth;
      // Disabled arrows stay hidden even on hover, so a board that fits in one
      // page shows no chrome at all.
      prev.disabled = grid.scrollLeft <= 1;
      next.disabled = grid.scrollLeft >= maxScroll - 1;
    }

    function scrollRunsByPage(direction) {
      const grid = document.getElementById('orchestratorRuns');
      if (!grid) return;
      grid.scrollBy({ left: direction * grid.clientWidth, behavior: 'smooth' });
    }

    function renderRunsBoard(runs, agentsById) {
      const grid = document.getElementById('orchestratorRuns');
      if (!grid) return;
      // The board re-renders on every poll. Remember where the user had
      // scrolled the page strip and each log, so a refresh mid-read doesn't
      // yank them back to the start.
      const previousScrollLeft = grid.scrollLeft;
      const logScroll = {};
      grid.querySelectorAll('[data-run-log]').forEach(pre => {
        logScroll[pre.dataset.runLog] = { top: pre.scrollTop, atBottom: pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24 };
      });

      grid.innerHTML = runs.length
        ? runs.map(run => renderOrchestratorRun(run, agentsById)).join('')
        : '<div class="muted">No runs yet.</div>';

      grid.querySelectorAll('[data-run-log]').forEach(pre => {
        const remembered = logScroll[pre.dataset.runLog];
        // New cards and logs the user was already reading at the bottom follow
        // the live output; anything scrolled back stays put.
        pre.scrollTop = !remembered || remembered.atBottom ? pre.scrollHeight : remembered.top;
      });
      grid.scrollLeft = Math.min(previousScrollLeft, Math.max(0, grid.scrollWidth - grid.clientWidth));
      updateRunsCarousel();
    }

    function renderAdoptablePanel(sessions) {
      const el = document.getElementById('orchestratorAdoptable');
      if (!el) return;
      el.innerHTML = sessions.length ? sessions.map(renderAdoptableSession).join('') : '<div class="muted">No external sessions waiting to be adopted.</div>';
    }

    async function refreshOrchestratorBoard() {
      const summaryEl = document.getElementById('orchestratorSummary');
      if (!summaryEl) return;
      const taskId = currentOrchestratorTaskId();
      try {
        const data = await api('/api/workforce/board?task=' + encodeURIComponent(taskId) +
          (runsFilter === 'all' ? '&runs=all' : ''));
        renderOrchestratorPicker(data.orchestrations, data.orchestration && data.orchestration.taskId);
        if (!data.orchestration) {
          summaryEl.textContent = 'No orchestrations yet. Start one with the form on the left.';
          document.getElementById('orchestratorRuns').innerHTML = '';
          document.getElementById('orchestratorSubtasks').innerHTML = '';
          document.getElementById('orchestratorReviews').innerHTML = '';
          document.getElementById('orchestratorEvents').innerHTML = '';
          renderAdoptablePanel([]);
          return;
        }
        const orchestration = data.orchestration;
        currentOrchestrationTeamProviders = orchestration.teamProviders && orchestration.teamProviders.length
          ? orchestration.teamProviders
          : undefined;
        // Keep every action button (Step/Pause/Stop/…) pointed at whatever is
        // actually on screen, not at a stale active task.
        selectedOrchestrationTaskId = orchestration.taskId;
        const savedChangeProviders = readTeamProviderSelection(changeTeamProvidersKey(orchestration.taskId));
        applyTeamProviderSelection(
          'orchestratorChangeTeamProviders',
          savedChangeProviders ?? currentOrchestrationTeamProviders
        );
        renderAutoRunButton(Boolean(data.autoRun));
        renderPauseToggle(orchestration.status);
        renderLeaderQuestions(data.questions || []);
        renderSpawnApprovals(data.approvals || []);
        const heading = data.taskTitle
          ? '<div><strong>' + escapeHtml(String(data.taskTitle).split('\\n')[0].slice(0, 90)) + '</strong></div>'
          : '';
        const fellBack = data.fellBackFromTaskId
          ? '<div class="muted">Active task has no orchestration; showing the most recent one.</div>'
          : '';
        summaryEl.innerHTML = heading + fellBack +
          'status: <strong>' + escapeHtml(orchestration.status) + '</strong> · cycle ' +
          escapeHtml(String(orchestration.cycle)) + '/' + escapeHtml(String(orchestration.maxCycles)) +
          (orchestration.complexity ? ' · ' + escapeHtml(orchestration.complexity) : '') +
          ((orchestration.teamProviders && orchestration.teamProviders.length)
            ? ' · providers: ' + escapeHtml(orchestration.teamProviders.join(', '))
            : '') +
          (orchestration.lastError ? ' · <span class="error">' + escapeHtml(orchestration.lastError) + '</span>' : '') +
          // "reporting" is a dead end for Step — say so instead of letting the
          // user click it over and over.
          (orchestration.status === 'reporting'
            ? '<div class="muted">Work is done; Step cannot advance past this. Click <strong>Generate report</strong> to finish the orchestration.</div>'
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
        const countEl = document.getElementById('orchestratorRunsCount');
        if (countEl) countEl.textContent = shownRuns.length === totalRuns
          ? totalRuns + ' run(s)'
          : shownRuns.length + ' of ' + totalRuns;
        renderRunsBoard(shownRuns, agentsById);
        const subtasks = sortNewestFirst(data.subtasks || []);
        document.getElementById('orchestratorSubtasks').innerHTML = subtasks.length
          ? subtasks.map(renderOrchestratorSubtask).join('')
          : '<div class="muted">No subtasks yet.</div>';
        const reviews = sortNewestFirst(data.reviews || []);
        document.getElementById('orchestratorReviews').innerHTML = reviews.length
          ? reviews.map(renderOrchestratorReview).join('')
          : '<div class="muted">No reviews yet.</div>';
        const events = data.events || [];
        document.getElementById('orchestratorEvents').innerHTML = events.length
          ? events.map(renderOrchestratorEvent).join('')
          : '<div class="muted">No activity yet.</div>';
        renderAdoptablePanel(data.adoptable || []);
      } catch (error) {
        summaryEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
      }
    }

    function checkedTeamProviders(form) {
      const boxes = Array.prototype.slice.call(form.querySelectorAll('input[name="teamProviders"]'));
      if (!boxes.length) return undefined;
      const checked = boxes.filter(box => box.checked).map(box => box.value);
      if (!checked.length) throw new Error('Pick at least one team provider.');
      return checked;
    }

    function selectedTeamProviders(form) {
      const checked = checkedTeamProviders(form);
      if (!checked) return undefined;
      const boxes = Array.prototype.slice.call(form.querySelectorAll('input[name="teamProviders"]'));
      return checked.length === boxes.length ? undefined : checked;
    }

    on('orchestratorStartForm', 'submit', async event => {
      event.preventDefault();
      const form = event.target;
      const statusEl = document.getElementById('orchestratorStartStatus');
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
          // Omitted entirely when every box is ticked: "no restriction" and
          // "all of them" mean the same thing, and storing nothing keeps the
          // orchestration open to a provider registered later.
          teamProviders: selectedTeamProviders(form)
        };
        const data = await api('/api/workforce/orchestration/start', { method: 'POST', body: JSON.stringify(body) });
        statusEl.textContent = data.summary || 'Started.';
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
      document.querySelectorAll('[data-orch-tab]').forEach(button => {
        button.classList.toggle('active', button.dataset.orchTab === name);
      });
      document.querySelectorAll('[data-orch-panel]').forEach(panel => {
        panel.hidden = panel.dataset.orchPanel !== name;
      });
    }

    document.querySelectorAll('[data-orch-tab]').forEach(button => {
      onElement(button, 'click', () => selectOrchestratorFormTab(button.dataset.orchTab));
    });

    document.querySelectorAll('[data-runs-filter]').forEach(button => {
      onElement(button, 'click', () => {
        runsFilter = button.dataset.runsFilter;
        document.querySelectorAll('[data-runs-filter]').forEach(other => {
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
      const value = String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
      return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value;
    }

    function renderSpawnApprovals(approvals) {
      const panel = document.getElementById('orchestratorApprovals');
      const list = document.getElementById('orchestratorApprovalList');
      if (!panel || !list) return;
      panel.hidden = !approvals.length;
      if (!approvals.length) {
        list.innerHTML = '';
        return;
      }
      list.innerHTML = approvals.map(approval =>
        '<div class="card" style="display:flex; gap:10px; align-items:center; justify-content:space-between">' +
        '<span style="min-width:0">' + escapeHtml(approval.title) + '</span>' +
        '<span class="toolbar" style="flex:0 0 auto">' +
        '<button type="button" class="secondary approve-spawn" data-request-id="' + escapeHtml(approval.id) + '">Approve</button>' +
        '<button type="button" class="ghost reject-spawn" data-request-id="' + escapeHtml(approval.id) + '" style="color:var(--red)">Reject</button>' +
        '</span></div>'
      ).join('');
    }

    on('orchestratorApprovalList', 'click', async event => {
      const button = event.target.closest('.approve-spawn, .reject-spawn');
      if (!button) return;
      const taskId = currentOrchestratorTaskId();
      const statusEl = document.getElementById('orchestratorApprovalStatus');
      if (!taskId) return;
      const approve = button.classList.contains('approve-spawn');
      button.disabled = true;
      statusEl.textContent = approve ? 'Approving…' : 'Rejecting…';
      try {
        const result = await api('/api/workforce/orchestration/approve-spawn', {
          method: 'POST',
          body: JSON.stringify({ taskId, requestId: button.dataset.requestId, approve })
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
      const panel = document.getElementById('orchestratorQuestions');
      const list = document.getElementById('orchestratorQuestionList');
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
      document.querySelectorAll('#orchestratorQuestionList [data-needs-other]').forEach(field => {
        const id = field.dataset.questionId;
        const selected = document.querySelector('[data-option-for="' + CSS.escape(id) + '"]:checked');
        field.hidden = Boolean(selected && selected.value);
      });
    }

    on('orchestratorQuestionList', 'change', event => {
      if (event.target && event.target.dataset && event.target.dataset.optionFor) syncQuestionOtherFields();
    });

    async function submitLeaderAnswers(dismiss) {
      const taskId = currentOrchestratorTaskId();
      const statusEl = document.getElementById('orchestratorQuestionStatus');
      if (!taskId) return;
      const answers = [];
      const answered = new Set();
      document.querySelectorAll('#orchestratorQuestionList [data-option-for]:checked').forEach(radio => {
        if (!radio.value) return; // "Something else…" defers to the textarea below
        answers.push({ id: radio.dataset.optionFor, answer: radio.value });
        answered.add(radio.dataset.optionFor);
      });
      document.querySelectorAll('#orchestratorQuestionList [data-question-id]').forEach(field => {
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
      if (!confirm('Skip these questions?\\n\\nThe leader will plan using its own assumptions instead.')) return;
      submitLeaderAnswers(true);
    });

    // Auto-run lives in the server process, so the button only reflects state
    // the board reports back — never a local flag that a reload would lose.
    function renderAutoRunButton(active) {
      const button = document.getElementById('orchestratorAutoRunButton');
      if (!button) return;
      // Say what a click does now, not just what the state is: while it is on,
      // the only thing this button can do is stop the loop.
      button.textContent = active ? 'Stop auto-run' : 'Auto-run';
      button.title = active
        ? 'Auto-run is on — the server keeps stepping this orchestration. Click to stop it.'
        : 'Keep stepping this orchestration on the server until it finishes.';
      button.classList.toggle('secondary', !active);
      // No colour override while active: the non-secondary button is already a
      // filled accent green, and painting the text accent too left a green
      // button with invisible green text.
      button.style.color = '';
      button.dataset.active = active ? '1' : '';
    }

    on('orchestratorAutoRunButton', 'click', async () => {
      const taskId = currentOrchestratorTaskId();
      if (!taskId) return;
      const button = document.getElementById('orchestratorAutoRunButton');
      const enabled = button.dataset.active !== '1';
      try {
        const result = await api('/api/workforce/orchestration/auto-run', {
          method: 'POST',
          body: JSON.stringify({ taskId, enabled })
        });
        renderAutoRunButton(result.autoRun);
      } catch (error) {
        alert(error.message);
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
      const button = document.getElementById('orchestratorPauseToggle');
      if (!button) return;
      const paused = status === 'paused';
      button.textContent = paused ? 'Resume' : 'Pause';
      button.dataset.paused = paused ? '1' : '';
      button.disabled = status === 'done' || status === 'failed';
    }

    on('orchestratorPauseToggle', 'click', async () => {
      const taskId = currentOrchestratorTaskId();
      if (!taskId) return;
      const button = document.getElementById('orchestratorPauseToggle');
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
          alert('Report written (' + result.source + '):\\n' + result.reportPath + (result.note ? '\\n\\n' + result.note : ''));
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
      const form = document.getElementById('orchestratorChangeForm');
      if (!form) return;
      form.hidden = !form.hidden;
      if (!form.hidden) form.request.focus();
    });

    on('orchestratorChangeCancel', 'click', () => {
      const form = document.getElementById('orchestratorChangeForm');
      if (!form) return;
      form.hidden = true;
      form.request.value = '';
      document.getElementById('orchestratorChangeStatus').textContent = '';
    });

    on('orchestratorChangeForm', 'submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const statusEl = document.getElementById('orchestratorChangeStatus');
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
          body: JSON.stringify({ taskId, request, teamProviders: checkedTeamProviders(form) })
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
      const shown = document.getElementById('orchestratorPicker');
      const label = shown && shown.selectedOptions[0] ? shown.selectedOptions[0].textContent : taskId;
      if (!confirm('Remove this orchestration AND its task?\\n\\n' + label +
        '\\n\\nThis also deletes its runs, subtasks, reviews, assignments and activity, and removes the task from Work Board. This cannot be undone.')) return;
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
      const statusEl = document.getElementById('orchestratorSubtaskStatus');
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
      const stopButton = event.target.closest('.run-stop');
      const logButton = event.target.closest('.run-log');
      const modelButton = event.target.closest('.run-set-model');
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
      const adoptButton = event.target.closest('.session-adopt');
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
      const view = document.getElementById('view-orchestrator');
      if (live && view && view.classList.contains('active')) refreshOrchestratorBoard();
    }, 3000);

    on('searchButton', 'click', async () => {
      const q = document.getElementById('searchQuery').value;
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
      const candidateButton = event.target.closest && event.target.closest('.review-candidate');
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
      const laneTaskButton = event.target.closest && event.target.closest('.lane-task-card');
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
      const stopTaskCardButton = event.target.closest && event.target.closest('.stop-task-card');
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
      const editButton = event.target.closest && event.target.closest('.edit-task');
      if (editButton) {
        const task = lastTasks.find(item => item.id === editButton.dataset.taskId);
        fillTaskEditor(task);
        return;
      }

      const deleteButton = event.target.closest && event.target.closest('.delete-task');
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

      const button = event.target.closest && event.target.closest('.install-tool');
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
      const focus = encodeURIComponent(document.getElementById('graphFocus').value || '');
      const limit = Number(document.getElementById('graphLimit').value) || 120;
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
      const byId = {};
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
        circle.setAttribute('r', radius(n));
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
      let tooltip = els.graphCanvas.querySelector('.graph-tooltip');
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
        const id = evt.target.dataset && evt.target.dataset.id;
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
      document.getElementById('graphZoomOutButton').onclick = () => zoomAt({ x: W / 2, y: H / 2 }, 0.8);
      document.getElementById('graphZoomInButton').onclick = () => zoomAt({ x: W / 2, y: H / 2 }, 1.25);
      document.getElementById('graphResetViewButton').onclick = () => {
        view.x = 0; view.y = 0; view.k = 1; applyView();
      };
      svg.addEventListener('mousemove', evt => {
        const id = evt.target.dataset && evt.target.dataset.id;
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

    const helpTip = document.getElementById('helpTooltip');
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
      const target = event.target.closest('.help');
      if (target) showHelpTip(target);
    });
    document.addEventListener('mouseout', event => {
      if (event.target.closest('.help')) hideHelpTip();
    });
    document.addEventListener('focusin', event => {
      const target = event.target.closest('.help');
      if (target) showHelpTip(target);
    });
    document.addEventListener('focusout', event => {
      if (event.target.closest('.help')) hideHelpTip();
    });
    window.addEventListener('scroll', hideHelpTip, true);

    setInterval(() => { if (live) load(false); }, 2000);
    load(true);

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }
  </script>
</body>
</html>`;
}

function escapeStaticHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char] ?? char));
}






















