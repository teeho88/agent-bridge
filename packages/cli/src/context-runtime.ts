import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compileContext, type PromptPack } from "@agent-bridge/core";
import { SQLiteMemoryStore, type AgentKind } from "@agent-bridge/memory";
import { resolveWorkflowMode, type WorkflowResolution } from "./workflow.js";
import { repositoryIdentity } from "./runtime-identity.js";
import { createFreshnessContext, decisionMemories, memoryFreshness, preloadEvidence } from "./context-retrieval.js";
import { paths, policyBudgets, readConfig, redactIfEnabled, renderCurrentTask, resolveTokenBudget } from "./workspace-config.js";
import { configRuntimeRevision, openWorkspaceState } from "./config-persistence.js";
import { contentHash } from "./graph-brief.js";

export type ContextOptions = {
  freshnessRound?: ReturnType<typeof createFreshnessContext>;
  sessionId?: string;
  currentRequest?: string;
  budget?: number;
  assignmentId?: string;
  repoMap?: boolean;
  repoMapLimit?: number;
  countTokens?: (text: string) => number;
  requestId?: string;
  epoch?: string;
  bootstrap?: boolean;
};

type Manifest = {
  graphEnabled?: boolean;
  generation?: number;
  runtimeRevision?: number;
  contextHash?: string;
  taskHash?: string;
  sourceRevision?: string;
  sourceFiles?: { path: string; hash: string | null }[];
  detailsPath?: string;
  detailsHash?: string;
  tokenizer?: string;
  epoch?: string; repositoryId?: string; branch?: string;
  published?: true; delivered?: "unknown"; acknowledged?: "unknown"; applied?: "unknown";
  taskId: string; agent: AgentKind; sessionId: string; revision: string;
  requestRevision: string; requestPath: string; contextPath: string; currentTaskPath: string;
  mode: "full" | "single"; tokenCounter: "configured" | "estimate"; error?: string; tokenEstimate: number; sectionTokens?: Record<string, number>;
  omitted: PromptPack["omitted"];
  requestedMode?: "full" | "single";
  modeReason?: WorkflowResolution["reason"];
  budget?: number;
  compileDurationMs?: number;
  requestId?: string;
};

export function contextSessionDirectory(cwd: string, sessionId: string): string {
  return join(paths(cwd).memoryDir, "sessions", createHash("sha256").update(sessionId).digest("hex").slice(0, 24));
}

function sessionsForAgent(cwd: string, agent: AgentKind): string[] {
  const config = readConfig(cwd);
  const candidates = Object.entries(config.activeSessions ?? {}).filter(([, provider]) => provider === agent).map(([id]) => id);
  if (!candidates.length) {
    const current = config.currentSessions?.[agent];
    if (current) candidates.push(current);
    else candidates.push(...Object.entries(config.sessionWindows ?? {}).filter(([, window]) => window.agent === agent).map(([id]) => id));
  }
  return [...new Set(candidates)];
}

function requestHash(request: string): string {
  return createHash("sha256").update(request).digest("hex");
}

function retainedRequest(previous: Manifest | undefined, taskId: string): string {
  if (previous?.taskId !== taskId || !previous.requestPath) return "";
  const request = readFileSync(previous.requestPath, "utf8");
  if (previous.requestRevision !== requestHash(request))
    throw new Error("Request artifact hash mismatch; refresh this session");
  return request;
}

