import { appendFileSync, existsSync, realpathSync, openSync, closeSync, readSync, statSync, createReadStream } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { estimateTokens, firstLineSummary, redactSecrets } from "@agent-bridge/core";
import { foldDiacritics, searchTerms, type Decision, type Memory, type SQLiteMemoryStore } from "@agent-bridge/memory";
import { repositoryIdentity } from "./runtime-identity.js";
import { paths, readConfig } from "./workspace-config.js";

const historyExcludedTags = ["secret", "private", "prompt", "latest-response", "task-label-source"];

export function createFreshnessContext(cwd: string) {
  return { root: realpathSync.native(cwd), ignorePaths: readConfig(cwd).security?.ignorePaths ?? [],
    paths: new Map<string, string | undefined>(), hashes: new Map<string, string | undefined>() };
}

export async function preloadEvidence(cwd: string, memories: Memory[], round = createFreshnessContext(cwd), concurrency = 4) {
  const files = [...new Set(memories.filter((memory) => memory.evidence?.contentHash).map((memory) => evidenceFile(cwd, memory.evidence!.source, round)).filter((path): path is string => Boolean(path)))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length) {
      const path = files[next++];
      try {
        const before = statSync(path);
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) hash.update(chunk);
        const after = statSync(path);
        round.hashes.set(path, before.size === after.size && before.mtimeMs === after.mtimeMs ? hash.digest("hex") : undefined);
      } catch { round.hashes.set(path, undefined); }
    }
  }));
  return round;
}

export function evidenceFile(cwd: string, source: string, round = createFreshnessContext(cwd)): string | undefined {
  if (round.paths.has(source)) return round.paths.get(source);
  if (isAbsolute(source)) return undefined;
  const path = resolve(cwd, source);
  const within = (candidate: string) => { const rel = relative(round.root, candidate); return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel); };
  if (!within(path) || !existsSync(path) || !within(realpathSync.native(path)) || !statSync(path).isFile()) return undefined;
  const normalized = relative(cwd, path).replace(/\\/g, "/");
  if (normalized.split("/").some((part) => [".git", ".aws", ".env", "credentials", "secrets"].includes(part))) return undefined;
  if (round.ignorePaths.some((pattern) => normalized.includes(pattern.replace(/[*]/g, "")))) return undefined;
  const canonical = realpathSync.native(path);
  round.paths.set(source, canonical);
  return canonical;
}

export function memoryFreshness(store: SQLiteMemoryStore, cwd: string, memory: Memory, round = createFreshnessContext(cwd), persistStaleness = true): "fresh" | "stale" | "unknown" {
  if (memory.stale) return "stale";
  if (!memory.evidence) return "unknown";
  const path = evidenceFile(cwd, memory.evidence.source, round);
  let valid = false;
  try {
    if (path && memory.evidence.contentHash && !round.hashes.has(path)) {
      const fd = openSync(path, "r");
      try {
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(65536);
        let size: number;
        while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
        round.hashes.set(path, hash.digest("hex"));
      } finally { closeSync(fd); }
    }
    valid = Boolean(path && (!memory.evidence.contentHash || round.hashes.get(path) === memory.evidence.contentHash));
  } catch { if (path) round.hashes.set(path, undefined); }
  if (!valid) {
    if (persistStaleness) store.markMemoryStale(memory.id);
    return "stale";
  }
  return memory.evidence.contentHash ? "fresh" : "unknown";
}

export function decisionMemories(store: SQLiteMemoryStore, taskId: string): Memory[] {
  return store.listDecisions(taskId).map(decisionMemory);
}

function decisionMemory(decision: Decision): Memory {
  return { id: decision.id, taskId: decision.taskId, type: "decision", stale: decision.stale, content: `${decision.decision}${decision.reason ? `; reason: ${decision.reason}` : ""}; scope: ${decision.scope ?? "unspecified"}${decision.relatedFiles.length ? `; files: ${decision.relatedFiles.join(", ")}` : ""}`, importance: 4, tags: [], evidence: decision.evidence, createdAt: decision.createdAt, updatedAt: decision.createdAt };
}

function historicalTask(store: SQLiteMemoryStore, cwd: string, taskId: string) {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const identity = repositoryIdentity(cwd, { includeBaseCommit: false });
  if (task.repositoryId && task.repositoryId !== identity.repositoryId) throw new Error("Task belongs to another repository.");
  return { task, sameBranch: !task.branch || task.branch === identity.branch };
}

export function searchContextTasks(store: SQLiteMemoryStore, cwd: string, query: string, limit = 3) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("Task search limit must be between 1 and 5.");
  const terms = searchTerms(query);
  if (terms.length === 0) return { items: [] };
  const repositoryId = repositoryIdentity(cwd, { includeBaseCommit: false }).repositoryId;
  const memoryMatches = new Set(store.searchMemories(query, { excludeTags: historyExcludedTags, limit: 100 }).map((memory) => memory.taskId));
  const items = [];
  for (const task of store.listTasks(-1)) {
    if (task.repositoryId && task.repositoryId !== repositoryId) continue;
    const handoff = store.getLatestHandoff(task.id);
    const fields = [
      ["title", task.title, 3],
      ["goal", task.goal ?? "", 2],
      ["handoff", [handoff?.summary, ...(handoff?.next ?? []), ...(handoff?.filesChanged ?? [])].join(" "), 1],
    ] as const;
    const matchedFields: string[] = [];
    let score = task.id === query.trim() ? 100 : 0;
    if (score) matchedFields.push("id");
    for (const [field, value, weight] of fields) {
      const words = new Set(searchTerms(value));
      const matches = terms.filter((term) => words.has(term)).length;
      if (!matches) continue;
      matchedFields.push(field);
      score += weight * matches * (matches === terms.length ? 2 : 1);
    }
    if (memoryMatches.has(task.id)) {
      matchedFields.push("memory");
      score += 1;
    }
    if (score) items.push({ taskId: task.id, title: firstLineSummary(redactSecrets(task.title), 120), status: task.status, matchedFields, score });
  }
  return { items: items.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...item }) => item) };
}

