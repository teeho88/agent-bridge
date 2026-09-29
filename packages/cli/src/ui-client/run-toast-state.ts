export const RUN_TOAST_READ_IDS_KEY = 'agent-bridge.readRunToastIds';
const MAX_READ_RUN_TOAST_IDS = 200;

interface RunToastStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadReadRunToastIds(storage: RunToastStorage): Set<string> {
  try {
    const value = JSON.parse(storage.getItem(RUN_TOAST_READ_IDS_KEY) || '[]');
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter(item => typeof item === 'string').slice(-MAX_READ_RUN_TOAST_IDS));
  } catch {
    return new Set();
  }
}

export function rememberReadRunToastId(
  storage: RunToastStorage,
  readIds: Set<string>,
  runId: string,
): void {
  readIds.delete(runId);
  readIds.add(runId);
  while (readIds.size > MAX_READ_RUN_TOAST_IDS) {
    const oldest = readIds.values().next().value;
    if (typeof oldest !== 'string') break;
    readIds.delete(oldest);
  }
  try {
    storage.setItem(RUN_TOAST_READ_IDS_KEY, JSON.stringify([...readIds]));
  } catch {}
}
