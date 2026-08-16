import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { compileContext } from "@agent-bridge/core";
import {
  encodingIssueSnippet,
  encodingIssueReason,
  repairDatabaseEncoding,
  repairMojibakeText,
  scanDatabaseEncodingIssues,
  shouldRepairText,
  type RepairOptions
} from "@agent-bridge/memory";
import {
  openStore,
  paths,
  policyBudgets,
  readConfig,
  resolveTokenBudget,
} from "../workspace.js";

const repairableExtensions = new Set([".md", ".json", ".txt", ".yaml", ".yml"]);

export function registerRepair(program: Command): void {
  const repair = program.command("repair").description("Repair local agent-bridge data");

  repair
    .command("encoding")
    .description("Repair mojibake/UTF-8 text in memories and generated files")
    .option("--no-recompile", "skip recompiling compiled-context.md after repair")
    .option("--scan-only", "only scan and print suspected encoding issues")
    .option(
      "--guess-question-marks",
      "also apply the lossy Vietnamese ?-placeholder lookup table (legacy data only)"
    )
    .action((options: { recompile?: boolean; scanOnly?: boolean; guessQuestionMarks?: boolean }) => {
      const p = paths();
      const repairOptions = { repairQuestionMarks: options.guessQuestionMarks === true };
      if (options.scanOnly) {
        const dbIssues = existsSync(p.database) ? scanDatabaseEncodingIssues(p.database) : [];
        const fileIssues = scanFiles();
        printEncodingIssues(dbIssues, fileIssues);
        return;
      }

      const dbReport = existsSync(p.database)
        ? repairDatabaseEncoding(p.database, repairOptions)
        : { changed: [], suspiciousAfterRepair: [] };
      const fileChanges = repairFiles(repairOptions);

      let recompiled = false;
      if (options.recompile !== false) {
        const config = readConfig();
        if (config.currentTaskId) {
          const store = openStore();
          try {
            const pack = compileContext(store, {
              taskId: config.currentTaskId,
              agent: config.defaultAgent,
              tokenBudget: resolveTokenBudget(),
              ...policyBudgets()
            });
            writeFileSync(p.compiledContext, `${pack.renderedMarkdown}\n`, "utf8");
            recompiled = true;
          } finally {
            store.close();
          }
        }
      }

      console.log("Encoding repair complete.");
      console.log(`Database fields repaired: ${dbReport.changed.length}`);
      console.log(`Files repaired: ${fileChanges}`);
      console.log(`Compiled context regenerated: ${recompiled ? "yes" : "no"}`);
      if (dbReport.suspiciousAfterRepair.length) {
        console.log("");
        console.log("Still suspicious after repair:");
        for (const item of dbReport.suspiciousAfterRepair.slice(0, 10)) {
          console.log(`- ${item.table}.${item.column} ${item.id}: ${item.before.slice(0, 120)}`);
        }
        if (dbReport.suspiciousAfterRepair.length > 10) {
          console.log(`...and ${dbReport.suspiciousAfterRepair.length - 10} more`);
        }
        console.log("Some replacement-character damage may be irreversible.");
      }

      const fileIssues = scanFiles();
      if (fileIssues.length) {
        console.log("");
        console.log("Suspicious files after repair:");
        for (const issue of fileIssues.slice(0, 10)) {
          console.log(`- ${issue.file}: ${issue.reason}: ${issue.sample}`);
        }
        if (fileIssues.length > 10) console.log(`...and ${fileIssues.length - 10} more`);
      }
    });
}

function repairFiles(options: RepairOptions): number {
  let changed = 0;
  for (const filePath of listRepairableFiles(paths().memoryDir)) {
    const current = readFileSync(filePath, "utf8");
    if (!shouldRepairText(current, options) && !encodingIssueReason(current)) continue;
    const repaired = repairMojibakeText(current, options);
    if (repaired === current) continue;
    writeFileSync(filePath, repaired, "utf8");
    changed += 1;
  }
  return changed;
}

function scanFiles(): Array<{ file: string; reason: string; sample: string }> {
  const issues: Array<{ file: string; reason: string; sample: string }> = [];
  for (const filePath of listRepairableFiles(paths().memoryDir)) {
    const value = readFileSync(filePath, "utf8");
    const reason = encodingIssueReason(value);
    if (reason) issues.push({ file: filePath, reason, sample: encodingIssueSnippet(value) ?? sampleText(value) });
  }
  return issues;
}

function printEncodingIssues(
  dbIssues: Array<{ table: string; id: string; column: string; value: string; reason: string; snippet?: string }>,
  fileIssues: Array<{ file: string; reason: string; sample: string }>
): void {
  console.log("Encoding scan complete.");
  console.log(`Database issues: ${dbIssues.length}`);
  for (const issue of dbIssues.slice(0, 15)) {
    console.log(`- ${issue.table}.${issue.column} ${issue.id}: ${issue.reason}: ${issue.snippet ?? sampleText(issue.value)}`);
  }
  if (dbIssues.length > 15) console.log(`...and ${dbIssues.length - 15} more database issues`);

  console.log(`File issues: ${fileIssues.length}`);
  for (const issue of fileIssues.slice(0, 15)) {
    console.log(`- ${issue.file}: ${issue.reason}: ${issue.sample}`);
  }
  if (fileIssues.length > 15) console.log(`...and ${fileIssues.length - 15} more file issues`);
}

function listRepairableFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...listRepairableFiles(fullPath));
    } else if (repairableExtensions.has(extensionOf(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}

function sampleText(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 160);
}
