import { dateNow } from '@flashcatcloud/browser-core';
import { appendFileSync, mkdirSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ProducerConfig {
  trackPath: string;
  batchSize: number;
}

/**
 * Writes serialized event data to `.tmp` batch files on disk.
 * When the current file exceeds {@link ProducerConfig.batchSize}, it is rotated
 * (renamed from `.tmp` to `.log`) so the {@link BatchConsumer} can pick it up.
 */
export class BatchProducer {
  private trackPath: string;
  private batchSize: number;
  private currentBatchFile: string | null = null;
  private currentBatchSize = 0;
  /** Posted, not written yet: the queue takes from the front, in order. */
  private pending: unknown[] = [];
  private draining: Promise<void> = Promise.resolve();
  /** The timestamp of the last batch file named, so that the next is named after a later one. */
  private lastBatchTimestamp = 0;
  /**
   * The batch file an asynchronous append is writing to, if one is: `writePendingSync` must not
   * write to it meanwhile — a large event is appended in several chunks, and a line written between
   * two of them would corrupt both — so it moves on to a new batch and leaves that one to the
   * append, which rotates it once done.
   */
  private inFlightFile: string | null = null;

  private constructor(config: ProducerConfig) {
    this.trackPath = config.trackPath;
    this.batchSize = config.batchSize;
  }

  /** Creates and fully initializes a BatchProducer instance. */
  static async create(config: ProducerConfig) {
    const producer = new BatchProducer(config);
    await producer.ensureTrackDirectoryExists();
    await producer.rotateOrphanedBatches();

    return producer;
  }

  /** Enqueues data to be appended to the current batch file. Writes are serialized, in call order. */
  post(data: unknown) {
    this.pending.push(data);
    this.draining = this.draining.then(() => this.drain());
  }

  /**
   * Writes everything posted but not written yet before returning, for a process that may be about
   * to exit: the queue only writes on later turns of the event loop, and there may be none.
   *
   * A write the queue has in flight completes on its own and lands after these; every line stays
   * whole, only the order differs. If that write's rotation is in flight too, its line goes to a
   * `.tmp` the rename has just emptied, which the next launch picks up as an orphan rather than
   * loses. A write that fails is dropped, as the queue drops it.
   */
  writePendingSync() {
    while (this.pending.length > 0) {
      const data = this.pending.shift();
      try {
        this.writeDataSync(data);
      } catch {
        // Same contract as the queue: a write that fails is dropped.
      }
    }
  }

  /** Waits for pending writes to complete and rotates the current batch file. */
  async flush() {
    await this.draining;
    await this.rotateBatch();
  }

  /**
   * An item leaves `pending` only once its append is issued: until then `writePendingSync` can
   * still take it, and the asynchronous steps before the append (the directory check, a rotation)
   * are where an exit would otherwise lose it.
   */
  private async drain() {
    while (this.pending.length > 0) {
      const data = this.pending[0];
      let serialized: string;
      try {
        serialized = `${JSON.stringify(data)}\n`;
      } catch {
        // Not serializable (a BigInt in a context, say): dropped, like a write that fails.
        this.pending.shift();
        continue;
      }
      const dataSize = Buffer.byteLength(serialized, 'utf8');
      try {
        await this.ensureTrackDirectoryExists();
        if (this.currentBatchSize + dataSize > this.batchSize && this.currentBatchSize > 0) {
          await this.rotateBatch();
        }
      } catch {
        // The append below reports its own failure.
      }
      if (this.pending[0] !== data) {
        // Written synchronously in the meantime.
        continue;
      }
      this.pending.shift();
      const filePath = this.getCurrentBatchPath();
      const file = this.currentBatchFile!;
      this.inFlightFile = file;
      try {
        await fs.appendFile(filePath, serialized, 'utf8');
        if (this.currentBatchFile === file) {
          this.currentBatchSize += dataSize;
        }
      } catch {
        // Silently ignore write errors to ensure the queue continues processing
      } finally {
        this.inFlightFile = null;
      }
      if (this.currentBatchFile !== file) {
        // The batch moved on while this append was in flight: nothing else writes to this file, and
        // only a rotation makes it uploadable.
        await this.renameBatchFile(file);
      }
    }
  }

  /** Creates the track directory if it does not already exist. */
  private async ensureTrackDirectoryExists() {
    try {
      await fs.access(this.trackPath);
    } catch {
      await fs.mkdir(this.trackPath, { recursive: true });
    }
  }

  /** Renames any leftover `.tmp` files from prior sessions to `.log` so the consumer can upload them. */
  private async rotateOrphanedBatches() {
    try {
      const files = await fs.readdir(this.trackPath);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          await this.renameBatchFile(file);
        }
      }
    } catch {
      // Directory read failed — nothing to recover
    }
  }

  /**
   * Generates a timestamp-based `.tmp` file name for a new batch. Strictly increasing: two batches
   * rotated within the same millisecond — a burst written before an exit, say — would otherwise
   * share a name, and the second `.log` would replace the first.
   */
  private generateBatchFileName() {
    this.lastBatchTimestamp = Math.max(dateNow(), this.lastBatchTimestamp + 1);
    return `batch-${this.lastBatchTimestamp}.tmp`;
  }

  /** Returns the full path to the current batch file, creating a new name if needed. */
  private getCurrentBatchPath() {
    if (!this.currentBatchFile) {
      this.currentBatchFile = this.generateBatchFileName();
    }
    return path.join(this.trackPath, this.currentBatchFile);
  }

  /** Renames the current `.tmp` batch file to `.log` and resets the batch state. */
  private async rotateBatch() {
    const file = this.currentBatchFile;
    if (!file) {
      return;
    }
    await this.renameBatchFile(file);
    // Unless the batch moved on while the rename was in flight: the newer batch is the current one.
    if (this.currentBatchFile === file) {
      this.currentBatchFile = null;
      this.currentBatchSize = 0;
    }
  }

  /** `drain`'s write of one item, for `writePendingSync`. */
  private writeDataSync(data: unknown) {
    mkdirSync(this.trackPath, { recursive: true });
    const serialized = `${JSON.stringify(data)}\n`;
    const dataSize = Buffer.byteLength(serialized, 'utf8');
    if (this.inFlightFile !== null && this.inFlightFile === this.currentBatchFile) {
      // See `inFlightFile`: the append rotates that file once it is done with it.
      this.currentBatchFile = null;
      this.currentBatchSize = 0;
    } else if (this.currentBatchSize + dataSize > this.batchSize && this.currentBatchSize > 0) {
      this.rotateBatchSync();
    }
    appendFileSync(this.getCurrentBatchPath(), serialized, 'utf8');
    this.currentBatchSize += dataSize;
  }

  /** `rotateBatch` for `writePendingSync`: the rename is attempted in place, and the state is reset either way. */
  private rotateBatchSync() {
    if (!this.currentBatchFile) {
      return;
    }
    const tmpPath = path.join(this.trackPath, this.currentBatchFile);
    try {
      renameSync(tmpPath, tmpPath.replace(/\.tmp$/, '.log'));
    } catch {
      // File doesn't exist or rename failed - silently ignore
    }
    this.currentBatchFile = null;
    this.currentBatchSize = 0;
  }

  /**
   * Renames a `.tmp` batch file to `.log` so the consumer can pick it up — never onto a `.log`
   * that exists: a `.tmp` can share its name with one when an append still in flight recreated it
   * after a synchronous rotation, and `rename` would replace the earlier batch with it.
   */
  private async renameBatchFile(file: string) {
    const tmpPath = path.join(this.trackPath, file);
    const logPath = tmpPath.replace(/\.tmp$/, '.log');

    try {
      await fs.access(tmpPath);
      await fs.rename(tmpPath, await this.freeLogPath(logPath));
    } catch {
      // File doesn't exist or rename failed - silently ignore
    }
  }

  private async freeLogPath(logPath: string): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      const candidate = attempt === 0 ? logPath : logPath.replace(/\.log$/, `-${attempt}.log`);
      try {
        await fs.stat(candidate);
      } catch {
        return candidate;
      }
    }
  }
}
