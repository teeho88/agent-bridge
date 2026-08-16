import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { AgentKind, Handoff } from "@agent-bridge/memory";
import {
  getActiveTaskId,
  openStore,
  parseList,
  paths,
  readStdinUtf8,
  redactIfEnabled,
  syncCurrentTaskArtifact
} from "../workspace.js";

export function registerHandoff(program: Command): void {
  const handoff = program.command("handoff").description("Create handoff packets");

  handoff
    .command("create")
    .option("--summary <summary>", "handoff summary (omit when using --stdin)")
    .option("--from <agent>", "source agent")
    .option("--to <agent>", "target agent")
    .option("--task <taskId>", "task id")
    .option("--done <items>", "done items")
    .option("--next <items>", "next actions")
    .option("--risks <items>", "risks")
    .option("--files-changed <items>", "files changed")
    .option("--stdin", "read summary from stdin as raw UTF-8 (safe for non-ASCII)")
    .action(
      async (options: {
        summary?: string;
        from?: AgentKind;
        to?: AgentKind;
        task?: string;
        done?: string;
        next?: string;
        risks?: string;
        filesChanged?: string;
        stdin?: boolean;
      }) => {
        const rawSummary = options.stdin ? await readStdinUtf8() : options.summary;
        if (!rawSummary) {
          throw new Error("No handoff summary. Provide --summary or pipe text with --stdin.");
        }
        const redactList = (value?: string) => parseList(value).map((item) => redactIfEnabled(item));
        const store = openStore();
        try {
          const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.from);
          syncCurrentTaskArtifact(store, taskId);
          const created = store.upsertTaskHandoff({
            taskId,
            fromAgent: options.from,
            toAgent: options.to,
            summary: redactIfEnabled(rawSummary),
            done: redactList(options.done),
            next: redactList(options.next),
            risks: redactList(options.risks),
            filesChanged: redactList(options.filesChanged)
          });
          writeHandoffArtifacts(process.cwd(), created);
          store.addMemory({
            taskId,
            type: "handoff",
            content: created.summary,
            summary: created.summary,
            importance: 5,
            sourceAgent: options.from
          });
          console.log(`Created handoff ${created.id}`);
        } finally {
          store.close();
        }
      }
    );
}

function bullets(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None recorded.";
}

export function renderHandoffMarkdown(handoff: Handoff): string {
  return [
    "# Handoff",
    "",
    `From: ${handoff.fromAgent ?? "unknown"}`,
    `To: ${handoff.toAgent ?? "unknown"}`,
    "",
    "## Summary",
    handoff.summary,
    "",
    "## Done",
    bullets(handoff.done),
    "",
    "## Next",
    bullets(handoff.next),
    "",
    "## Risks",
    bullets(handoff.risks),
    "",
    "## Files Changed",
    bullets(handoff.filesChanged),
    ""
  ].join("\n");
}

export function writeHandoffArtifacts(cwd: string, handoff: Handoff): void {
  const p = paths(cwd);
  writeFileSync(p.handoffJson, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  writeFileSync(p.handoffMd, renderHandoffMarkdown(handoff), "utf8");
}
