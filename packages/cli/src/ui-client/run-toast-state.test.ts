import { describe, expect, it } from 'vitest';
import {
  loadReadRunToastIds,
  rememberReadRunToastId,
  RUN_TOAST_READ_IDS_KEY,
} from './run-toast-state.js';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  } as Storage;
}

describe('run toast read state', () => {
  it('persists a read notification across a page reload', () => {
    const storage = memoryStorage();
    const firstPage = loadReadRunToastIds(storage);
    rememberReadRunToastId(storage, firstPage, 'run-failed');

    const refreshedPage = loadReadRunToastIds(storage);
    expect(refreshedPage.has('run-failed')).toBe(true);
  });

  it('ignores malformed stored state', () => {
    const storage = memoryStorage();
    storage.setItem(RUN_TOAST_READ_IDS_KEY, '{bad json');
    expect(loadReadRunToastIds(storage)).toEqual(new Set());
  });
});
