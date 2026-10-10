import { readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { displayError } from './display';

/**
 * A file holding one JSON state, replaced whole on every write.
 *
 * Every write lands in one step — a temp file renamed into place — and every delete in one unlink,
 * in the order they were requested: each gets a generation when requested, and lands only if
 * nothing of a later generation has landed since. So a synchronous write made as the process exits
 * can never be overwritten by an asynchronous write requested before it, whose `open()` may still
 * be pending, nor undone by a delete requested before it.
 *
 * Asynchronous writes serialize when they run, not when they are requested, so the last to land
 * carries the latest state. A failure is reported and does not stop later writes. Every write
 * answers whether it landed, so a caller holding state that must reach disk can tell a failed or
 * superseded write from one that did.
 */
export class StateFile {
  private requested = 0;
  private landed = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    /** What the file holds, for error messages. */
    private readonly what: string
  ) {}

  /** Removes the temp files an earlier launch left next to the file, ended between write and rename. */
  sweep(): void {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) {
          unlinkSync(path.join(dir, name));
        }
      }
    } catch {
      // Nothing to sweep, or nothing to be done about it.
    }
  }

  /**
   * Queues a write of what `serialize` returns when the write runs, behind what was requested before.
   * Resolves to whether this write landed: `false` when it failed or a later change landed first.
   * Never rejects.
   */
  write(serialize: () => string): Promise<boolean> {
    const generation = this.nextGeneration();
    const written = this.queue
      .then(async () => {
        if (generation < this.landed) {
          // Superseded while queued: what landed since is newer than anything requested before it.
          return false;
        }
        const tmpPath = this.tempPath(generation);
        await fs.writeFile(tmpPath, serialize(), 'utf-8');
        return this.land(
          generation,
          () => renameSync(tmpPath, this.filePath),
          () => unlinkSync(tmpPath)
        );
      })
      .catch((error) => {
        displayError(`Failed to write ${this.what}:`, error);
        return false;
      });
    this.queue = written.then(() => undefined);
    return written;
  }

  /** Writes before returning, for a process that may be about to exit. Answers whether it landed. */
  writeSync(content: string): boolean {
    const generation = this.nextGeneration();
    const tmpPath = this.tempPath(generation);
    try {
      writeFileSync(tmpPath, content, 'utf-8');
      return this.land(generation, () => renameSync(tmpPath, this.filePath));
    } catch (error) {
      displayError(`Failed to write ${this.what}:`, error);
      return false;
    }
  }

  /** Queues a delete, behind what was requested before. */
  delete(): Promise<void> {
    const generation = this.nextGeneration();
    this.queue = this.queue
      .then(() => {
        this.land(generation, () => this.unlink());
      })
      .catch((error) => displayError(`Failed to delete ${this.what}:`, error));
    return this.queue;
  }

  /** Deletes before returning, for a process that may be about to exit. */
  deleteSync(): void {
    const generation = this.nextGeneration();
    try {
      this.land(generation, () => this.unlink());
    } catch (error) {
      displayError(`Failed to delete ${this.what}:`, error);
    }
  }

  private nextGeneration(): number {
    this.requested += 1;
    return this.requested;
  }

  private tempPath(generation: number): string {
    return `${this.filePath}.${process.pid}.${generation}.tmp`;
  }

  /**
   * Applies the change unless a later one has landed already, in which case it is discarded.
   * Answers whether it was applied.
   */
  private land(generation: number, apply: () => void, discard?: () => void): boolean {
    if (generation < this.landed) {
      discard?.();
      return false;
    }
    apply();
    this.landed = generation;
    return true;
  }

  private unlink(): void {
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