function contextSourcesRevision(store: SQLiteMemoryStore, taskId: string, currentRequest: string): string {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const query = [task.title, task.goal ?? "", currentRequest].filter(Boolean).join(" ");
  const handoff = store.getLatestHandoff(taskId);
  const content = {
    task,
    handoff,
    decisions: store.listDecisions(taskId),
    memories: store.getContextMemories(taskId, query, ["secret", "private", "prompt", "task-label-source", "latest-response"]),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function locateContext(cwd: string, agent: AgentKind, sessionId?: string): Manifest {
  const config = readConfig(cwd);
  if (!sessionId) {
    const terminal = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID?.trim();
    const sessions = sessionsForAgent(cwd, agent).filter((id) => committedManifest(cwd, `session:${id}`, join(contextSessionDirectory(cwd, id), "metadata.json")) !== undefined);
    if (terminal && sessions.includes(terminal)) sessionId = terminal;
    else {
      if (sessions.length !== 1) throw new Error("Ambiguous or missing context session. Pass --session <sessionId>.");
      sessionId = sessions[0];
    }
  }
  const manifest = committedManifest(cwd, `session:${sessionId}`, join(contextSessionDirectory(cwd, sessionId), "metadata.json"));
  if (!manifest) throw new Error("Missing context publication; refresh this session");
  if ("error" in manifest) throw new Error(String(manifest.error));
  if (manifest.graphEnabled !== (config.graph?.enabled !== false))
    throw new Error("Graph navigation setting changed; refresh this session");
  if (manifest.agent !== agent || config.sessionTasks?.[sessionId] !== manifest.taskId ||
      (config.activeSessions?.[sessionId] && config.activeSessions[sessionId] !== agent))
    throw new Error("Context binding changed; refresh this session before reading it.");
  const identity = repositoryIdentity(cwd);
  if (manifest.repositoryId && (identity.repositoryId !== manifest.repositoryId || identity.branch !== manifest.branch))
    throw new Error("Context repository/branch changed; refresh the session.");
  if (manifest.contextHash && createHash("sha256").update(readFileSync(manifest.contextPath)).digest("hex") !== manifest.contextHash)
    throw new Error("Context artifact hash mismatch; refresh this session");
  if (manifest.taskHash && createHash("sha256").update(readFileSync(manifest.currentTaskPath)).digest("hex") !== manifest.taskHash)
    throw new Error("Task artifact hash mismatch; refresh this session");
  if (manifest.detailsPath && (!manifest.detailsHash || !existsSync(manifest.detailsPath) ||
      createHash("sha256").update(readFileSync(manifest.detailsPath)).digest("hex") !== manifest.detailsHash))
    throw new Error("Context source snapshot missing or changed; refresh this session");
  if (!manifest.requestPath || manifest.requestRevision !== requestHash(readFileSync(manifest.requestPath, "utf8")))
    throw new Error("Request artifact hash mismatch; refresh this session");
  if (!manifest.sourceRevision) throw new Error("Context sources revision missing; refresh this session");
  if (!manifest.sourceFiles) throw new Error("Context file provenance missing; refresh this session");
  for (const source of manifest.sourceFiles) {
    if ((contentHash(cwd, source.path) ?? null) !== source.hash)
      throw new Error(`Context source file changed: ${source.path}; refresh and verify source before editing or concluding.`);
  }
  const store = new SQLiteMemoryStore(paths(cwd).database, { lifecycle: config.memory });
  try {
    if (manifest.sourceRevision !== contextSourcesRevision(store, manifest.taskId, readFileSync(manifest.requestPath, "utf8")))
      throw new Error("Context sources changed; refresh this session before reading it.");
  } finally { store.close(); }
  return manifest;
}

function committedManifest(cwd: string, locator: string, legacyPath: string): Manifest | undefined {
  const runtime = openWorkspaceState(cwd);
  try {
    const publication = runtime.publication(locator);
    if (publication) return { ...JSON.parse(publication.manifest), generation: publication.generation };
    return existsSync(legacyPath) ? JSON.parse(readFileSync(legacyPath, "utf8")) : undefined;
  } finally { runtime.close(); }
}

function atomicWrite(path: string, value: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", flag: "wx", flush: true });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function immutableWrite(path: string, value: string): void {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== value) throw new Error(`Context revision collision: ${path}`);
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", flag: "wx", flush: true });
    try { linkSync(temp, path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
        try { copyFileSync(temp, path, constants.COPYFILE_EXCL); }
        catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
          if (readFileSync(path, "utf8") !== value) throw new Error(`Context revision collision: ${path}`);
        }
      } else {
        if (code !== "EEXIST") throw error;
        if (readFileSync(path, "utf8") !== value) throw new Error(`Context revision collision: ${path}`);
      }
    }
  } finally { rmSync(temp, { force: true }); }
}