export function readContextHandoff(store: SQLiteMemoryStore, cwd: string, taskId: string) {
  historicalTask(store, cwd, taskId);
  const handoff = store.getLatestHandoff(taskId);
  if (!handoff) return { taskId, found: false };
  const excerpt = (value: string, max: number) => redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, max);
  return { taskId, found: true, summary: excerpt(handoff.summary, 600), next: handoff.next.slice(0, 3).map((value) => excerpt(value, 120)) };
}

export function queryContext(store: SQLiteMemoryStore, cwd: string, taskId: string, query: string, options: { limit?: number; budget?: number; includeRepo?: boolean } = {}) {
  const { task, sameBranch } = historicalTask(store, cwd, taskId);
  const limit = options.limit ?? 5;
  const budget = options.budget ?? 600;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5 || !Number.isFinite(budget) || budget <= 0) throw new Error("Invalid retrieval limit/budget");
  const items: Array<{ id: string; type: string; summary: string; freshness: string; evidence?: string }> = [];
  const revision = task.revision ?? 0;
  const emptyHint = "Open task source or evidence paths; no matching task memory.";
  if (estimateTokens(JSON.stringify({ taskId, revision, items, next: emptyHint })) > budget) throw new Error("Retrieval metadata exceeds budget");
  const round = createFreshnessContext(cwd);
  const terms = searchTerms(query);
  const normalize = (text: string) => foldDiacritics(text).toLowerCase().replace(/\s+/g, " ").trim();
  const taskEchoes = new Set([task?.title, task?.goal, query].filter((item): item is string => Boolean(item)).map(normalize));
  const informative = (memory: Memory) => memory.type !== "note" || Boolean(memory.evidence) ||
    (!taskEchoes.has(normalize(memory.content)) && !taskEchoes.has(normalize(memory.summary ?? memory.content)));
  const candidates = terms.length ? [...store.searchMemories(query, { taskId, scope: options.includeRepo ? "task-and-repo" : "task", excludeTags: historyExcludedTags, limit: 100 }),
    ...decisionMemories(store, taskId).filter((memory) => terms.some((term) => searchTerms(memory.content).includes(term)))].filter(informative) : [];
  const ranked = candidates.map((memory) => ({ memory, freshness: memoryFreshness(store, cwd, memory, round, sameBranch),
    coverage: terms.filter((term) => foldDiacritics(memory.content).includes(term)).length }))
    .sort((a, b) => Number(a.freshness === "stale") - Number(b.freshness === "stale") || b.coverage - a.coverage);
  for (const { memory, freshness } of ranked) {
    if (memory.tags.some((tag) => historyExcludedTags.includes(tag))) continue;
    const item = { id: memory.id, type: memory.type, summary: firstLineSummary(redactSecrets(memory.summary || memory.content), 200), freshness, evidence: memory.evidence && evidenceFile(cwd, memory.evidence.source, round) ? memory.evidence.source : undefined };
    if (estimateTokens(JSON.stringify({ taskId, revision, items: [...items, item] })) > budget) continue;
    items.push(item);
    if (items.length === limit) break;
  }
  const result = { taskId, revision, items, ...(items.length ? {} : { next: emptyHint }) };
  appendFileSync(join(paths(cwd).memoryDir, "retrieval-trace.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), taskId, revision, query: redactSecrets(query), resultIds: items.map((item) => item.id), outputTokens: estimateTokens(JSON.stringify(result)), tokenCounter: "estimate" })}\n`);
  return result;
}

export function expandContext(store: SQLiteMemoryStore, cwd: string, taskId: string, id: string, budget = 600) {
  const { sameBranch } = historicalTask(store, cwd, taskId);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("Invalid expansion budget");
  const decision = store.getDecision(id, taskId);
  const currentMemory = store.getMemory(id, taskId);
  const memory = currentMemory ?? store.getMemoryHistory(id, taskId) ?? (decision ? decisionMemory(decision) : undefined);
  if (!memory || memory.tags.some((tag) => historyExcludedTags.includes(tag))) return { taskId, id, found: false };
  const content = redactSecrets(memory.content);
  const freshness = memoryFreshness(store, cwd, memory, undefined, sameBranch);
  const envelope = { taskId, id, found: true, freshness, ...(!currentMemory && !decision ? { history: true, supersededBy: memory.supersededBy } : {}), content: "", truncated: false };
  if (estimateTokens(JSON.stringify(envelope)) > budget) throw new Error("Expansion metadata exceeds budget");
  let end = content.length;
  while (estimateTokens(JSON.stringify({ ...envelope, content: content.slice(0, end), truncated: end < content.length })) > budget) end = Math.floor(end * 0.9);
  const result = { ...envelope, content: content.slice(0, end), truncated: end < content.length };
  appendFileSync(join(paths(cwd).memoryDir, "retrieval-trace.jsonl"), `${JSON.stringify({ event: "expand", timestamp: new Date().toISOString(), taskId, revision: store.getTask(taskId)?.revision, resultIds: [id], outputTokens: estimateTokens(JSON.stringify(result)), tokenCounter: "estimate" })}\n`);
  return result;
}
