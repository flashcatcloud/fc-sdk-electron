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
  private writeQueue: Promise<void> = Promise.resolve();

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

  /** Enqueues data to be appended to the current batch file. Writes are serialized. */
  post(data: unknown) {
    this.writeQueue = this.writeQueue
      .then(() => this.writeData(data))
      .catch(() => {
        // Silently ignore write errors to ensure the queue continues processing
      });
  }

  /**
   * Writes `data` before returning, for a caller that may not get another turn of the event loop —
   * the process may be about to exit, and the queue only writes on later turns.
   *
   * It lands behind what the queue has already written and ahead of what it has not; every line
   * stays whole, only the order across the two differs. A rotation the queue has in flight is the
   * one gap: the line then goes to a `.tmp` the rename has just emptied, which is picked up as an
   * orphan on the next launch rather than lost. Write errors are dropped, as `post()` drops them.
   */
  postSync(data: unknown) {
    try {
      mkdirSync(this.trackPath, { recursive: true });
      const serialized = `${JSON.stringify(data)}\n`;
      const dataSize = Buffer.byteLength(serialized, 'utf8');
      if (this.currentBatchSize + dataSize > this.batchSize && this.currentBatchSize > 0) {
        this.rotateBatchSync();
      }
      appendFileSync(this.getCurrentBatchPath(), serialized, 'utf8');
      this.currentBatchSize += dataSize;
    } catch {
      // Same contract as the queue: a write that fails is dropped.
    }
  }

  /** Waits for pending writes to complete and rotates the current batch file. */
  async flush() {
    await this.writeQueue;
    await this.rotateBatch();
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

  /** Generates a timestamp-based `.tmp` file name for a new batch. */
  private generateBatchFileName() {
    return `batch-${dateNow()}.tmp`;
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
    if (!this.currentBatchFile) {
      return;
    }
    await this.renameBatchFile(this.currentBatchFile);
    this.currentBatchFile = null;
    this.currentBatchSize = 0;
  }

  /** `rotateBatch` for `postSync`: the rename is attempted in place, and the state is reset either way. */
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

  /** Renames a `.tmp` batch file to `.log` so the consumer can pick it up. */
  private async renameBatchFile(file: string) {
    const tmpPath = path.join(this.trackPath, file);
    const logPath = tmpPath.replace(/\.tmp$/, '.log');

    try {
      await fs.access(tmpPath);
      await fs.rename(tmpPath, logPath);
    } catch {
      // File doesn't exist or rename failed - silently ignore
    }
  }

  /** Serializes data as a JSON line and appends it to the current batch file, rotating first if the size limit would be exceeded. */
  private async writeData(data: unknown) {
    await this.ensureTrackDirectoryExists();

    const serialized = `${JSON.stringify(data)}\n`;
    const dataSize = Buffer.byteLength(serialized, 'utf8');

    if (this.currentBatchSize + dataSize > this.batchSize && this.currentBatchSize > 0) {
      await this.rotateBatch();
    }

    const batchPath = this.getCurrentBatchPath();
    await fs.appendFile(batchPath, serialized, 'utf8');
    this.currentBatchSize += dataSize;
  }
}