function traceContext(directory: string, event: string, manifest: Manifest): void {
  appendFileSync(join(directory, "context-trace.jsonl"), `${JSON.stringify({
    event, timestamp: new Date().toISOString(), taskId: manifest.taskId, agent: manifest.agent, epoch: manifest.epoch,
    sessionId: manifest.sessionId, requestId: manifest.requestId, requestRevision: manifest.requestRevision,
    revision: manifest.revision, requestedMode: manifest.requestedMode, effectiveMode: manifest.mode,
    modeReason: manifest.modeReason, budget: manifest.budget, tokenCounter: manifest.tokenCounter,
    tokenizer: manifest.tokenizer,
    tokenEstimate: manifest.tokenEstimate, sectionTokens: manifest.sectionTokens,
    omitted: manifest.omitted, compileDurationMs: manifest.compileDurationMs,
  })}\n`, "utf8");
}

export function acknowledgeContext(cwd: string, agent: AgentKind, sessionId: string, revision: string, epoch: string): void {
  const manifest = locateContext(cwd, agent, sessionId);
  if (manifest.revision !== revision || manifest.epoch !== epoch) throw new Error("Context acknowledgement revision/epoch mismatch");
  const directory = contextSessionDirectory(cwd, sessionId);
  const path = join(directory, "cursor.json");
  atomicWrite(path, JSON.stringify({ taskId: manifest.taskId, agent, sessionId, revision, epoch, contextPath: manifest.contextPath, contentHash: createHash("sha256").update(readFileSync(manifest.contextPath)).digest("hex") }));
  traceContext(directory, "acknowledged", manifest);
}

export function synchronizeContext(cwd: string, agent: AgentKind, sessionId: string, options: { contextRetained?: boolean } = {}) {
  const manifest = locateContext(cwd, agent, sessionId);
  const directory = contextSessionDirectory(cwd, sessionId);
  const bootstrap = (reason: string) => {
    traceContext(directory, `bootstrap:${reason}`, manifest);
    return { kind: "bootstrap" as const, reason, epoch: manifest.epoch, targetRevision: manifest.revision, path: manifest.contextPath };
  };
  if (readConfig(cwd).contextEfficiency?.delta !== true) return bootstrap("delta_disabled");
  if (options.contextRetained !== true) return bootstrap("context_retention_unknown");
  const cursorPath = join(directory, "cursor.json");
  if (!existsSync(cursorPath)) return bootstrap("missing_cursor");
  let cursor: { taskId: string; agent: AgentKind; sessionId: string; revision: string; epoch: string; contextPath: string; contentHash?: string };
  try { cursor = JSON.parse(readFileSync(cursorPath, "utf8")); } catch { return bootstrap("invalid_cursor"); }
  if (!cursor || typeof cursor !== "object") return bootstrap("invalid_cursor");
  if (cursor.taskId !== manifest.taskId || cursor.agent !== agent || cursor.sessionId !== sessionId || cursor.epoch !== manifest.epoch)
    return bootstrap("binding_or_epoch_changed");
  if (!/^[a-f0-9]{64}$/.test(cursor.revision) || cursor.contextPath !== join(directory, `context-${cursor.revision}.md`) || !existsSync(cursor.contextPath))
    return bootstrap("missing_base");
  if (!cursor.contentHash || createHash("sha256").update(readFileSync(cursor.contextPath)).digest("hex") !== cursor.contentHash) return bootstrap("invalid_base");
  const sections = (markdown: string) => Object.fromEntries(markdown.split(/(?=^## )/m).map((section) => [section.split("\n")[0], section.trim()]));
  const before = sections(readFileSync(cursor.contextPath, "utf8"));
  const after = sections(readFileSync(manifest.contextPath, "utf8"));
  const delta = {
    kind: "delta", taskId: manifest.taskId, sessionId, epoch: manifest.epoch,
    baseRevision: cursor.revision, targetRevision: manifest.revision,
    added: Object.fromEntries(Object.entries(after).filter(([key]) => !(key in before))),
    updated: Object.fromEntries(Object.entries(after).filter(([key, value]) => key in before && before[key] !== value)),
    removed: Object.keys(before).filter((key) => !(key in after)),
  };
  const epochKey = createHash("sha256").update(manifest.epoch ?? "legacy").digest("hex").slice(0, 16);
  const path = join(directory, `delta-${epochKey}-${cursor.revision}-${manifest.revision}.json`);
  immutableWrite(path, `${JSON.stringify(delta, null, 2)}\n`);
  traceContext(directory, "delta_published", manifest);
  return { kind: "delta" as const, epoch: manifest.epoch, baseRevision: cursor.revision, targetRevision: manifest.revision, path };
}

export async function publishContextAsync(store: SQLiteMemoryStore, cwd: string, taskId: string, agent: AgentKind, options: ContextOptions = {}) {
  for (let attempt = 0; ; attempt++) {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const directory = options.sessionId ? contextSessionDirectory(cwd, options.sessionId) : join(paths(cwd).tasks, taskId);
    const locator = options.sessionId ? `session:${options.sessionId}` : `task:${taskId}:${agent}`;
    const previous = committedManifest(cwd, locator, join(directory, "metadata.json"));
    const request = options.currentRequest ?? retainedRequest(previous, taskId);
    const query = [task.title, task.goal ?? "", request].join(" ");
    const stamp = store.contextSnapshot(() => null).stamp;
    const round = await preloadEvidence(cwd, [...store.getContextMemories(taskId, query, ["secret", "private", "prompt", "latest-response", "task-label-source"]), ...decisionMemories(store, taskId)]);
    if (store.contextSnapshot(() => null).stamp !== stamp) {
      if (attempt < 2) continue;
      throw new Error("context_publication_conflict: memory changed during asynchronous hashing");
    }
    return publishContext(store, cwd, taskId, agent, { ...options, freshnessRound: round });
  }
}

export function publishContext(store: SQLiteMemoryStore, cwd: string, taskId: string, agent: AgentKind, options: ContextOptions = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return publishContextAttempt(store, cwd, taskId, agent, options); }
    catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !error.message.startsWith("context_publication_conflict")) throw error;
    }
  }
}

