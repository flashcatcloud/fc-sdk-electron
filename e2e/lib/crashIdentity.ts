import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { User } from '@flashcatcloud/electron-sdk';

export const CRASH_USER: User = { id: 'crash-user-alice', name: 'Alice', email: 'alice@example.com' };

interface HistoryEntry<T> {
  startTime: number;
  endTime: number | null;
  value: T;
}

/** A transport flush does not wait for identity, session or view history writes. */
export async function waitForHistoryEntry<T>(
  userDataDir: string,
  fileName: string,
  matches: (entry: HistoryEntry<T>) => boolean
): Promise<HistoryEntry<T>> {
  let entry: HistoryEntry<T> | undefined;
  await expect
    .poll(
      async () => {
        try {
          const entries = JSON.parse(await readFile(join(userDataDir, fileName), 'utf8')) as HistoryEntry<T>[];
          entry = entries.find(matches);
          return entry !== undefined;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, message: `Waiting for persisted ${fileName}` }
    )
    .toBe(true);
  return entry!;
}
