import { emitKeypressEvents, type Key } from "node:readline";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { basename } from "node:path";
import { ensureWorkspace, paths, readConfig } from "../workspace.js";
import { initializeProject } from "../commands/init.js";
import { applicationVersion } from "../version.js";
import { autoRunTimers, resumeAutoRuns, stopAutoRun } from "../commands/routes/auto-run.js";
import { isWatcherRunning, startWatcher, stopWatcher } from "../commands/routes/watcher.js";
import { BackgroundRefresh } from "./background-refresh.js";
import { dashboardActions, parseValues, screens, type Action, type Field } from "./actions.js";
import { array, loadDashboard, loadGraph, object, performAction, type Data } from "./service.js";
import { graphEntries, graphPreview, resolvedGraphSettings, screenSections, sectionActions, sectionEntries } from "./sections.js";
import { cellWidth, clean, describe, screenEntries, wrap, type Entry } from "./view.js";
import { TerminalInput, mouseDisable, mouseEnable, type MouseEvent } from "./mouse.js";
import { Surface, theme, editorLines, cursorAt, type HitRegion } from "./surface.js";
import { renderNetwork } from "./network.js";
import { editHighlight } from "./edit-highlight.js";
import { listProviderCatalogs, type ProviderCatalog } from "@agent-bridge/adapters";
import { discoverProviderCatalog, loadRuntimeProviderCatalogs } from "../provider-catalog.js";
import { updateModelFields, type ModelForm } from "./model-fields.js";

type Mode = "browse" | "actions" | "form" | "confirm" | "detail" | "search" | "help" | "terminal-picker";
const terminalChoices = [["Codex", "codex"], ["AGY", "antigravity"], ["Claude", "claude"]] as const;
interface Form extends ModelForm {
  action: Action;
  fields: Field[];
  values: Record<string, string>;
  index: number;
  cursor: number;
  choiceIndex: number;
  initialMode?: string;
  initialCommand?: string;
  catalogRequestKey?: string;
  catalogSource?: string;
  catalogTimer?: NodeJS.Timeout;
  catalogRequest?: Promise<void>;
  catalogRequestVersion?: number;
  catalogAbort?: AbortController;
}
const ESC = "\x1b[";
const help = `Agent Bridge terminal dashboard

Mouse                 Click navigation, buttons, records and fields
Double-click          Open a record; click an action to open its form
Wheel                 Scroll the panel under the pointer
Form choices          Click an option to select it
Text editor           Click to place the cursor; type or paste to edit
Shift + mouse         Use the terminal's normal text selection

1-8 / Left / Right     Switch screen
Tab / Shift+Tab        Next / previous screen
Up / Down or j / k     Select a record or action
Enter                 Open record details / choose action
a                     Actions for the current screen
[ / ]                 Previous / next section within a screen
s                     Select the highlighted task or orchestration
/                     Filter records or actions
r                     Refresh data
PageUp / PageDown      Scroll lists and detail views
Home / End            First / last record
Esc                   Back / cancel
q / Ctrl+C            Quit (q remains text inside forms)
?                     This help

Forms
Tab / Shift+Tab        Next / previous field
Enter                 Next field; review at the end
Left / Right          Move text cursor
Up / Down             Cycle choices or boolean values
Space                 Toggle a checkbox in multi-select lists
Ctrl+A / Ctrl+U        Select all / clear a multi-select list
Ctrl+J                Insert newline
Ctrl+U                Clear field
Ctrl+S                Review action
Esc                   Cancel form

Actions show a review before execution. Optional empty fields are omitted.
Select a task with s to scope memories, context, handoff and action defaults.
Question answers have one text field per pending question.
The dashboard refreshes every two seconds and keeps forms intact.
Opening the TUI starts its watcher when Watch Auto Brief is enabled.
Stop watcher pauses it for this TUI session; reopening starts it again.
Closing the TUI stops its watcher and timers; saved orchestration autonomy
resumes when the TUI is opened again.
Tools > Repository enables/disables Agent Bridge for this repo only.
Graph > Network shows clickable files and directed import relationships.
Click a node to focus it in Nodes; Select node or Enter confirms the change.
Use Links buttons for more neighbors. Edit age fades from bright green (≤10m)
to green (≤3h), blue (≤24h), then dim (>24h); labels also work without colors.
Nodes score adds an edit bonus: +20 (≤10m), +10 (≤3h), +5 (≤24h), +1 (>24h).
STALE keeps its red badge and the selected node keeps its double border.
Nodes / n opens the ranked node list; click focuses, Select node or Enter confirms.
Esc returns from the node list without changing the selected node.
Graph > Repo map includes index statistics; Settings edits graph options.
Tools > Tools contains watcher and update actions.`;

export class TerminalDashboard {
  state: Data = {};
  board: Data = {};
  graph: Data = {};
  graphLimit = 5000;
  catalogs: ProviderCatalog[] = listProviderCatalogs();
  discoverModels = discoverProviderCatalog;
  private catalogsLoaded = false;
  private liveCatalogProviders = new Set<string>();
  private networkPage = 0;
  private networkPath = "";
  private graphListOpen = false;
  private terminalChoice = 0;
  private graphBuildAttempted = false;
  private sections: Record<string, string> = {};
  screen = 0;
  selected = 0;
  mode: Mode = "browse";
  filter = "";
  taskId?: string;
  form?: Form;
  detail = "";
  scroll = 0;
  status = "Loading workspace...";
  busy = false;
  closed = false;
  private refreshing = false;
  private refreshAgain = false;
  private timer?: NodeJS.Timeout;
  private resolveDone?: () => void;
  private previousRaw = false;
  private previousFlowing: boolean | null = null;
  private searchFrom: "browse" | "actions" = "browse";
  private selection: Entry | undefined;
  private pending: Data = {};
  private previousFrame = "";
  private background?: BackgroundRefresh;
  private outputBlocked = false;
  private pendingFrame?: string;
  private liveLog?: { action: Action; values: Data };
  private pasteBuffer?: string;
  hitRegions: HitRegion[] = [];
  private keyboardInput = new PassThrough();
  private terminalInput = new TerminalInput((text) => this.keyboardInput.write(text), (event) => {
    void this.handleMouse(event).catch(this.reportError);
  });
  private lastClick?: { index: number; time: number };
  private previewScroll = 0;
  private listVisible = 1;
  private detailVisible = 1;
  private previewVisible = 1;
  private previewTotal = 0;
  private detailTotal = 0;
  private listStart = 0;
  private helpReturn: Mode = "browse";
  private editorRect?: { x: number; y: number; width: number; height: number };
  private editorScroll?: number;
  private editorOffset = 0;
  private previewRect?: { x: number; y: number; width: number; height: number };

  constructor(readonly project: string, readonly input = process.stdin, readonly output = process.stdout) {}

  get currentScreen() { return screens[this.screen]; }
  get currentSection() {
    const sections = screenSections[this.currentScreen];
    return sections.find((section) => section.name === this.sections[this.currentScreen]) ?? sections[0];
  }
  allEntries(): Entry[] {
    return this.currentScreen === "Graph" ? graphEntries(this.graph, object(this.state.config)) : screenEntries(this.currentScreen, this.state, this.board);
  }
  entries(): Entry[] {
    let entries = this.mode === "actions" || (this.mode === "search" && this.searchFrom === "actions")
      ? sectionActions(dashboardActions.filter((action) => action.screen === this.currentScreen), this.currentSection).map((action) => ({ group: "Actions", label: action.label, data: action }))
      : sectionEntries(this.allEntries(), this.currentSection);
    if (this.currentScreen === "Orchestrator" && ["Team", "Presets"].includes(this.currentSection.name) && this.mode !== "actions") {
      entries = [...entries].sort((a, b) => String(object(a.data).provider ?? "").localeCompare(String(object(b.data).provider ?? "")) || a.label.localeCompare(b.label));
    }
    const query = this.filter.toLocaleLowerCase();
    return query ? entries.filter((entry) => `${entry.group} ${entry.label}`.toLocaleLowerCase().includes(query)) : entries;
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    const taskId = this.taskId;
    try {
      const loadedState = this.background ? await this.background.request(`/api/state/details${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`) : undefined;
      if (this.closed) return;
      const data = await loadDashboard(this.project, taskId, loadedState);
      if (this.closed || this.taskId !== taskId) return;
      const selectedEntry = this.currentScreen === "Work Board" && this.mode === "browse" ? this.entries()[this.selected] : undefined;
      const selectedId = selectedEntry?.group === "Sessions" ? object(selectedEntry.data).sessionId : object(selectedEntry?.data).id;
      this.state = data.state;
      this.state.watcherRunning = isWatcherRunning();
      this.board = data.board;
      if (selectedEntry && selectedId && this.currentScreen === "Work Board" && this.mode === "browse") {
        const index = this.entries().findIndex((entry) => entry.group === selectedEntry.group &&
          (entry.group === "Sessions" ? object(entry.data).sessionId : object(entry.data).id) === selectedId);
        if (index >= 0) this.selected = index;
      }
      if (!this.catalogsLoaded) {
        this.catalogs = (await loadRuntimeProviderCatalogs({ refresh: false })).catalogs.map((catalog) => this.liveCatalogProviders.has(catalog.provider) ? this.catalogs.find((item) => item.provider === catalog.provider) ?? catalog : catalog);
        this.catalogsLoaded = true;
      }
      if (object(this.state.config).enabled === false) {
        stopWatcher();
        for (const id of autoRunTimers.keys()) stopAutoRun(id);
        this.state.watcherRunning = false;
      }
      if (this.currentScreen === "Graph") {
        const graph = await this.loadGraph();
        const selectedGraphPath = this.currentScreen === "Graph" && this.currentSection.name === "Network" ? object(this.entries()[this.selected]?.data).path : undefined;
        this.graph = graph;
        if (typeof selectedGraphPath === "string") {
          const index = this.entries().findIndex((entry) => object(entry.data).path === selectedGraphPath);
          if (index >= 0) this.selected = index;
        }
        if (object(this.graph.stats).files === 0 && !this.graphBuildAttempted && object(this.state.config).enabled !== false && this.mode === "browse") {
          this.graphBuildAttempted = true;
          this.status = "Indexing repository for the graph...";
          this.render();
          await performAction(this.project, dashboardActions.find((action) => action.path === "/api/graph/build")!, {});
          this.graph = await this.loadGraph();
          this.status = `Graph ready: ${object(this.graph.stats).files ?? 0} indexed files`;
        }
      }
      if (this.liveLog && this.mode === "detail") {
        const { action, values } = this.liveLog;
        const log = await performAction(this.project, action, values);
        if (!this.closed && this.mode === "detail") this.detail = `${action.label}\n\n${describe(log)}`;
      }
      if (this.status === "Loading workspace..." || this.status.startsWith("Refresh failed:")) this.status = "Ready";
      this.selected = Math.min(this.selected, Math.max(0, this.entries().length - 1));
    } catch (error) {
      if (!this.closed) this.status = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.refreshing = false;
      if (!this.closed) this.render();
      if (this.refreshAgain && !this.closed) { this.refreshAgain = false; void this.refresh(); }
    }
  }

