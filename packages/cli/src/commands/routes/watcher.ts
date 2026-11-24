import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repositoryEnabled } from "../../repository.js";

// The background file watcher the dashboard can start and stop.

export let watcherProcess: ChildProcess | null = null;

export function isWatcherRunning(): boolean {
  return (
    watcherProcess !== null &&
    watcherProcess.exitCode === null &&
    !watcherProcess.killed
  );
}

export function startWatcher(cwd: string): boolean {
  if (!repositoryEnabled(cwd)) return false;
  if (isWatcherRunning()) return true;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../index.js", import.meta.url)), "watch", "--project", cwd],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const clear = (): void => {
    if (watcherProcess === child) watcherProcess = null;
  };
  child.on("exit", clear);
  child.on("error", clear);
  watcherProcess = child;
  return isWatcherRunning();
}

export function stopWatcher(): void {
  if (watcherProcess) {
    watcherProcess.kill();
    watcherProcess = null;
  }
}
