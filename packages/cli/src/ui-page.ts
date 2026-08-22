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
    .panel-section[hidden] { display: none; }
    .panel-section:first-child { padding-top: 0; border-top: 0; }
    .stack { display: grid; gap: 11px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .skill-drop-zone {
      display: grid; place-items: center; min-height: 116px; padding: 18px; text-align: center;
      border: 2px dashed #94a3b8; border-radius: 8px; background: var(--soft); color: var(--muted);
      cursor: pointer; transition: border-color 150ms ease, background 150ms ease;
    }
    .skill-drop-zone.is-dragging { border-color: var(--blue); background: var(--blue-bg); color: var(--blue); }
    .skill-card { border-left: 4px solid var(--blue); }
    .skill-card.global { border-left-color: var(--accent); }
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
    /* Subtask titles are a sentence, not a name: cap them at two lines so one
       long title cannot push the log out of the card. */
    .run-card > .toolbar > strong {
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; overflow-wrap: anywhere; min-width: 0;
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
    .help.help-inline {
      width: auto; height: auto; padding: 0; border: 0; border-radius: 0; background: none;
      border-bottom: 1px dotted var(--line);
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
    .default-agent-list { max-height: min(620px, 72vh); }
    .default-agent-option {
      display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: start;
      gap: 10px; margin: 0; cursor: pointer; color: var(--text);
    }
    .default-agent-option .default-agent-delete { align-self: center; }
    .default-agent-option input[type="checkbox"] {
      width: 16px; height: 16px; min-height: 0; margin: 2px 0 0; padding: 0;
      flex: 0 0 auto; accent-color: var(--blue);
    }
    .default-agent-option-copy { min-width: 0; display: grid; gap: 3px; }
    .default-agent-select-all {
      display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center;
      gap: 10px; margin: 0; padding: 9px 10px; border: 1px solid var(--line);
      border-radius: 8px; background: var(--soft); color: var(--text); cursor: pointer;
    }
    .default-agent-select-all input[type="checkbox"] {
      width: 16px; height: 16px; min-height: 0; margin: 0; padding: 0; accent-color: var(--blue);
    }
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
        <span class="pill warn" id="antigravityHookPill">Antigravity hook unknown</span>
        <span class="pill ok" id="refreshPill">Live refresh: on</span>
      </div>
    </div>
    <div class="toolbar">
      <button class="secondary" id="installClaudeHookButton" type="button">Install Claude Hook</button>
      <button class="secondary" id="installAntigravityHookButton" type="button">Install Antigravity Hook</button>
      <button class="secondary" id="refreshButton" type="button">Refresh</button>
      <button class="ghost" id="toggleLiveButton" type="button">Pause Live</button>
    </div>
  </header>

  <div id="helpTooltip" role="tooltip"></div>
  <div class="modal-backdrop" id="githubTokenHelpModal" hidden>
    <div class="modal-card wide stack" role="dialog" aria-modal="true" aria-labelledby="githubTokenHelpTitle">
      <div class="toolbar" style="justify-content:space-between">
        <h2 id="githubTokenHelpTitle">GitHub token required</h2>
        <button class="ghost" id="githubTokenHelpClose" type="button">Close</button>
      </div>
      <div class="muted">GitHub code search requires authentication. Agent Bridge reads the token from its own process environment; the Skills UI never saves it.</div>
      <ol class="stack" style="padding-left:22px;margin:0">
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub fine-grained token settings</a> and create a token.</li>
        <li>Select the repositories you need and grant <strong>Contents: Read-only</strong>.</li>
        <li>Stop the running UI with <strong>Ctrl+C</strong>, then use exactly one matching shell section below.</li>
      </ol>
      <h3>PowerShell 7</h3>
      <pre style="min-height:0;max-height:none">$env:GITHUB_TOKEN = Read-Host "GitHub token" -MaskInput
if ($env:GITHUB_TOKEN) { "Token visible" } else { "Token missing" }
agent-bridge ui</pre>
      <h3>Windows PowerShell 5.1</h3>
      <pre style="min-height:0;max-height:none">$secure = Read-Host "GitHub token" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:GITHUB_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
agent-bridge ui</pre>
      <h3>Command Prompt (CMD)</h3>
      <pre style="min-height:0;max-height:none">set /p GITHUB_TOKEN=GitHub token:
if defined GITHUB_TOKEN (echo Token visible) else (echo Token missing)
agent-bridge ui</pre>
      <h3>Already added it in Windows Environment Variables?</h3>
      <div class="muted">An existing terminal and UI process cannot see variables added later. Either close that terminal, open a new one, verify the token, and start the UI again; or import the saved user variable into the current PowerShell session:</div>
      <pre style="min-height:0;max-height:none">$env:GITHUB_TOKEN = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User")
if (-not $env:GITHUB_TOKEN) { $env:GITHUB_TOKEN = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Machine") }
if ($env:GITHUB_TOKEN) { "Token visible" } else { "Token missing" }
agent-bridge ui</pre>
      <div class="muted">Do not add angle brackets around a token in CMD; they are redirection operators and can cause a filename or volume-label syntax error. Never commit or paste the token into repository files.</div>
    </div>
  </div>
  <div class="modal-backdrop" id="taskDetailModal" hidden>
    <div class="modal-card wide stack">
      <div class="toolbar" style="justify-content:space-between">
        <h2 id="taskDetailTitle">Task Detail</h2>
        <button class="ghost" id="taskDetailClose" type="button">Close</button>
      </div>
      <div id="taskDetailBody"></div>
    </div>
  </div>

  <div class="modal-backdrop" id="defaultAgentPresetsModal" hidden>
    <div class="modal-card wide stack" role="dialog" aria-modal="true" aria-labelledby="defaultAgentPresetsTitle">
      <div class="toolbar" style="justify-content:space-between">
        <h2 id="defaultAgentPresetsTitle">Default agents</h2>
        <button class="ghost" id="defaultAgentPresetsClose" type="button">Close</button>
      </div>
      <div class="muted">Select reusable built-in profiles. Unselecting removes an agent from the roster but preserves your edits for the next selection. Delete removes the row from this table; added agents live here alongside the built-ins.</div>
      <label class="default-agent-select-all">
        <input id="defaultAgentSelectAll" type="checkbox">
        <span>Select all <span class="meta">— add or remove every default agent</span></span>
      </label>
      <div id="defaultAgentPresets" class="list default-agent-list"></div>
      <form id="defaultAgentPresetForm" class="stack">
        <strong>Add default agent</strong>
        <div class="grid-2">
          <label>Label <input name="label" required placeholder="Codex GPT-5.6 Terra"></label>
          <label>Provider
            <select name="provider" id="defaultAgentPresetProvider">
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
          <label>Command <input name="command" placeholder="codex"></label>
          <label>Model <input name="model" placeholder="gpt-5.6-terra"></label>
          <label>Reasoning / effort
            <select name="reasoningEffort">
              <option value="">Provider default</option>
              <option>low</option><option>medium</option><option>high</option>
              <option>xhigh</option><option>max</option><option>ultra</option>
            </select>
          </label>
          <label>Capabilities <input name="capabilities" placeholder="implement, review, report"></label>
          <label>Expertise description <input name="description" placeholder="What this agent is best at"></label>
        </div>
        <div class="toolbar">
          <button type="submit">Add to table</button>
          <button class="ghost" id="defaultAgentPresetRestore" type="button">Restore built-ins</button>
        </div>
      </form>
    </div>
  </div>

  </div>

  <div class="modal-backdrop" id="repoMemoryEditModal" hidden>
    <div class="modal-card stack" role="dialog" aria-modal="true" aria-labelledby="repoMemoryEditTitle">
      <div class="toolbar" style="justify-content:space-between">
        <h2 id="repoMemoryEditTitle">Edit Repository Memory</h2>
        <button class="ghost" id="repoMemoryEditClose" type="button">Close</button>
      </div>
      <form id="repoMemoryEditForm" class="stack">
        <input id="repoMemoryEditId" name="id" type="hidden">
        <label>Content <textarea id="repoMemoryEditContent" name="content" required></textarea></label>
        <div class="grid-2">
          <label>Type
            <select id="repoMemoryEditType" name="type">
              <option value="note">note</option><option value="bug">bug</option><option value="constraint">constraint</option>
              <option value="decision">decision</option><option value="test">test</option><option value="file">file</option>
            </select>
          </label>
          <label>Importance <input id="repoMemoryEditImportance" name="importance" type="number" min="1" max="5" required></label>
        </div>
        <label>Tags <input id="repoMemoryEditTags" name="tags" placeholder="auth,cookie,session"></label>
        <div class="toolbar"><button type="submit">Save changes</button><button class="ghost" id="repoMemoryEditCancel" type="button">Cancel</button></div>
      </form>
    </div>
  </div>

  <div class="modal-backdrop" id="workforceAgentModal" hidden>
    <div class="modal-card wide stack" role="dialog" aria-modal="true" aria-labelledby="workforceAgentModalTitle">
      <div class="toolbar" style="justify-content:space-between">
        <h2 id="workforceAgentModalTitle">Add Agent</h2>
        <button class="ghost" id="workforceAgentModalClose" type="button">Close</button>
      </div>
      <form id="workforceAgentForm" class="stack">
        <input type="hidden" name="agentId" id="workforceAgentId">
        <div class="grid-2">
          <label>Name <input name="name" required placeholder="deepseek-reviewer"></label>
          <label>Provider
            <select name="provider" id="workforceAgentProvider">
              <option value="codex">codex</option><option value="claude">claude</option><option value="gemini">gemini</option>
              <option value="antigravity">antigravity</option><option value="openai-compatible">openai-compatible</option>
              <option value="deepseek">deepseek</option><option value="kimi">kimi</option><option value="glm">glm</option>
              <option value="manual">manual</option><option value="generic">generic</option>
            </select>
          </label>
          <label>Mode
            <select name="mode" id="workforceAgentMode"><option value="cli">cli</option><option value="api">api</option><option value="manual">manual</option></select>
          </label>
          <label data-mode-field="cli">Command <input name="command" placeholder="codex or claude"></label>
          <label data-mode-field="cli">Model <select name="model" id="workforceAgentModel"></select></label>
          <label data-mode-field="cli" id="workforceAgentModelCustomField" style="display:none">Custom model <input id="workforceAgentModelCustom" placeholder="model name"></label>
          <label data-mode-field="cli">Reasoning / effort <select name="reasoningEffort" id="workforceAgentReasoning"><option value="">Provider default</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option><option>ultra</option></select></label>
          <label data-mode-field="api">Base URL <input name="baseUrl" placeholder="https://api.example.com"></label>
          <label data-mode-field="api">Model <input name="model" id="workforceAgentApiModel" placeholder="model name"></label>
          <label data-mode-field="api">Credential ref <input name="credentialRef" placeholder="DEEPSEEK_API_KEY"></label>
          <label>Capabilities <input name="capabilities" placeholder="implement, review, adjudicate, report"></label>
          <label>Expertise description <input name="description" placeholder="e.g. TypeScript architecture, UI debugging, security review"></label>
        </div>
        <div class="toolbar"><button type="submit" id="workforceAgentSubmit">Add Agent</button><button type="button" id="workforceAgentCancelEdit" class="ghost">Cancel</button></div>
      </form>
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
      <button data-view="skills" type="button">Skills</button>
      <button data-view="tools" type="button">Tools</button>
    </nav>

    <section class="view active" id="view-overview">
      <section class="panel">
        <div class="panel-head"><h2>Agent Terminals</h2><span class="help" data-tip="Opens each agent CLI in its own Windows terminal and assigns a stable session/window ID so Open Task Window can focus it later.">?</span></div>
        <div class="panel-body toolbar">
          <button class="secondary open-agent-terminal" data-agent="claude" type="button">Open Claude</button>
          <button class="secondary open-agent-terminal" data-agent="codex" type="button">Open Codex</button>
          <button class="secondary open-agent-terminal" data-agent="antigravity" type="button">Open Antigravity</button>
          <span class="meta" id="agentTerminalStatus">Each terminal gets its own live task card and window ID.</span>
        </div>
      </section>
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
                <label title="How many times work may be sent back for rework before the run gives up. Accepted work costs nothing.">Max rework cycles <input name="maxCycles" type="number" value="8" min="1"></label>
              </div>
              <div class="grid-3">
                <label><span class="label-row">Max question rounds <span class="help" data-tip="A ceiling on how many times the leader may stop planning to ask you. It does not make the leader ask that many times — it plans as soon as it has enough. Past the cap it must decide the rest itself and record the assumptions in the plan. 0 = never stop to ask.">?</span></span>
                  <input name="maxQuestionRounds" type="number" value="4" min="0"></label>
              </div>
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
            <div class="toolbar" style="margin-bottom:12px">
              <button id="workforceAgentOpen" type="button">Add Agent</button>
              <button class="secondary" id="defaultAgentPresetsOpen" type="button">Default agents…</button>
              <span class="meta" id="defaultAgentPresetsSummary">No default agents selected.</span>
            </div>
            <div class="card" style="margin-bottom:12px">
              <div class="toolbar" style="justify-content:space-between">
                <strong>Providers</strong>
                <span class="help" data-tip="Enable or disable every agent of one provider at once. Disabled agents are never staffed as implementers or reviewers, so this is the quick way to keep a provider out of the next run without deleting it. Ticking a provider with no agent yet registers its default CLI agent.">?</span>
              </div>
              <div id="workforceProviderToggles" style="display:flex; flex-wrap:wrap; gap:6px 14px; margin-top:8px"></div>
            </div>
            <div class="list" id="workforceAgents" style="margin-bottom:12px"></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Orchestration</h2><span class="help" data-tip="Step advances the leader/implementer/reviewer loop by exactly one transition. Auto-run keeps stepping on the server every few seconds until the orchestration finishes, generating the final report too; it is the same switch as the Autonomy field on the left.">?</span></div>
          <div class="panel-body">
            <label>Showing <select id="orchestratorPicker"></select></label>
            <div class="meta" id="orchestratorSummary" style="margin-top:8px">No orchestration for the current task.</div>
            <div class="meta" id="orchestratorLeader" style="margin-top:8px"></div>
            <form id="orchestratorLeaderForm" style="margin-top:8px" hidden>
              <div class="toolbar" style="align-items:end; flex-wrap:wrap">
                <label>Leader provider <select name="leaderProvider" id="orchestratorChangeLeaderProvider"></select></label>
                <label>Model <select name="leaderModel" id="orchestratorChangeLeaderModel"></select></label>
                <label>Reasoning <select name="leaderReasoning" id="orchestratorChangeLeaderReasoning"></select></label>
                <button type="submit" class="secondary">Apply leader</button>
                <button type="button" class="ghost" id="orchestratorLeaderCancel">Cancel</button>
              </div>
              <div class="meta" id="orchestratorLeaderStatus"></div>
            </form>
            <div class="toolbar" style="margin-top:10px; align-items:center">
              <label style="display:flex; align-items:center; gap:6px; margin:0">Autonomy
                <select id="orchestratorAutonomy">
                  <option value="auto">Auto — leader decides on its own</option>
                  <option value="approve-each">Approve each — ask me before every agent</option>
                  <option value="manual">Manual — I advance with Step</option>
                </select>
              </label>
              <span class="help" data-tip="Live setting: change it at any point during the run. Auto and Approve each both keep the server stepping this orchestration; Approve each stops at every agent call until you answer, and you can hand the task to a different agent when you do. Manual leaves the stepping to you.">?</span>
              <span class="meta" id="orchestratorAutoRunState"></span>
              <button type="button" class="secondary" id="orchestratorStepButton">Step</button>
              <button type="button" class="ghost" id="orchestratorPauseToggle">Pause</button>
              <button type="button" class="ghost" id="orchestratorStopButton">Stop</button>
              <button type="button" class="secondary" id="orchestratorReportButton">Generate report</button>
              <button type="button" class="secondary" id="orchestratorRequestChangesButton">Request changes</button>
              <button type="button" class="ghost" id="orchestratorRemoveButton" style="margin-left:auto; color:var(--red)">Remove</button>
            </div>
            <div id="orchestratorApprovals" hidden style="margin-top:10px; border:1px solid var(--blue); border-radius:8px; padding:10px; background:var(--blue-bg)">
              <strong>Waiting for your approval</strong>
              <div class="meta">Autonomy is set to approve-each, so nothing is launched until you say so. Pick a different agent before approving to hand the task to that one instead. Rejecting a subtask only drops that subtask — the rest of the run continues.</div>
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
          <div class="panel-head"><h2>Reviews</h2><span class="help" data-tip="One card per subtask verdict from a reviewer agent. The pill is the verdict (pass / rework / block); the number on the right is the reviewer's own quality score for that subtask, usually out of 100. The score is informational only — it is passed to the leader when it adjudicates and into the final report, but nothing reruns or blocks on it. The verdict alone drives the loop.">?</span></div>
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
          <div class="panel-head"><h2>Save Current Handoff</h2><span class="help" data-tip="Writes .handoff/CURRENT.md and archives a durable cross-agent history snapshot. The current task goal is included automatically.">?</span></div>
          <div class="panel-body">
            <form id="handoffForm" class="stack">
              <label>Created by <select name="from"><option value="claude">Claude</option><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="generic">Generic</option></select></label>
              <label>Current state <textarea name="summary" required placeholder="What works now, what remains incomplete, and the exact state"></textarea></label>
              <div class="grid-2">
                <label>Completed <textarea name="done" placeholder="Concrete results, one per line"></textarea></label>
                <label>Open loops <textarea name="next" placeholder="P0 first action, then P1/P2"></textarea></label>
              </div>
              <div class="grid-2">
                <label>Decisions &amp; gotchas <textarea name="risks" placeholder="Constraints, risks, rejected approaches"></textarea></label>
                <label>Read first <textarea name="filesChanged" placeholder="Up to five relevant file paths"></textarea></label>
              </div>
              <button type="submit">Save Current &amp; Archive</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Current Handoff</h2><span class="help" data-tip="The portable handoff shared through .handoff/CURRENT.md. Saving again creates a new archive instead of mutating old history.">?</span></div>
          <div class="panel-body"><div id="handoff">No current handoff.</div></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Handoff History</h2><span class="help" data-tip="Newest archived checkpoints for the selected task, indexed by .handoff/INDEX.md.">?</span></div>
        <div class="panel-body"><div id="handoffHistory">No archived handoffs.</div></div>
      </section>
    </section>

    <section class="view" id="view-skills">
      <section class="panel">
        <div class="panel-head"><h2>Find Skills on GitHub</h2></div>
        <div class="panel-body stack">
          <form id="githubSkillSearchForm" class="stack">
            <div class="grid-2">
              <label>Search <input id="githubSkillQuery" required minlength="2" placeholder="code review, testing, documentation..."></label>
              <label>Install scope
                <select id="githubSkillScope"><option value="repo">This repository (local)</option><option value="global">Global</option></select>
              </label>
            </div>
            <div class="toolbar"><button type="submit">Search GitHub</button><span class="meta" id="githubSkillStatus"></span></div>
          </form>
          <div class="list" id="githubSkillResults"><div class="muted">Search for a skill to install it with its scripts, references, and assets.</div></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Add Skill</h2><span class="help" data-tip="Repo skills are saved in .agents/skills. Global skills are saved in your user-level .agents/skills folder and are available to every repository.">?</span></div>
        <div class="panel-body">
          <form id="skillForm" class="stack">
            <div class="grid-2">
              <label>Scope
                <select id="skillScope" name="scope"><option value="repo">This repository</option><option value="global">Global</option></select>
              </label>
              <label>Name <input id="skillName" name="name" required placeholder="code-review"></label>
            </div>
            <label>Description <input id="skillDescription" name="description" required placeholder="When this skill should be used"></label>
            <label id="skillDropZone" class="skill-drop-zone" for="skillFile">
              <strong>Drop a SKILL.md or text file here</strong>
              <span>or click to choose a file</span>
              <input id="skillFile" type="file" accept=".md,.txt,text/markdown,text/plain" hidden>
            </label>
            <label>Instructions <textarea id="skillContent" name="content" required placeholder="Enter the workflow instructions, or load them from a file."></textarea></label>
            <div class="toolbar"><button type="submit">Save Skill</button><span class="meta" id="skillStatus"></span></div>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Installed Skills</h2><span class="meta">Codex detects changes automatically.</span></div>
        <div class="panel-body grid-2">
          <div class="stack"><h3>Repository</h3><div class="list" id="repoSkills"></div></div>
          <div class="stack"><h3>Global</h3><div class="list" id="globalSkills"></div></div>
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

  <script type="module" src="/ui-client/main.js"></script>
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






















