import type { Command } from "commander";
import {
  getApplicationUpdateStatus,
  readApplicationUpdateProgress,
  startApplicationUpdate,
  type ApplicationUpdateProgress,
  type ApplicationUpdateStatus,
} from "../application-update.js";
import { installationRoot } from "../version.js";

function printStatus(status: ApplicationUpdateStatus): void {
  const target = status.latestVersion ? ` -> ${status.latestVersion}` : "";
  console.log(`Agent Bridge ${status.currentVersion}${target}: ${status.state}`);
  if (status.reason) console.log(status.reason);
  if (status.releaseNotes?.length) {
    for (const note of status.releaseNotes) console.log(`- ${note}`);
  }
}

async function waitForUpdate(root: string, id: string): Promise<ApplicationUpdateProgress | undefined> {
  let lastState = "";
  for (;;) {
    const progress = readApplicationUpdateProgress(root);
    if (progress?.id === id) {
      if (progress.state !== lastState) {
        console.log(progress.step);
        lastState = progress.state;
      }
      if (progress.state === "complete" || progress.state === "failed") return progress;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Check for or apply an Agent Bridge release from the Git source checkout")
    .option("--check", "check for a stable release without changing the checkout")
    .option("--apply", "apply the newest safe stable release")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { check?: boolean; apply?: boolean; json?: boolean }) => {
      const root = installationRoot();
      if (options.check && options.apply) throw new Error("Choose either --check or --apply.");
      if (!options.apply) {
        const status = await getApplicationUpdateStatus({ force: true });
        if (options.json) console.log(JSON.stringify(status));
        else printStatus(status);
        if (status.state === "failed" || status.state === "unsupported") process.exitCode = 1;
        return;
      }

      try {
        const started = await startApplicationUpdate({ root, workspace: process.cwd() });
        if (options.json) {
          const finished = await waitForUpdate(root, started.id);
          console.log(JSON.stringify({ started, progress: finished }));
          if (finished?.state === "failed") process.exitCode = 1;
          return;
        }
        console.log(`Update ${started.id} started.`);
        const finished = await waitForUpdate(root, started.id);
        if (finished?.state === "failed") {
          console.error(finished.error ?? finished.step);
          process.exitCode = 1;
        }
      } catch (error) {
        const typed = error as Error & { status?: ApplicationUpdateStatus };
        if (options.json) console.log(JSON.stringify(typed.status ?? { error: typed.message }));
        else {
          if (typed.status) printStatus(typed.status);
          else console.error(typed.message);
        }
        process.exitCode = 1;
      }
    });
}