  run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.previousRaw = Boolean(this.input.isRaw);
      this.previousFlowing = this.input.readableFlowing;
      try {
        emitKeypressEvents(this.keyboardInput);
        this.input.setRawMode(true);
        this.input.resume();
        this.keyboardInput.on("keypress", this.onKey);
        this.input.on("data", this.onData);
        this.input.on("end", this.close);
        this.input.on("error", this.onError);
        this.output.on("resize", this.onResize);
        this.output.on("error", this.onError);
        this.output.on("drain", this.onDrain);
        process.on("SIGINT", this.close);
        process.on("SIGTERM", this.close);
        process.on("exit", this.close);
        const config = readConfig(this.project);
        if (config.enabled !== false && config.graph?.watchAutoBrief !== false) this.state.watcherRunning = startWatcher(this.project);
        this.output.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${mouseEnable}`);
        this.background = new BackgroundRefresh(this.project);
        this.render();
        this.timer = setInterval(() => { if (!this.busy && !this.refreshing) void this.refresh(); }, 2000);
        void this.refresh();
      } catch (error) {
        this.resolveDone = undefined;
        this.close();
        reject(error);
      }
    });
  }

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.background?.close();
    this.pendingFrame = undefined;
    if (this.form?.catalogTimer) clearTimeout(this.form.catalogTimer);
    this.form?.catalogAbort?.abort();
    this.input.off("data", this.onData);
    this.keyboardInput.off("keypress", this.onKey);
    this.terminalInput.close();
    this.keyboardInput.destroy();
    this.input.off("end", this.close);
    this.input.off("error", this.onError);
    this.output.off("resize", this.onResize);
    this.output.off("error", this.onError);
    this.output.off("drain", this.onDrain);
    process.off("SIGINT", this.close);
    process.off("SIGTERM", this.close);
    process.off("exit", this.close);
    try { this.input.setRawMode(this.previousRaw); } catch { process.exitCode = 1; }
    if (this.previousFlowing !== true) this.input.pause();
    if (!this.output.destroyed) this.output.write(`${mouseDisable}${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    stopWatcher();
    for (const id of autoRunTimers.keys()) stopAutoRun(id);
    this.resolveDone?.();
  };

  private onError = (error: Error): void => {
    this.status = error.message;
    process.exitCode = 1;
    this.close();
  };
  private onResize = (): void => { this.previousFrame = ""; this.render(); };
  private onDrain = (): void => {
    this.outputBlocked = false;
    const frame = this.pendingFrame;
    this.pendingFrame = undefined;
    if (frame !== undefined && !this.closed) this.writeFrame(frame);
  };
  private onData = (chunk: Buffer | string): void => { this.terminalInput.feed(chunk); };
  private reportError = (error: unknown): void => {
    this.status = error instanceof Error ? error.message : String(error);
    this.render();
  };
  private onKey = (text: string, key: Key): void => {
    void this.handleKey(text, key).catch(this.reportError);
  };

  async handleMouse(event: MouseEvent): Promise<void> {
    if (this.closed || event.release || event.motion) return;
    if (this.busy) {
      const quit = this.hitRegions.find((region) => region.target.kind === "command" && region.target.name === "quit" && event.x >= region.x && event.x < region.x + region.width && event.y >= region.y && event.y < region.y + region.height);
      if (!event.wheel && event.button === 0 && quit) this.close();
      return;
    }
    if (event.wheel) {
      const preview = this.previewRect;
      if (preview && event.x >= preview.x && event.x < preview.x + preview.width && event.y >= preview.y && event.y < preview.y + preview.height) {
        this.previewScroll = Math.max(0, this.previewScroll + event.wheel * 3);
      } else if (this.mode === "detail" || this.mode === "help" || this.mode === "confirm") {
        this.scroll = Math.max(0, this.scroll + event.wheel * 3);
      } else if (this.mode === "form" && this.form) {
        const field = this.form.fields[this.form.index];
        const editor = this.editorRect;
        if (field && editor && event.x >= editor.x && event.x < editor.x + editor.width && event.y >= editor.y && event.y < editor.y + editor.height) {
          if (field.choices || field.kind === "boolean") this.formKey("", { name: event.wheel > 0 ? "down" : "up" });
          else this.editorScroll = Math.max(0, this.editorOffset + event.wheel * 3);
        } else this.focusField(Math.max(0, Math.min(this.form.fields.length - 1, this.form.index + event.wheel)));
      } else {
        this.selected = Math.max(0, Math.min(this.entries().length - 1, this.selected + event.wheel * 3));
        this.listStart = Math.max(0, this.listStart + event.wheel * 3);
        this.previewScroll = 0;
      }
      this.render(); return;
    }
    if (event.button !== 0) return;
    const hit = [...this.hitRegions].reverse().find((region) => event.x >= region.x && event.x < region.x + region.width && event.y >= region.y && event.y < region.y + region.height);
    if (!hit) return;
    const target = hit.target;
    if (target.kind === "screen") {
      this.graphListOpen = false;
      this.screen = target.index; this.mode = "browse"; this.filter = ""; this.selected = 0;
      this.selection = undefined; this.liveLog = undefined; this.previewScroll = 0; this.lastClick = undefined;
      if (this.currentScreen === "Graph") await this.refresh();
    } else if (target.kind === "section") {
      this.selectSection(target.name);
    } else if (target.kind === "action") {
      this.openAction(target.path);
    } else if (target.kind === "new-task") {
      this.terminalChoice = 0;
      this.mode = "terminal-picker";
    } else if (target.kind === "new-terminal") {
      await this.openNewTerminal(target.agent);
    } else if (target.kind === "network-page") {
      this.networkPage = target.page;
    } else if (target.kind === "network-node" || target.kind === "graph-node") {
      if (!array(this.graph.nodes).some((node) => node.path === target.path)) this.graph = await loadGraph(this.project, "", this.graphLimit);
      if (!this.graphListOpen) this.toggleGraphNodes();
      this.filter = "";
      const index = this.entries().findIndex((entry) => object(entry.data).path === target.path);
      if (index >= 0) this.selected = index;
      this.previewScroll = 0;
      this.status = "Press Select node or Enter to confirm; Esc to return.";
    } else if (target.kind === "row") {
      if (this.mode === "search") this.mode = this.searchFrom;
      const double = this.lastClick?.index === target.index && Date.now() - this.lastClick.time < 400;
      this.selected = target.index; this.previewScroll = 0;
      this.lastClick = { index: target.index, time: Date.now() };
      if (this.graphListOpen && this.currentScreen === "Graph" && this.currentSection.name === "Network" && this.mode === "browse") {
        this.status = "Press Select node or Enter to confirm; Esc to return.";
      } else if (this.mode === "actions" || double) await this.handleKey("\r", { name: "return" });
    } else if (target.kind === "field") this.focusField(target.index);
    else if (target.kind === "choice" && this.form) {
      const field = this.form.fields[this.form.index];
      if (field?.multiple) {
        const selected: string[] = JSON.parse(this.form.values[field.key] || "[]");
        this.form.values[field.key] = JSON.stringify(selected.includes(target.value) ? selected.filter((value) => value !== target.value) : [...selected, target.value]);
        this.form.choiceIndex = field.choices!.indexOf(target.value);
      } else if (field) { this.form.values[field.key] = target.value; this.form.cursor = [...target.value].length; }
    } else if (target.kind === "editor" && this.form) {
      this.form.cursor = target.start + cursorAt(target.text, event.x - hit.x);
      this.editorScroll = undefined;
    } else if (target.kind === "scroll") {
      if (target.area === "list") this.selected = Math.round(target.fraction * Math.max(0, this.entries().length - 1));
      else if (target.area === "preview") this.previewScroll = Math.round(target.fraction * Math.max(0, this.previewTotal - this.previewVisible));
      else this.scroll = Math.round(target.fraction * Math.max(0, this.detailTotal - this.detailVisible));
    } else if (target.kind === "command") {
      const commands: Record<string, [string, Key]> = {
        actions: ["a", { name: "a" }], refresh: ["r", { name: "r" }], search: ["/", {}], help: ["?", {}],
        quit: ["", { ctrl: true, name: "c" }], open: ["\r", { name: "return" }], select: ["s", {}], back: ["", { name: "escape" }],
      };
      if (target.name === "nodes") this.toggleGraphNodes();
      else if (target.name === "review") this.review();
      else if (target.name === "execute") await this.execute();
      else if (target.name === "help") { this.helpReturn = this.mode; this.mode = "help"; this.scroll = 0; }
      else if (target.name === "search") {
        if (this.mode !== "search") await this.handleKey("/", {});
      }
      else if (target.name === "clear" && this.form) this.formKey("", { ctrl: true, name: "u" });
      else if (target.name === "select-all" && this.form) this.formKey("", { ctrl: true, name: "a" });
      else if (target.name === "refresh-models" && this.form) this.refreshFormModels(true);
      else if ((target.name === "previous" || target.name === "next") && this.form) this.focusField(Math.max(0, Math.min(this.form.fields.length - 1, this.form.index + (target.name === "next" ? 1 : -1))));
      else if (commands[target.name]) await this.handleKey(...commands[target.name]);
    }
    this.render();
  }

  private focusField(index: number): void {
    if (!this.form) return;
    this.editorScroll = undefined;
    this.form.index = index;
    this.form.cursor = [...(this.form.values[this.form.fields[index]?.key] ?? "")].length;
  }

  selectSection(name: string): void {
    if (!screenSections[this.currentScreen].some((section) => section.name === name)) return;
    this.sections[this.currentScreen] = name;
    this.graphListOpen = false;
    this.networkPage = 0;
    this.mode = "browse"; this.selected = 0; this.listStart = 0; this.previewScroll = 0; this.filter = ""; this.selection = undefined;
    if (this.currentScreen === "Graph" && name === "Network") this.selected = Math.max(0, this.entries().findIndex((entry) => object(entry.data).path === this.networkPath));
    this.render();
  }

  private toggleGraphNodes(): void {
    if (this.graphListOpen) {
      this.selectSection("Network");
      return;
    }
    this.selectSection("Network");
    this.graphListOpen = true;
    this.status = "Nodes: click to focus; Select node or Enter to confirm; Esc to return.";
  }

  private async selectGraphNode(path: string): Promise<void> {
    if (!array(this.graph.nodes).some((node) => node.path === path)) this.graph = await loadGraph(this.project, "", this.graphLimit);
    const node = array(this.graph.nodes).find((node) => node.path === path);
    if (!node) { this.status = `Node not found in the repository index: ${path}`; return; }
    this.networkPath = path;
    this.selectSection("Network");
    this.status = `Selected ${path}`;
  }

  private openAction(path: string): void {
    const action = dashboardActions.find((action) => action.path === `/api/${path}`);
    if (!action) return;
    if (this.mode === "browse") this.selection = this.entries()[this.selected];
    this.openForm(action);
  }

  private async openNewTerminal(agent: "codex" | "antigravity" | "claude"): Promise<void> {
    const action = dashboardActions.find((action) => action.path === "/api/session/terminal")!;
    this.openForm(action);
    this.form!.values = { agent };
    this.pending = { agent };
    await this.execute();
  }

  async handleKey(text: string, key: Key = {}): Promise<void> {
    if (this.closed) return;
    if (key.ctrl && key.name === "c") { this.close(); return; }
    if (this.busy) return;
    if (this.mode === "terminal-picker") {
      if (key.name === "escape") this.mode = "browse";
      else if (text === "q") this.close();
      else if (key.name === "return") await this.openNewTerminal(terminalChoices[this.terminalChoice][1]);
      else if (key.name === "up" || key.name === "down" || key.name === "tab") {
        const step = key.name === "up" || key.shift ? -1 : 1;
        this.terminalChoice = (this.terminalChoice + step + terminalChoices.length) % terminalChoices.length;
      }
      this.render(); return;
    }
    if (key.name === "paste-start") { this.pasteBuffer = ""; return; }
    if (key.name === "paste-end") {
      const pasted = clean((this.pasteBuffer ?? "").replace(/\r\n?/g, "\n"));
      this.pasteBuffer = undefined;
      const field = this.form?.fields[this.form.index];
      if (this.mode === "form" && field) {
        const chars = [...(this.form!.values[field.key] ?? "")];
        chars.splice(this.form!.cursor, 0, ...pasted);
        this.form!.values[field.key] = chars.join("");
        this.form!.cursor += [...pasted].length;
      } else if (this.mode === "search") { this.filter += pasted.replace(/\n/g, " "); }
      this.render(); return;
    }
    if (this.pasteBuffer !== undefined) { this.pasteBuffer += text ?? key.sequence ?? ""; return; }
    if (this.mode === "form") { this.formKey(text, key); this.render(); return; }
    if (this.mode === "confirm") {
      if (key.name === "escape") this.mode = "form";
      else if (key.name === "return") await this.execute();
      else if (key.name === "up") this.scroll = Math.max(0, this.scroll - 1);
      else if (key.name === "down") this.scroll++;
      else if (key.name === "pageup") this.scroll = Math.max(0, this.scroll - 10);
      else if (key.name === "pagedown") this.scroll += 10;
      this.render(); return;
    }
    if (this.mode === "search") {
      if (key.name === "escape") { this.filter = ""; this.mode = this.searchFrom; }
      else if (key.name === "return") this.mode = this.searchFrom;
      else if (key.name === "backspace") this.filter = [...this.filter].slice(0, -1).join("");
      else if (!key.ctrl && !key.meta && text) this.filter += clean(text).replace(/\n/g, "");
      this.selected = 0; this.render(); return;
    }
    if (text === "q") { this.close(); return; }
    if ((text === "[" || text === "]") && ["browse", "actions"].includes(this.mode)) {
      const options = screenSections[this.currentScreen];
      this.selectSection(options[(options.indexOf(this.currentSection) + (text === "]" ? 1 : -1) + options.length) % options.length].name);
      return;
    }
    if (this.mode === "detail" || this.mode === "help") {
      if (key.name === "escape" || key.name === "return") { this.mode = this.mode === "help" ? this.helpReturn : "browse"; this.scroll = 0; this.liveLog = undefined; }
      else if (text === "a") { this.mode = "actions"; this.selected = 0; this.filter = ""; this.liveLog = undefined; }
      else if (key.name === "home") this.scroll = 0;
      else if (key.name === "end") this.scroll = Number.MAX_SAFE_INTEGER;
      else if (key.name === "up" || text === "k") this.scroll = Math.max(0, this.scroll - 1);
      else if (key.name === "down" || text === "j") this.scroll++;
      else if (key.name === "pageup") this.scroll = Math.max(0, this.scroll - 10);
      else if (key.name === "pagedown") this.scroll += 10;
      this.render(); return;
    }
    if (key.name === "escape" && this.graphListOpen && this.mode === "browse") { this.selectSection("Network"); }
    else if (key.name === "escape") { this.mode = "browse"; this.filter = ""; this.selected = 0; }
    else if (key.name === "tab" || key.name === "left" || key.name === "right" || (/^[1-9]$/.test(text ?? "") && Number(text) <= screens.length)) {
      this.screen = (/^[1-9]$/.test(text ?? "") && Number(text) <= screens.length) ? Number(text) - 1 : (this.screen + (key.shift || key.name === "left" ? -1 : 1) + screens.length) % screens.length;
      this.graphListOpen = false;
      this.mode = "browse"; this.filter = ""; this.selected = 0; this.selection = undefined;
      this.previewScroll = 0;
      if (this.currentScreen === "Graph") await this.refresh();
    } else if (text === "a") {
      this.selection = this.entries()[this.selected];
      this.mode = "actions"; this.filter = ""; this.selected = 0;
    } else if (text === "/") {
      if (this.currentScreen === "Graph" && this.currentSection.name === "Network" && this.mode === "browse" && !this.graphListOpen) this.toggleGraphNodes();
      this.searchFrom = this.mode === "actions" ? "actions" : "browse";
      this.mode = "search";
    } else if (text === "?") { this.helpReturn = this.mode; this.mode = "help"; this.scroll = 0; }
    else if (text === "r") { this.status = "Refreshing..."; await this.refresh(); this.status = this.status === "Refreshing..." ? "Ready" : this.status; }
    else if (text === "n" && this.currentScreen === "Graph" && this.mode === "browse") this.toggleGraphNodes();
    else if (text === "s" && this.mode === "browse") {
      const entry = this.entries()[this.selected];
      const row = object(entry?.data);
      const id = entry?.group === "Tasks" ? row.id : row.taskId;
      if (this.currentScreen === "Graph" && this.graphListOpen && typeof row.path === "string") await this.selectGraphNode(row.path);
      else if (typeof id === "string") { this.taskId = id; this.status = `Selected task ${id}`; await this.refresh(); }
      else this.status = "Highlight a task or orchestration, then press s.";
    } else if (key.name === "return") {
      const entry = this.entries()[this.selected];
      if (entry && this.mode === "actions") this.openForm(entry.data as Action);
      else if (entry && this.graphListOpen && this.currentScreen === "Graph" && this.currentSection.name === "Network") await this.selectGraphNode(String(object(entry.data).path));
      else if (entry && this.currentScreen === "Graph" && entry.group === "Graph settings") {
        this.selection = entry; this.openAction("config/graph");
      } else if (entry) { this.selection = entry; this.detail = `${entry.group} / ${entry.label}\n\n${this.currentScreen === "Graph" ? graphPreview(entry) : describe(entry.data)}`; this.scroll = 0; this.mode = "detail"; }
    } else {
      const count = this.entries().length;
      if (key.name === "up" || text === "k") this.selected--;
      else if (key.name === "down" || text === "j") this.selected++;
      else if (key.name === "pageup") this.selected -= 10;
      else if (key.name === "pagedown") this.selected += 10;
      else if (key.name === "home") this.selected = 0;
      else if (key.name === "end") this.selected = count - 1;
      this.selected = Math.max(0, Math.min(this.selected, count - 1));
      this.previewScroll = 0;
    }
    this.render();
  }

  openForm(action: Action): void {
    if (this.form?.catalogTimer) clearTimeout(this.form.catalogTimer);
    this.form?.catalogAbort?.abort();
    const record = object(this.selection?.data);
    const taskId = record.taskId ?? (this.selection?.group === "Tasks" ? record.id : undefined) ??
      (this.currentScreen === "Orchestrator" ? object(this.board.orchestration).taskId : undefined) ?? this.taskId ?? object(this.state.currentTask).id;
    const editing = /Edit |Save context|Save skill|Save file brief|Graph settings|CLI approval/.test(action.label);
    const values: Record<string, string> = {};
    let formFields = action.fields.map((field) => ({ ...field }));
    if (action.path === "/api/session/terminal" && this.selection?.group === "Sessions") {
      formFields = formFields.filter((field) => !["transferOwnership", "createGoal"].includes(field.key));
    }
    action = { ...action, fields: formFields };
    const deletingAgent = action.path === "/api/workforce/agent/delete";
    const deletingPreset = action.path === "/api/workforce/default-agent/delete";
    if (deletingAgent || deletingPreset) {
      const key = deletingAgent ? "agentId" : "presetKey";
      const records = array(deletingAgent ? this.state.registeredAgents : this.state.defaultAgentPresets);
      const options = records.map((item) => [String(deletingAgent ? item.id : item.key),
        [deletingAgent ? item.name : item.label ?? item.name, item.provider, item.model ?? "default model"].filter(Boolean).join(" · ")]);
      formFields = formFields.map((field) => field.key === key ? { ...field,
        label: deletingAgent ? "Agent" : "Agent preset",
        choices: options.map(([value]) => value), choiceLabels: Object.fromEntries(options), multiple: true,
      } : field);
      action = { ...action, fields: formFields };
    }
    for (const field of formFields) {
      let value: unknown = field.initial ?? "";
      if (field.key === "taskId") value = taskId ?? "";
      else if (field.key === "runId" || field.key === "run") value = this.selection?.group === "Runs" ? record.id : "";
      else if (field.key === "agentId") value = this.selection?.group === "Agents" ? record.id : "";
      else if (field.key === "requestId") value = /Requests|Questions|Approvals/.test(this.selection?.group ?? "") ? record.id : "";
      else if (field.key === "leaseId") value = this.selection?.group === "File leases" ? record.id : "";
      else if (field.key === "id") value = record.id ?? "";
      else if (field.key === "sessionId") value = record.sessionId ?? "";
      else if (field.key === "presetKey") value = record.key ?? record.presetKey ?? "";
      else if (editing && record[field.key] !== undefined) value = record[field.key];
      if (["/api/session/terminal", "/api/session/focus"].includes(action.path) && field.key === "agent") value = record.agent ?? record.ownerAgent ?? value;
      if (action.path === "/api/session/terminal" && field.key === "sessionId" && this.selection?.group !== "Sessions") value = "";
      if (action.path === "/api/session/terminal" && field.key === "taskId" && this.selection?.group === "Sessions" && !record.taskId) value = "";
      if (action.path === "/api/context/save" && field.key === "content") value = this.state.compiledContext;
      if (action.path === "/api/config/graph") value = resolvedGraphSettings(object(this.state.config))[field.key] ?? "";
      if (action.path === "/api/graph/brief" && field.key === "summary") value = record.brief ?? record.summary ?? "";
      if (action.path === "/api/repo/enabled") value = object(this.state.config).enabled === false;
      if (action.path === "/api/workforce/agent/toggle" && field.key === "enabled") value = record.enabled === false;
      if (action.path === "/api/workforce/default-agent/toggle" && field.key === "selected") value = record.selected !== true;
      if (action.path === "/api/workforce/run/set-model" && ["model", "reasoningEffort"].includes(field.key)) value = record[field.key] ?? "";
      if (action.path === "/api/workforce/orchestration/autonomy" && field.key === "autonomy") value = object(this.board.orchestration).autonomy ?? "manual";
      if (action.path === "/api/workforce/orchestration/auto-run" && field.key === "enabled") value = !this.board.autoRun;
      if (action.path === "/api/workforce/orchestration/leader") {
        const keys: Record<string, string> = { leaderProvider: "provider", leaderMode: "mode", leaderModel: "model", leaderReasoning: "reasoningEffort", leaderCommand: "command" };
        if (keys[field.key]) value = object(this.board.leaderAgent)[keys[field.key]] ?? value;
      }
      if (action.path === "/api/config/cli-approvals") {
        const policies = object(object(this.state.config).cliApprovalPolicies);
        const legacyMode = policies.antigravity === "accept-edits" || policies.antigravity === "plan" ? policies.antigravity : undefined;
        const defaults: Record<string, unknown> = { codex: "never", codexSandbox: "workspace-write", antigravity: "default", antigravityMode: legacyMode ?? (policies.antigravity ? "default" : "accept-edits"), claude: "auto" };
        value = field.key === "antigravity" && legacyMode ? "default" : policies[field.key] ?? defaults[field.key];
      }
      values[field.key] = Array.isArray(value) && field.kind === "text" ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
      if (field.choiceLabels && !field.choices?.includes(values[field.key])) values[field.key] = "";
      if (field.multiple) values[field.key] = JSON.stringify(values[field.key] ? [values[field.key]] : []);
    }
    if (action.path.endsWith("/answer-questions")) {
      formFields = [...formFields.filter((field) => field.key !== "answers"), ...array(this.board.questions).map((question): Field => ({
        key: `answer:${question.id}`, label: String(question.title), kind: "text", required: false,
      }))];
    }
    this.form = { action, fields: formFields, values, index: 0, cursor: [...(values[formFields[0]?.key] ?? "")].length, choiceIndex: 0 };
    this.form.initialProvider = String(record.provider ?? object(this.board.leaderAgent).provider ?? "");
    this.form.initialMode = typeof record.mode === "string" ? record.mode : undefined;
    this.form.initialCommand = typeof record.command === "string" ? record.command : undefined;
    this.editorScroll = undefined;
    if (action.path === "/api/config/graph" && record.setting) this.focusField(Math.max(0, formFields.findIndex((field) => field.key === record.setting)));
    this.mode = "form";
    this.status = "Fill fields, then Ctrl+S to review. Esc cancels.";
    this.updateModelSuggestions();
  }

  private updateModelSuggestions(): void {
    const form = this.form;
    if (!form) return;
    const agents = array(this.state.registeredAgents);
    const agent = agents.find((item) => item.id === form.values.agentId);
    const run = array(this.board.runs).find((item) => item.id === (form.values.runId || form.values.run));
    const runAgent = agents.find((item) => item.id === run?.agentId);
    const provider = agent?.provider ?? run?.provider ?? runAgent?.provider ?? form.initialProvider;
    updateModelFields(form, this.catalogs, typeof provider === "string" ? provider : "");
    if (this.mode === "form") this.refreshFormModels();
  }

  private refreshFormModels(force = false): void {
    const form = this.form;
    if (!form || !form.fields.some((field) => field.key === "model" || field.key === "leaderModel")) return;
    const leader = form.fields.some((field) => field.key === "leaderModel");
    const provider = form.catalogProvider ?? "";
    const run = array(this.board.runs).find((item) => item.id === (form.values.runId || form.values.run));
    const agent = array(this.state.registeredAgents).find((item) => item.id === (run?.agentId ?? form.values.agentId));
    const mode = form.values[leader ? "leaderMode" : "mode"] || run?.mode || agent?.mode || form.initialMode || "cli";
    const base = this.catalogs.find((item) => item.provider === provider);
    const command = form.values[leader ? "leaderCommand" : "command"] || String(agent?.command ?? form.initialCommand ?? base?.defaultCommand ?? "");
    const requestKey = JSON.stringify([provider, mode, command]);
    if (!force && form.catalogRequestKey === requestKey) return;
    form.catalogRequestKey = requestKey;
    const version = (form.catalogRequestVersion ?? 0) + 1;
    form.catalogRequestVersion = version;
    if (form.catalogTimer) clearTimeout(form.catalogTimer);
    form.catalogAbort?.abort();
    if (mode !== "cli" || !base || !["codex", "claude", "antigravity"].includes(provider)) {
      form.catalogSource = "custom model";
      return;
    }
    form.catalogSource = `${provider}: loading from CLI…`;
    const controller = new AbortController();
    form.catalogAbort = controller;
    const discover = async (): Promise<void> => {
      try {
        const discovered = await this.discoverModels(provider, command, 15_000, controller.signal);
        if (this.closed || this.form !== form || form.catalogRequestKey !== requestKey || form.catalogRequestVersion !== version || this.mode !== "form") return;
        const catalog = { ...base, models: discovered.models, reasoning: discovered.reasoning ?? base.reasoning };
        this.catalogs = [...this.catalogs.filter((item) => item.provider !== provider), catalog];
        this.liveCatalogProviders.add(provider);
        updateModelFields(form, this.catalogs, provider);
        form.catalogSource = `${provider}: live CLI`;
      } catch (error) {
        if (this.closed || this.form !== form || form.catalogRequestKey !== requestKey || form.catalogRequestVersion !== version || this.mode !== "form") return;
        form.catalogSource = `${provider}: cached · CLI unavailable`;
        this.status = `Model refresh failed (${provider}): ${clean(error instanceof Error ? error.message : error).split("\n")[0].slice(0, 160)}. Using cached suggestions.`;
      }
      this.render();
    };
    if (force) form.catalogRequest = discover();
    else {
      form.catalogTimer = setTimeout(() => {
        if (this.closed || this.form !== form || this.mode !== "form" || form.catalogRequestKey !== requestKey || form.catalogRequestVersion !== version) return;
        form.catalogRequest = discover();
      }, 250);
      form.catalogTimer.unref();
    }
  }

  private formKey(text: string, key: Key): void {
    const form = this.form!;
    this.updateModelSuggestions();
    this.editorScroll = undefined;
    if (key.name === "escape") {
      if (form.catalogTimer) clearTimeout(form.catalogTimer);
      form.catalogAbort?.abort();
      this.mode = "actions"; this.form = undefined; return;
    }
    if ((key.ctrl && key.name === "s") || (key.name === "return" && form.index >= form.fields.length)) { this.review(); return; }
    if (key.name === "tab" || key.name === "return") {
      form.index = (form.index + (key.shift ? -1 : 1) + form.fields.length + 1) % (form.fields.length + 1);
      form.cursor = [...(form.values[form.fields[form.index]?.key] ?? "")].length;
      return;
    }
    const field = form.fields[form.index];
    if (!field) return;
    const value = form.values[field.key] ?? "";
    const chars = [...value];
    if (field.multiple) {
      const choices = field.choices ?? [];
      const selected: string[] = JSON.parse(value || "[]");
      if (key.ctrl && key.name === "u") form.values[field.key] = "[]";
      else if (key.ctrl && key.name === "a") form.values[field.key] = JSON.stringify(choices);
      else if (choices.length && (key.name === "up" || key.name === "down")) form.choiceIndex = (form.choiceIndex + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
      else if (choices.length && (key.name === "space" || text === " ")) {
        const choice = choices[form.choiceIndex];
        form.values[field.key] = JSON.stringify(selected.includes(choice) ? selected.filter((item) => item !== choice) : [...selected, choice]);
      }
      return;
    }
    if (key.ctrl && key.name === "u") { form.values[field.key] = ""; form.cursor = 0; return; }
    const choices = field.choices ?? (field.kind === "boolean" ? ["", "true", "false"] : undefined);
    if (choices && (key.name === "up" || key.name === "down")) {
      if (!choices.length) return;
      const index = choices.indexOf(value);
      form.values[field.key] = choices[index < 0 ? (key.name === "up" ? choices.length - 1 : 0) : (index + (key.name === "up" ? -1 : 1) + choices.length) % choices.length];
      form.cursor = [...form.values[field.key]].length; return;
    }
    if (field.choiceLabels && !field.allowCustom) return;
    if (key.name === "left") form.cursor = Math.max(0, form.cursor - 1);
    else if (key.name === "right") form.cursor = Math.min(chars.length, form.cursor + 1);
    else if (key.name === "home") form.cursor = 0;
    else if (key.name === "end") form.cursor = chars.length;
    else if (key.name === "backspace" && form.cursor > 0) chars.splice(--form.cursor, 1);
    else if (key.name === "delete") chars.splice(form.cursor, 1);
    else if (key.ctrl && key.name === "j") { chars.splice(form.cursor++, 0, "\n"); }
    else if (!key.ctrl && !key.meta && text && !["up", "down"].includes(key.name ?? "")) {
      const inserted = [...clean(text)];
      chars.splice(form.cursor, 0, ...inserted); form.cursor += inserted.length;
    }
    form.values[field.key] = chars.join("");
  }

  private review(): void {
    const form = this.form!;
    this.updateModelSuggestions();
    const values = { ...form.values };
    if (form.action.path.endsWith("/answer-questions")) {
      values.answers = JSON.stringify(form.fields.filter((field) => field.key.startsWith("answer:")).map((field) => ({ id: field.key.slice(7), answer: values[field.key] ?? "" })));
    }
    this.pending = parseValues(form.action, values);
    if (form.action.path === "/api/config/graph") {
      this.pending.includePaths = values.includePaths ?? "";
      this.pending.ignorePaths = values.ignorePaths ?? "";
    }
    this.mode = "confirm";
    this.scroll = 0;
    this.status = form.action.destructive ? "Review carefully. Enter executes; Esc returns to editing." : "Enter executes; Esc returns to editing.";
  }

  private async execute(): Promise<void> {
    const action = this.form!.action;
    this.busy = true;
    this.status = `Running: ${action.label}...`;
    this.render();
    try {
      const multiple = this.form!.fields.find((field) => field.multiple);
      let result: unknown;
      if (multiple) {
        const results: Data[] = [];
        for (const value of this.pending[multiple.key] as string[]) {
          const label = multiple.choiceLabels?.[value] ?? value;
          try {
            results.push({ item: label, result: await performAction(this.project, action, { ...this.pending, [multiple.key]: value }) });
          } catch (error) {
            results.push({ item: label, error: error instanceof Error ? error.message : String(error) });
          }
        }
        result = { succeeded: results.filter((item) => !item.error).length, failed: results.filter((item) => item.error).length, results };
      } else result = await performAction(this.project, action, this.pending);
      if (this.closed) return;
      if (action.path === "/api/workforce/catalog") {
        for (const catalog of array(object(result).catalogs)) {
          const index = this.catalogs.findIndex((item) => item.provider === catalog.provider);
          if (index >= 0) this.catalogs[index] = catalog as ProviderCatalog;
          else this.catalogs.push(catalog as ProviderCatalog);
        }
      }
      this.detail = `${action.label}\n\n${describe(result)}`;
      this.liveLog = action.path === "/api/workforce/run/log" ? { action, values: { ...this.pending } } : undefined;
      this.mode = "detail";
      if (action.path === "/api/graph/build") {
        this.graphBuildAttempted = true;
        this.graph = await loadGraph(this.project, "", this.graphLimit);
        this.selectSection("Network");
      }
      this.scroll = 0;
      this.status = object(result).failed ? `${action.label}: ${object(result).succeeded} succeeded, ${object(result).failed} failed. See details.` : `Completed: ${action.label}`;
      await this.refresh();
    } catch (error) {
      if (this.closed) return;
      this.mode = "form";
      this.status = `Failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally { this.busy = false; }
  }

  render(): void {
    if (this.closed) return;
    const now = Date.now();
    this.updateModelSuggestions();
    const width = Math.max(1, (this.output.columns || 100) - 1);
    const height = Math.max(1, this.output.rows || 30);
    const ui = new Surface(width, height, Boolean(this.output.isTTY) && process.env.NO_COLOR === undefined);
    this.previewRect = undefined;
    this.editorRect = undefined;
    if (width < 47 || height < 18) {
      wrap("Enlarge terminal to at least 48 columns and 18 rows. Ctrl+C quits.", width).slice(0, height).forEach((line, index) => ui.text(0, index, line));
      this.hitRegions = [];
      this.writeFrame(ui.frame());
      return;
    }
    const sidebar = width >= 87;
    const mainX = sidebar ? 24 : 1;
    const mainY = sidebar ? 6 : 8;
    const mainWidth = width - mainX - 1;
    const mainHeight = height - mainY - 4;
    const x = mainX + 2;
    let y = mainY + 2;
    const contentWidth = mainWidth - 4;
    let contentHeight = Math.max(1, mainHeight - 3);
    const isActions = this.mode === "actions" || (this.mode === "search" && this.searchFrom === "actions");
    const task = this.taskId ?? object(this.state.currentTask).id ?? "No task selected";
    ui.text(2, 1, ">_  AGENT BRIDGE", 17, theme.accent);
    ui.text(20, 1, `v${applicationVersion}`, 10, theme.muted);
    const disabled = object(this.state.config).enabled === false;
    ui.text(Math.max(32, width - 27), 1, this.busy ? "●  WORKING" : disabled ? "●  REPO DISABLED" : "●  LOCAL WORKSPACE", Math.min(25, width - 33), disabled ? theme.danger : this.busy ? theme.accent : theme.success);
    ui.text(2, 2, this.project, width - 4, theme.muted);
    if (sidebar) {
      ui.text(2, 4, "WORKSPACE", 19, theme.muted);
      ui.text(mainX + 1, 4, this.currentScreen, Math.min(18, mainWidth - 3), theme.accent);
      ui.text(mainX + 20, 4, `${array(this.state.tasks).length} tasks  ·  ${array(this.state.activeSessionEvents).filter((event) => event.liveness !== "unknown" && event.liveness !== "ended").length} sessions  ·  ${array(this.state.agentRequests).length} requests`, Math.max(0, mainWidth - 21), theme.muted);
      screens.forEach((name, index) => {
        const navY = 6 + index;
        ui.text(1, navY, ` ${index === this.screen ? "›" : " "} ${index + 1}  ${name}`, 21, index === this.screen ? theme.selected : theme.base);
        ui.hit(1, navY, 21, 1, { kind: "screen", index });
      });
      ui.text(3, Math.min(height - 6, 17), "Click to navigate", 18, theme.muted);
      ui.text(3, height - 4, basename(this.project), 18, theme.muted);
    } else {
      const short = ["Work", "Orch", "Know", "Context", "Graph", "Handoff", "Skills", "Tools"];
      screens.forEach((name, index) => {
        const row = index < 5 ? 4 : 5;
        const count = row === 4 ? 5 : screens.length - 5;
        const cell = Math.floor((width - 2) / count);
        const column = 1 + (row === 4 ? index : index - 5) * cell;
        ui.text(column, row, ` ${index + 1} ${short[index]}`, cell - 1, index === this.screen ? theme.selected : theme.button);
        ui.hit(column, row, cell - 1, 1, { kind: "screen", index });
      });
      ui.text(2, 6, this.currentScreen, width - 4, theme.accent);
    }
    const title = this.mode === "form" || this.mode === "confirm" ? this.form!.action.label : this.mode === "help" ? "Help & controls" : this.mode === "detail" ? "Details" : `${this.graphListOpen && this.currentScreen === "Graph" && this.currentSection.name === "Network" && !isActions ? "Nodes" : this.currentSection.name}${isActions ? " / Actions" : ""}`;
    ui.box(mainX, mainY, mainWidth, mainHeight, title);
    let toolbar = x;
    const button = (label: string, name: Extract<import("./surface.js").Target, { kind: "command" }>["name"], style: string = theme.button): void => {
      toolbar = ui.button(toolbar, mainY + mainHeight + 1, label, { kind: "command", name }, style);
    };
    if (this.mode === "terminal-picker") {
      ui.text(x, y, "New task — choose agent", contentWidth, theme.accent);
      terminalChoices.forEach(([label, agent], index) => {
        ui.button(x, y + 2 + index, label, { kind: "new-terminal", agent }, index === this.terminalChoice ? theme.primary : theme.button);
      });
      button("Cancel", "back");
    } else if (this.mode === "form") {
      this.renderForm(ui, x, y, contentWidth, contentHeight);
      button("Review", "review", theme.primary);
      button("Cancel", "back");
      if (this.form!.fields.some((field) => field.key === "model" || field.key === "leaderModel")) button("Refresh models", "refresh-models");
      if (width >= 80) { button("Clear", "clear"); button("Previous", "previous"); button("Next", "next"); }
    } else if (this.mode === "detail" || this.mode === "confirm" || this.mode === "help") {
      const text = this.mode === "help" ? help : this.mode === "confirm"
        ? `${this.form!.action.destructive ? "CONFIRM CHANGE" : "Review before running"}\n\n${describe(Object.fromEntries(Object.entries(this.pending).map(([key, value]) => {
          const field = this.form!.fields.find((field) => field.key === key);
          return [field?.choiceLabels ? field.label : key, field?.multiple ? (value as string[]).map((item) => field.choiceLabels?.[item] ?? item) : field?.choiceLabels?.[String(value)] ?? value];
        })))}` : this.detail;
      const lines = wrap(text, contentWidth - 1);
      this.detailVisible = contentHeight;
      this.detailTotal = lines.length;
      this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - contentHeight)));
      lines.slice(this.scroll, this.scroll + contentHeight).forEach((line, index) => ui.text(x, y + index, line, contentWidth - 1));
      ui.scrollbar(x + contentWidth, y, contentHeight, lines.length, contentHeight, this.scroll, "detail");
      if (this.mode === "confirm") {
        button("Run action", "execute", this.form!.action.destructive ? theme.danger : theme.primary);
        button("Edit", "back");
      } else { button("Back", "back"); if (this.mode === "detail") button("Actions", "actions", theme.primary); }
    } else {
      const navigationRows = this.currentScreen === "Graph" && this.graphListOpen && !isActions ? 0 : this.renderSections(ui, x, y, contentWidth, contentHeight);
      y += navigationRows; contentHeight = Math.max(1, contentHeight - navigationRows);
      if (!isActions && contentHeight > 3 && !(this.currentScreen === "Graph" && this.currentSection.name === "Network" && contentHeight < 10)) {
        const quickRows = this.renderQuickActions(ui, x, y, contentWidth);
        y += quickRows; contentHeight -= quickRows;
      }
      if (!isActions && this.currentScreen === "Orchestrator" && this.currentSection.name === "Overview") {
        this.renderOrchestrationOverview(ui, x, y, contentWidth, contentHeight);
      } else if (!isActions && this.currentScreen === "Graph" && this.currentSection.name === "Network" && !this.graphListOpen) {
        const selected = object(this.entries()[this.selected]?.data);
        if (selected.path !== this.networkPath) { this.networkPath = String(selected.path ?? ""); this.networkPage = 0; }
        this.listVisible = 1;
        renderNetwork(ui, this.graph, selected, this.networkPage, x, y, contentWidth, contentHeight, now);
      } else {
      const entries = this.entries();
      const split = width >= 117 || (this.currentScreen === "Graph" && width >= 87 && this.graphListOpen);
      const listWidth = split ? Math.floor(contentWidth * 0.52) : contentWidth;
      const previewX = x + listWidth + 2;
      const previewWidth = contentWidth - listWidth - 2;
      const header = this.mode === "search" ? `⌕  ${this.filter}▏` : this.filter ? `⌕  ${this.filter}` : this.currentScreen === "Graph" && !isActions ? this.graphListOpen ? `${entries.length}/${object(this.graph.stats).files ?? entries.length} nodes · score ↓ · edited ↓` : `${entries.length} ${this.currentSection.name.toLowerCase()} · ${object(this.graph.stats).files ?? 0} indexed` : `${entries.length} ${isActions ? "actions" : "records"}  ·  ${isActions ? "Click to open" : "Click to preview"}`;
      ui.text(x, y, header, listWidth - 1, theme.muted);
      ui.hit(x, y, listWidth - 1, 1, { kind: "command", name: "search" });
      const rowHeight = contentHeight >= 9 && !isActions ? 2 : 1;
      const visible = Math.max(1, Math.floor((contentHeight - 1) / rowHeight));
      this.listVisible = visible;
      this.listStart = Math.max(0, Math.min(this.listStart, entries.length - visible));
      if (this.selected < this.listStart) this.listStart = this.selected;
      else if (this.selected >= this.listStart + visible) this.listStart = this.selected - visible + 1;
      const start = this.listStart;
      entries.slice(start, start + visible).forEach((entry, offset) => {
        const index = start + offset;
        const row = y + 1 + offset * rowHeight;
        const record = object(entry.data);
        const label = isActions ? entry.label : String(record.title ?? record.taskTitle ?? record.planTitle ?? record.name ?? record.label ?? record.path ?? record.summary ?? record.content ?? entry.label).split("\n")[0];
        const edit = entry.group === "Files" ? editHighlight(record, now) : undefined;
        const style = index === this.selected ? theme.selected : entry.active ? theme.success : edit?.style ?? (entry.group === "Files" && record.briefStale ? theme.danger : theme.base);
        const nodeScore = record.score ?? record.structuralScore;
        const score = this.graphListOpen && this.currentScreen === "Graph" && !isActions && typeof nodeScore === "number" ? `${nodeScore.toFixed(2)}  ` : "";
        const prefix = `${index === this.selected ? "›" : " "} ${entry.active ? "[ACTIVE] " : record.liveness === "unknown" ? "[UNVERIFIED] " : ""}${score}`;
        const stale = entry.group === "Files" && record.briefStale ? "[STALE] " : "";
        ui.text(x, row, `${prefix}${stale}${edit ? `[${edit.label}] ` : ""}${label}`, listWidth - 1, style);
        if (stale) ui.text(x + prefix.length, row, "[STALE]", Math.max(0, Math.min(7, listWidth - 1 - prefix.length)), theme.danger);
        if (rowHeight === 2) ui.text(x, row + 1, entry.group === "Files" ? `  used by ${record.usedBy ?? 0} · imports ${record.imports ?? 0}` : this.currentScreen === "Orchestrator" && ["Team", "Presets"].includes(this.currentSection.name) ? `  ${record.provider ?? "provider"} · ${record.model ?? "default model"} · ${record.enabled === false || record.selected === false ? "off" : "on"}` : `  ${entry.group}  ·  ${record.status ?? record.kind ?? record.provider ?? record.type ?? "details"}${entry.lastActivityAt ? ` · ${entry.lastActivityAt}` : ""}`, listWidth - 1, index === this.selected ? theme.selected : entry.active ? theme.success : theme.muted);
        ui.hit(x, row, listWidth - 1, rowHeight, { kind: "row", index });
      });
      if (!entries.length) {
        if (contentHeight > 2) ui.text(x + 1, y + 2, this.filter ? "No matching records" : this.currentScreen === "Graph" ? "No indexed files in this view" : `No ${this.currentSection.name.toLowerCase()} yet`, listWidth - 2, theme.accent);
        wrap(this.filter ? "Try a different search." : this.currentScreen === "Graph" ? "Build the graph, or check include/ignore paths in Settings." : "Use the buttons above or Actions to get started.", listWidth - 3).slice(0, Math.max(0, contentHeight - 4)).forEach((line, index) => ui.text(x + 1, y + 4 + index, line, listWidth - 2, theme.muted));
      }
      ui.scrollbar(x + listWidth - 1, y + 1, Math.max(1, contentHeight - 1), entries.length, visible, start, "list");
      if (split) {
        for (let row = 0; row < contentHeight; row++) ui.text(previewX - 1, y + row, "│", 1, theme.border);
        ui.text(previewX + 1, y, isActions ? "ACTION DETAILS" : "INSPECTOR", previewWidth - 2, theme.muted);
        const selected = entries[this.selected];
        const preview = selected ? isActions ? `${selected.label}\n\n${(selected.data as Action).fields.filter((field, index, fields) => !field.group || fields.findIndex((item) => item.group === field.group) === index).map((field) => `${field.group ?? field.label}${field.required ? " *" : ""}`).join("\n") || "No input required."}\n\nClick this action to open its form.` : this.currentScreen === "Graph" ? graphPreview(selected, now) : describe(selected.data) : "Select a record to see its details here.";
        const lines = wrap(preview, Math.max(1, previewWidth - 3));
        this.previewVisible = Math.max(1, contentHeight - 2);
        this.previewTotal = lines.length;
        this.previewScroll = Math.max(0, Math.min(this.previewScroll, Math.max(0, lines.length - this.previewVisible)));
        lines.slice(this.previewScroll, this.previewScroll + this.previewVisible).forEach((line, index) => {
          ui.text(previewX + 1, y + 2 + index, line, previewWidth - 3);
          if (selected?.group === "Files" && this.currentScreen === "Graph" && /[→←]/.test(line)) {
            const node = object(selected.data);
            const paths = [...(Array.isArray(node.outgoing) ? node.outgoing : []), ...(Array.isArray(node.incoming) ? node.incoming : [])];
            const path = paths.find((path) => typeof path === "string" && line.includes(path));
            if (typeof path === "string") {
              ui.text(previewX + 1, y + 2 + index, line, previewWidth - 3, theme.accent);
              ui.hit(previewX + 1, y + 2 + index, previewWidth - 3, 1, { kind: "graph-node", path });
            }
          }
        });
        this.previewRect = { x: previewX, y, width: previewWidth, height: contentHeight };
        ui.scrollbar(x + contentWidth, y + 2, this.previewVisible, lines.length, this.previewVisible, this.previewScroll, "preview");
      }
      }
      if (this.currentScreen === "Graph" && !isActions && !ui.hits.some((hit) => hit.target.kind === "command" && hit.target.name === "nodes")) button(this.graphListOpen ? "Network" : "Nodes", "nodes");
      button(isActions ? "Records" : "Actions", isActions ? "back" : "actions", theme.primary);
      const useRun = this.currentScreen === "Orchestrator" && this.currentSection.name === "Tasks" && !isActions;
      if (useRun) button("Use run", "select");
      if (width >= 70) button(this.currentScreen === "Graph" && this.currentSection.name === "Network" && !isActions ? this.graphListOpen ? "Select node" : "Details" : "Open", "open");
      const selectedEntry = this.entries()[this.selected];
      if (width >= 92 && !isActions && !useRun && (selectedEntry?.group === "Tasks" || typeof object(selectedEntry?.data).taskId === "string")) button("Select task", "select");
      button("Filter", "search");
      if (width >= 105) button("Refresh", "refresh");
    }
    ui.text(2, height - 2, `${this.busy ? "◌" : "●"} ${this.status}`, width - 4, /Failed|failed|required/.test(this.status) ? theme.danger : theme.muted);
    ui.text(2, height - 1, `Task: ${task}`, Math.max(1, width - 27), theme.muted);
    ui.button(width - 23, height - 1, "Help", { kind: "command", name: "help" });
    ui.button(width - 12, height - 1, "Quit", { kind: "command", name: "quit" });
    this.hitRegions = ui.hits;
    this.writeFrame(ui.frame());
  }

  private renderSections(ui: Surface, x: number, y: number, width: number, height: number): number {
    const options = screenSections[this.currentScreen];
    const current = this.currentSection;
    if (height < 6) {
      const index = options.indexOf(current);
      const previous = options[(index - 1 + options.length) % options.length];
      const next = options[(index + 1) % options.length];
      const end = ui.button(x, y, "‹", { kind: "section", name: previous.name });
      ui.text(end, y, current.name, Math.max(1, width - 14), theme.accent);
      ui.button(x + width - 5, y, "›", { kind: "section", name: next.name });
      return 1;
    }
    let column = x;
    let row = y;
    for (const item of options) {
      const count = sectionEntries(this.allEntries(), item).length;
      const label = `${item.name}${count ? ` ${count}` : ""}`;
      const itemWidth = [...label].length + 4;
      if (column + itemWidth > x + width) { row++; column = x; }
      if (row >= y + height - 3) break;
      column = ui.button(column, row, label, { kind: "section", name: item.name }, item === current ? theme.selected : theme.button);
    }
    return row - y + 2;
  }

  private renderQuickActions(ui: Surface, x: number, y: number, width: number): number {
    if (this.currentScreen === "Work Board") {
      let end = ui.button(x, y, "New task", { kind: "new-task" }, theme.primary);
      let row = 0;
      if (this.currentSection.name === "Sessions" && this.entries().length) {
        for (const [label, path] of [["Focus terminal", "session/focus"], ["Reopen session", "session/terminal"], ["Delete session", "session/delete"]]) {
          if (end + label.length + 4 > x + width) { end = x; row++; }
          end = ui.button(end, y + row, label, { kind: "action", path });
        }
      }
      return row + 2;
    }
    let actions: [string, string][] = [];
    const name = this.currentSection.name;
    if (this.currentScreen === "Graph") actions = this.graphListOpen ? [["Network", "nodes"]] : name === "Settings"
      ? [["Edit settings", "config/graph"]]
      : [["Build", "graph/build"], ["Nodes", "nodes"], ...(name === "Network" && this.entries().length ? [["Edit brief", "graph/brief"] as [string, string]] : []), ["Refresh briefs", "graph/brief-auto-all"]];
    else if (this.currentScreen === "Orchestrator") {
      const root = "workforce/orchestration/";
      const map: Record<string, [string, string][]> = {
        Overview: [["Start", root + "start"], ["Step", root + "step"], ["Pause", root + "pause"], ["Resume", root + "resume"], ["Stop", root + "stop"], ["Report", root + "report"]],
        Tasks: [["Start orchestration", root + "start"]],
        Runs: [["Log", "workforce/run/log"], ["Stop run", "workforce/run/stop"], ["Model", "workforce/run/set-model"]],
        Team: [["Register", "workforce/agent"], ["Edit", "workforce/agent/update"], ["Enable/disable", "workforce/agent/toggle"], ["Models", "workforce/catalog"]],
        Presets: [["Create", "workforce/default-agent/create"], ["Edit", "workforce/default-agent/update"], ["Select", "workforce/default-agent/toggle"], ["Restore", "workforce/default-agent/restore"]],
        Questions: [["Answer questions", root + "answer-questions"]],
        Approvals: [["Approve / reject", root + "approve-spawn"]],
        Plan: [["Add subtask", "workforce/subtask/add-and-spawn"], ["Request changes", root + "request-changes"]],
        Reviews: [["Report", root + "report"], ["Request changes", root + "request-changes"]],
        Settings: [["Autonomy", root + "autonomy"], ["Auto-run", root + "auto-run"], ["Leader", root + "leader"], ["Cycles", root + "add-cycles"]],
        External: [["Adopt session", "workforce/run/adopt"]],
      };
      actions = map[name] ?? [];
    } else if (this.currentScreen === "Tools" && name === "Repository") actions = [[object(this.state.config).enabled === false ? "Enable in this repo" : "Disable in this repo", "repo/enabled"]];
    if (!actions.length) return 0;
    let column = x;
    for (const [label, path] of actions) {
      if (column + label.length + 4 > x + width) break;
      column = ui.button(column, y, label, path === "nodes" ? { kind: "command", name: "nodes" } : { kind: "action", path }, theme.button);
    }
    return 2;
  }

  private renderOrchestrationOverview(ui: Surface, x: number, y: number, width: number, height: number): void {
    const orchestration = object(this.board.orchestration);
    const leader = object(this.board.leaderAgent);
    ui.text(x, y, this.board.taskTitle ?? "No orchestration selected. Start one or choose Tasks.", width, theme.accent);
    if (height > 1) ui.text(x, y + 1, `${orchestration.status ?? "idle"} · cycle ${orchestration.cycle ?? 0}/${orchestration.maxCycles ?? "—"} · ${orchestration.autonomy ?? "manual"} · auto-run ${this.board.autoRun ? "on" : "off"}`, width, theme.muted);
    if (height >= 8) ui.text(x, y + 2, `Leader: ${leader.provider ?? "not configured"} ${leader.model ?? ""}`, width, theme.muted);
    const cards = [["Runs", "runs"], ["Team", "registeredAgents"], ["Questions", "questions"], ["Approvals", "approvals"], ["Plan", "subtasks"], ["Reviews", "reviews"], ["Activity", "events"], ["Tasks", "orchestrations"]];
    const columns = width >= 56 ? 2 : 1;
    const cardWidth = Math.floor((width - (columns - 1)) / columns);
    cards.forEach(([label, key], index) => {
      const cardHeight = height >= 8 ? 2 : 1;
      const row = (height >= 8 ? 4 : 2) + Math.floor(index / columns) * cardHeight;
      if (row + cardHeight > height) return;
      const column = x + (index % columns) * (cardWidth + 1);
      const count = array(key === "registeredAgents" ? this.state.registeredAgents : this.board[key]).length;
      ui.text(column, y + row, ` ${label}  ${count}`, cardWidth, theme.selected);
      if (cardHeight === 2) ui.text(column, y + row + 1, ` Click to open ${label.toLowerCase()}`, cardWidth, theme.panel);
      ui.hit(column, y + row, cardWidth, cardHeight, { kind: "section", name: label });
    });
  }

  private renderForm(ui: Surface, x: number, y: number, width: number, height: number): void {
    const form = this.form!;
    const fieldWidth = Math.max(13, Math.min(29, Math.floor(width * 0.36)));
    const editorX = x + fieldWidth + 2;
    const editorWidth = width - fieldWidth - 2;
    this.editorRect = { x: editorX, y, width: editorWidth, height };
    const visible = Math.max(1, height - 1);
    const field = form.fields[form.index];
    const navigation = form.fields.map((item, index) => ({ field: item, index }))
      .filter(({ field: item, index }) => !item.group || form.fields.findIndex((candidate) => candidate.group === item.group) === index);
    const selected = navigation.findIndex(({ field: item, index }) => item.group ? item.group === field?.group : index === form.index);
    const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), navigation.length - visible));
    ui.text(x, y, field?.group ? "PROVIDERS" : "FIELDS", fieldWidth - 1, theme.muted);
    navigation.slice(start, start + visible).forEach(({ field: item, index }, offset) => {
      const active = start + offset === selected;
      ui.text(x, y + 1 + offset, `${active ? "›" : " "} ${item.group ?? item.label}${item.required ? " *" : ""}`, fieldWidth, active ? theme.selected : theme.base);
      ui.hit(x, y + 1 + offset, fieldWidth, 1, { kind: "field", index });
    });
    for (let row = 0; row < height; row++) ui.text(editorX - 1, y + row, "│", 1, theme.border);
    if (!field) { ui.text(editorX + 1, y, "Ready to review", editorWidth - 1, theme.accent); return; }
    const members = field.group ? form.fields.map((item, index) => ({ field: item, index })).filter(({ field: item }) => item.group === field.group) : [];
    if (members.length > 1) {
      const tabWidth = Math.floor((editorWidth - 1) / members.length);
      members.forEach(({ field: item, index }, offset) => {
        const tabX = editorX + 1 + offset * tabWidth;
        ui.text(tabX, y, ` ${item.label} `, tabWidth - 1, index === form.index ? theme.selected : theme.button);
        ui.hit(tabX, y, tabWidth - 1, 1, { kind: "field", index });
      });
    } else ui.text(editorX + 1, y, `${field.label}${field.required ? " *" : ""}${field.allowCustom && form.catalogSource ? ` · ${form.catalogSource}` : ""}`, editorWidth - 1, theme.accent);
    const value = form.values[field.key] ?? "";
    const choices = field.choices ?? (field.kind === "boolean" ? ["", "true", "false"] : undefined);
    if (choices) {
      const selected: string[] = field.multiple ? JSON.parse(value || "[]") : [value];
      if (field.multiple && choices.length) {
        const end = ui.button(editorX + 1, y + 1, "Select all", { kind: "command", name: "select-all" });
        ui.text(end + 1, y + 1, `${selected.length}/${choices.length} · Space: toggle · Ctrl+U: clear`, Math.max(0, editorX + editorWidth - end - 1), theme.muted);
      } else ui.text(editorX + 1, y + 1, field.allowCustom ? `Type or pick: ${value || "(provider default)"}` : choices.length ? "Click an option · ↑/↓ to select" : "No items available to delete. Esc to go back.", editorWidth - 1, theme.muted);
      const count = Math.max(1, height - 2);
      const active = field.multiple ? form.choiceIndex : choices.indexOf(value);
      const offset = Math.max(0, Math.min(active - Math.floor(count / 2), choices.length - count));
      choices.slice(offset, offset + count).forEach((choice, index) => {
        const marker = field.multiple ? selected.includes(choice) ? "[x]" : "[ ]" : choice === value ? "●" : "○";
        ui.text(editorX + 1, y + 2 + index, `${marker}  ${field.choiceLabels?.[choice] ?? (choice || "(not set)")}`, editorWidth - 1, offset + index === active ? theme.selected : theme.button);
        ui.hit(editorX + 1, y + 2 + index, editorWidth - 1, 1, { kind: "choice", value: choice });
      });
      return;
    }
    const hint = field.kind === "number" ? "Enter a number" : field.kind === "json" ? "JSON input" : "Type / paste  ·  Ctrl+J: newline";
    ui.text(editorX + 1, y + 1, hint, editorWidth - 1, theme.muted);
    const textWidth = Math.max(1, editorWidth - 3);
    const lines = editorLines(value, textWidth);
    let cursorRow = 0;
    lines.forEach((line, index) => { if (line.start <= form.cursor) cursorRow = index; });
    const textHeight = Math.max(1, height - 2);
    const offset = Math.max(0, Math.min(this.editorScroll ?? Math.max(0, cursorRow - textHeight + 1), lines.length - textHeight));
    this.editorOffset = offset;
    for (let row = 0; row < textHeight; row++) {
      const line = lines[offset + row] ?? { text: "", start: [...value].length };
      ui.text(editorX + 1, y + 2 + row, line.text, textWidth, theme.panel);
      ui.hit(editorX + 1, y + 2 + row, textWidth, 1, { kind: "editor", start: line.start, text: line.text });
      if (offset + row === cursorRow) {
        const chars = [...line.text];
        const column = chars.slice(0, form.cursor - line.start).reduce((sum, char) => sum + cellWidth(char), 0);
        if (column < textWidth) ui.text(editorX + 1 + column, y + 2 + row, chars[form.cursor - line.start] ?? " ", Math.max(1, cellWidth(chars[form.cursor - line.start] ?? " ")), theme.caret);
      }
    }
  }

  private loadGraph(): Promise<Data> {
    return this.background
      ? this.background.request(`/api/graph?${new URLSearchParams({ focus: "", limit: String(this.graphLimit) })}`)
      : loadGraph(this.project, "", this.graphLimit);
  }

  private writeFrame(frame: string): void {
    if (this.outputBlocked) { this.pendingFrame = frame; return; }
    if (frame === this.previousFrame) return;
    const rows = frame.split("\r\n");
    const previous = this.previousFrame.split("\r\n");
    const full = !this.previousFrame || rows.length !== previous.length;
    const update = full ? `${ESC}H${frame}${ESC}J` : rows.map((row, index) => row === previous[index] ? "" : `${ESC}${index + 1};1H${row}${ESC}K`).join("");
    this.previousFrame = frame;
    this.outputBlocked = !this.output.write(update);
  }
}

export async function startTui(project: string, options: { snapshot?: boolean } = {}): Promise<void> {
  if (!options.snapshot && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("TUI requires an interactive terminal. Run agent-bridge tui in a terminal, or use --snapshot.");
  }
  const workspacePaths = paths(project);
  if (!existsSync(workspacePaths.config) || !existsSync(workspacePaths.database)) {
    initializeProject(project);
  } else {
    ensureWorkspace(project);
  }
  if (options.snapshot) {
    const { state, board } = await loadDashboard(project);
    const graph = await loadGraph(project);
    const sections = screens.map((screen) => `${screen}\n${(screen === "Graph" ? graphEntries(graph, object(state.config)) : screenEntries(screen, state, board)).map((entry) => `  ${entry.group}: ${entry.label}`).join("\n") || "  (empty)"}`);
    process.stdout.write(`Agent Bridge ${applicationVersion}\nWorkspace: ${clean(project)}\n\n${sections.join("\n\n")}\n`);
    return;
  }
  resumeAutoRuns(project);
  await new TerminalDashboard(project).run();
}
