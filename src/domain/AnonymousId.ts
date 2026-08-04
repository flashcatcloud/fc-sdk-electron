import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { generateUUID } from '@flashcatcloud/browser-core';
import { displayError } from '../tools/display';

export const ANONYMOUS_ID_FILE_NAME = '_dd_anonymous_id';

/**
 * Device-scoped identifier, generated once and kept on disk so it survives app restarts.
 *
 * It is what makes an install countable: a session id is renewed as the user comes and goes, so
 * unique-user counts can only be derived from an identifier that outlives the session.
 */
export class AnonymousId {
  private constructor(readonly value: string) {}

  static async init(): Promise<AnonymousId> {
    const filePath = getAnonymousIdFilePath();

    const stored = await readAnonymousId(filePath);
    if (stored) {
      return new AnonymousId(stored);
    }

    const generated = generateUUID();
    try {
      await fs.writeFile(filePath, generated, 'utf-8');
    } catch (error) {
      // A write failure only costs stability across restarts: the id stays usable for this run.
      displayError('Failed to persist the anonymous id:', error);
    }
    return new AnonymousId(generated);
  }
}

function getAnonymousIdFilePath(): string {
  return path.join(app.getPath('userData'), ANONYMOUS_ID_FILE_NAME);
}

async function readAnonymousId(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}