function publishContextAttempt(store: SQLiteMemoryStore, cwd: string, taskId: string, agent: AgentKind, options: ContextOptions = {}) {
  const compileStarted = performance.now();
  let task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const config = readConfig(cwd);
  const identity = repositoryIdentity(cwd);
  store.bindTaskIdentity(taskId, identity);
  const candidates = sessionsForAgent(cwd, agent).filter((id) => config.sessionTasks?.[id] === taskId);
  const sessionId = options.sessionId ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!options.sessionId && candidates.length > 1) throw new Error("Ambiguous context session. Pass --session.");
  if (sessionId && config.sessionTasks?.[sessionId] !== taskId) throw new Error("Session/task binding mismatch");
  if (sessionId && config.activeSessions?.[sessionId] && config.activeSessions[sessionId] !== agent)
    throw new Error("Session/agent binding mismatch");
  const workflow = resolveWorkflowMode(store, cwd, sessionId);
  const mode = workflow.mode;
  const directory = sessionId ? contextSessionDirectory(cwd, sessionId) : join(paths(cwd).tasks, taskId);
  mkdirSync(directory, { recursive: true });
  const metadataPath = join(directory, "metadata.json");
  const locator = sessionId ? `session:${sessionId}` : `task:${taskId}:${agent}`;
  const previous = committedManifest(cwd, locator, metadataPath);
  const publicationConfig = readConfig(cwd);
  const runtimeRevision = configRuntimeRevision(publicationConfig);
  if (sessionId && publicationConfig.sessionTasks?.[sessionId] !== taskId) throw new Error("Session/task binding mismatch");
  if (sessionId && publicationConfig.activeSessions?.[sessionId] && publicationConfig.activeSessions[sessionId] !== agent)
    throw new Error("Session/agent binding mismatch");
  const publishManifest = (manifest: Manifest, stamp: string) => {
    const runtime = openWorkspaceState(cwd);
    try {
      manifest.runtimeRevision = runtimeRevision;
      manifest.generation = store.commitContextSnapshot(stamp, () => runtime.commitPublication(locator,
        previous?.generation ?? 0, runtimeRevision, taskId, sessionId, JSON.stringify(manifest)));
    } finally { runtime.close(); }
    atomicWrite(metadataPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const currentRequest = options.currentRequest === undefined
    ? retainedRequest(previous, taskId) : redactIfEnabled(options.currentRequest, cwd);
  const freshnessRound = options.freshnessRound ?? createFreshnessContext(cwd);
  const contextQuery = [task.title, task.goal ?? "", currentRequest].filter(Boolean).join(" ");
  for (const memory of [...store.getContextMemories(taskId, contextQuery, ["secret", "private", "prompt", "task-label-source", "latest-response"]), ...decisionMemories(store, taskId)]) {
    if (memory.evidence) memoryFreshness(store, cwd, memory, freshnessRound);
  }
  const preparationStamp = store.contextSnapshot(() => null).stamp;
  const policyBudget = resolveTokenBudget(cwd);
  const shortBootstrap = options.bootstrap ?? config.contextEfficiency?.bootstrap ?? false;
  const budget = options.budget ?? (shortBootstrap && policyBudget === 4000 ? 600 : mode === "single" && policyBudget === 4000 ? 1500 : policyBudget);
  const handoff = store.getLatestHandoff(taskId);
  const requestRevision = requestHash(currentRequest);
  const sourcePaths = [...new Set(handoff?.filesChanged ?? [])].sort();
  const sourceFiles = sourcePaths.map((path) => ({ path, hash: contentHash(cwd, path) ?? null }));
  const requestPath = join(directory, `request-${requestRevision}.txt`);
  const sectionBudgets = policyBudgets(cwd);
  const sourceRevision = contextSourcesRevision(store, taskId, currentRequest);
  immutableWrite(requestPath, currentRequest);
  const requestId = options.requestId ?? (options.currentRequest !== undefined ? randomUUID() : previous?.requestId);
  let pack: PromptPack;
  let details: string | undefined;
  let detailsPath: string;
  let snapshotStamp = store.contextSnapshot(() => null).stamp;
  try {
    const snapshot = store.contextSnapshot(() => {
      task = store.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const sourceSnapshot = JSON.stringify({ schemaVersion: 1, task, currentRequest,
        decisions: store.listDecisions(taskId),
        memories: store.getContextMemories(taskId, contextQuery, ["secret", "private", "prompt", "task-label-source", "latest-response"]),
        handoff: store.getLatestHandoff(taskId), graphEnabled: config.graph?.enabled !== false }, null, 2);
      const selectedDetailsPath = join(directory, `context-details-${createHash("sha256").update(sourceSnapshot).digest("hex")}.json`);
      const compiled = compileContext(store, { taskId, agent, tokenBudget: budget, ...sectionBudgets,
        currentRequest, includeFiles: false, graphEnabled: config.graph?.enabled !== false, assignmentId: options.assignmentId, countTokens: options.countTokens, detailsPath: selectedDetailsPath });
      return { compiled, sourceSnapshot, selectedDetailsPath };
    });
    pack = snapshot.value.compiled;
    details = Object.values(pack.omitted).some((count) => count > 0) ? snapshot.value.sourceSnapshot : undefined;
    detailsPath = snapshot.value.selectedDetailsPath;
    snapshotStamp = snapshot.stamp;
    if (snapshotStamp !== preparationStamp) throw new Error("context_publication_conflict: memory changed during preparation");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("context_publication_conflict")) throw error;
    const essentials = {
      "full-task.md": renderCurrentTask(task!), "current-request.txt": currentRequest,
      "essential-handoff.json": JSON.stringify(handoff ?? null),
      "constraints.json": JSON.stringify(store.getContextMemories(taskId, "", ["secret", "private", "prompt", "task-label-source", "latest-response"])
        .filter((memory) => memory.type === "constraint").map((memory) => memory.content)),
    };
    const failureDirectory = join(directory, `failure-${randomUUID()}`);
    mkdirSync(failureDirectory, { recursive: true });
    for (const [name, value] of Object.entries(essentials)) immutableWrite(join(failureDirectory, name), value);
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = `${message}\nRead all essential files before acting:\nFull task: ${join(failureDirectory, "full-task.md")}\nCurrent request: ${join(failureDirectory, "current-request.txt")}\nHandoff: ${join(failureDirectory, "essential-handoff.json")}\nConstraints: ${join(failureDirectory, "constraints.json")}`;
    atomicWrite(join(directory, "error.txt"), diagnostic);
    publishManifest({ ...previous, taskId, agent, sessionId: sessionId ?? "", requestPath, requestRevision, requestId, error: diagnostic } as Manifest, snapshotStamp);
    for (const [name, value] of Object.entries(essentials)) atomicWrite(join(directory, name), value);
    appendFileSync(join(directory, "context-trace.jsonl"), `${JSON.stringify({
      event: "compile_failed", timestamp: new Date().toISOString(), taskId, agent, sessionId,
      requestId, requestRevision, requestedMode: workflow.requestedMode, effectiveMode: mode,
      modeReason: workflow.reason, budget, compileDurationMs: performance.now() - compileStarted,
      error: message,
    })}\n`, "utf8");
    throw new Error(diagnostic);
  }
  const taskMarkdown = renderCurrentTask(task!);
  for (const source of sourceFiles) {
    if ((contentHash(cwd, source.path) ?? null) !== source.hash)
      throw new Error("context_publication_conflict: source file changed during compilation");
  }
  const revision = createHash("sha256").update(JSON.stringify({ taskId, agent, mode, requestRevision, sourceRevision, sourceFiles, markdown: pack.renderedMarkdown, taskMarkdown })).digest("hex");
  const contextPath = join(directory, `context-${revision}.md`);
  const currentTaskPath = join(directory, `task-${revision}.md`);
  if (details) immutableWrite(detailsPath, details);
  immutableWrite(contextPath, pack.renderedMarkdown);
  immutableWrite(currentTaskPath, taskMarkdown);
  const manifest: Manifest = { taskId, agent, graphEnabled: config.graph?.enabled !== false, sessionId: sessionId ?? "", revision, requestRevision,
    contextHash: createHash("sha256").update(pack.renderedMarkdown).digest("hex"),
    taskHash: createHash("sha256").update(taskMarkdown).digest("hex"),
    sourceRevision,
    sourceFiles,
    detailsPath: details ? detailsPath : undefined,
    detailsHash: details ? createHash("sha256").update(details).digest("hex") : undefined,
    epoch: options.epoch ?? (previous?.taskId === taskId && previous?.agent === agent ? previous.epoch : undefined) ?? randomUUID(),
    repositoryId: identity.repositoryId, branch: identity.branch, published: true, delivered: "unknown", acknowledged: "unknown", applied: "unknown",
    tokenizer: options.countTokens ? "configured-counter" : "script-aware-v1",
    requestPath, contextPath, currentTaskPath, mode, requestedMode: workflow.requestedMode, modeReason: workflow.reason,
    budget, compileDurationMs: performance.now() - compileStarted, requestId,
    tokenCounter: options.countTokens ? "configured" : "estimate", tokenEstimate: pack.tokenEstimate, sectionTokens: pack.sectionTokens, omitted: pack.omitted };
  publishManifest(manifest, snapshotStamp);
  traceContext(directory, "published", manifest);
  atomicWrite(paths(cwd).currentTask, taskMarkdown);
  atomicWrite(paths(cwd).compiledContext, pack.renderedMarkdown);
  const taskDirectory = join(paths(cwd).tasks, taskId);
  mkdirSync(taskDirectory, { recursive: true });
  atomicWrite(join(taskDirectory, "compiled-context.md"), pack.renderedMarkdown);
  const projection = { schemaVersion: 1, locator, sessionId, taskId, revision, epoch: manifest.epoch, generation: manifest.generation,
    contextPath, currentTaskPath, contextHash: manifest.contextHash, taskHash: manifest.taskHash };
  atomicWrite(join(taskDirectory, "projection.json"), JSON.stringify(projection));
  atomicWrite(join(paths(cwd).memoryDir, "projection.json"), JSON.stringify(projection));
  return Object.assign(pack, { contextPath, currentTaskPath, sessionId, mode, revision, budget, tokenCounter: options.countTokens ? "configured" : "estimate" });
}
