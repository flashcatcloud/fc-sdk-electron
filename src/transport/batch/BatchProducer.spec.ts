import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { BatchProducer } from './BatchProducer';
import type { ProducerConfig } from './BatchProducer';
import { mockFs } from '../../mocks.specUtil';

vi.mock('node:fs/promises');
const fsMocks = mockFs();

const { appendFileSync, existsSync, mkdirSync, renameSync } = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn((_path: string) => false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));
vi.mock('node:fs', () => ({ appendFileSync, existsSync, mkdirSync, renameSync }));

vi.mock('@flashcatcloud/browser-core', () => ({
  dateNow: vi.fn(() => 1234567890),
}));

function makeConfig(overrides: Partial<ProducerConfig> = {}): ProducerConfig {
  return {
    trackPath: '/mock/track/path',
    batchSize: 1024,
    ...overrides,
  };
}

describe('BatchProducer', () => {
  let config: ProducerConfig;

  beforeEach(() => {
    fsMocks.reset();
    appendFileSync.mockReset();
    existsSync.mockReset().mockReturnValue(false);
    mkdirSync.mockReset();
    renameSync.mockReset();
    config = makeConfig();

    fsMocks.access.mockResolvedValue(undefined);
    // No `.log` exists unless a test says so.
    fsMocks.stat.mockRejectedValue(new Error('ENOENT'));
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.appendFile.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create()', () => {
    it('creates track directory when missing', async () => {
      fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));

      await BatchProducer.create(config);

      expect(fsMocks.mkdir).toHaveBeenCalledWith(config.trackPath, { recursive: true });
    });

    it('does not create directory when it exists', async () => {
      fsMocks.access.mockResolvedValueOnce(undefined);

      await BatchProducer.create(config);

      expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });

    it('never rotates an orphan onto a .log that exists', async () => {
      fsMocks.readdir.mockResolvedValueOnce(['batch-111.tmp']);
      // `batch-111.log` exists — an append in flight recreated the `.tmp` after a rotation.
      fsMocks.stat.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('ENOENT'));

      await BatchProducer.create(config);

      expect(fsMocks.rename).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-111.tmp'),
        path.join(config.trackPath, 'batch-111-1.log')
      );
    });

    it('rotates orphaned .tmp files from previous sessions to .log', async () => {
      fsMocks.readdir.mockResolvedValueOnce(['batch-111.tmp', 'batch-222.tmp']);

      await BatchProducer.create(config);

      expect(fsMocks.rename).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-111.tmp'),
        path.join(config.trackPath, 'batch-111.log')
      );
      expect(fsMocks.rename).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-222.tmp'),
        path.join(config.trackPath, 'batch-222.log')
      );
    });

    it('does not rename non-.tmp files when rotating orphaned batches', async () => {
      fsMocks.readdir.mockResolvedValueOnce(['batch-111.log', 'other.txt', 'batch-222.tmp']);

      await BatchProducer.create(config);

      expect(fsMocks.rename).toHaveBeenCalledTimes(1);
      expect(fsMocks.rename).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-222.tmp'),
        path.join(config.trackPath, 'batch-222.log')
      );
    });

    it('handles readdir failure gracefully when rotating orphaned batches', async () => {
      fsMocks.readdir.mockRejectedValueOnce(new Error('ENOENT'));

      await expect(BatchProducer.create(config)).resolves.toBeDefined();
    });

    it('handles individual rename failure gracefully when rotating orphaned batches', async () => {
      fsMocks.readdir.mockResolvedValueOnce(['batch-111.tmp', 'batch-222.tmp']);
      fsMocks.rename.mockRejectedValueOnce(new Error('rename failed'));

      await expect(BatchProducer.create(config)).resolves.toBeDefined();
      expect(fsMocks.rename).toHaveBeenCalledTimes(2);
    });
  });

  describe('post() + write queue', () => {
    it('serializes each post as JSON + newline and appends to the same .tmp file until rotation', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ a: 1 });
      producer.post({ b: 2 });
      await producer.flush();

      const tmp = path.join(config.trackPath, 'batch-1234567890.tmp');

      expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(1, tmp, `{"a":1}\n`, 'utf8');
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(2, tmp, `{"b":2}\n`, 'utf8');
    });

    it('writes posts in call order', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ order: 1 });
      producer.post({ order: 2 });
      producer.post({ order: 3 });

      await producer.flush();

      expect(fsMocks.appendFile).toHaveBeenCalledTimes(3);

      expect(fsMocks.appendFile.mock.calls[0][1]).toBe(`{"order":1}\n`);
      expect(fsMocks.appendFile.mock.calls[1][1]).toBe(`{"order":2}\n`);
      expect(fsMocks.appendFile.mock.calls[2][1]).toBe(`{"order":3}\n`);
    });

    it('drops an item it cannot serialize and keeps writing the ones after it', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ context: { id: 1n } });
      producer.post({ good: true });
      await producer.flush();

      expect(fsMocks.appendFile).toHaveBeenCalledTimes(1);
      expect(fsMocks.appendFile.mock.calls[0][1]).toBe(`{"good":true}\n`);
    });

    it('swallows appendFile errors and keeps queue processing subsequent posts', async () => {
      fsMocks.appendFile.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(undefined);

      const producer = await BatchProducer.create(config);

      producer.post({ bad: true });
      producer.post({ good: true });

      await expect(producer.flush()).resolves.not.toThrow();
      expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('writePendingSync()', () => {
    it('writes what is posted but not written yet before returning, and the queue does not write it again', async () => {
      const producer = await BatchProducer.create(config);
      producer.post({ a: 1 });
      producer.post({ b: 2 });

      producer.writePendingSync();

      const tmp = path.join(config.trackPath, 'batch-1234567890.tmp');
      expect(appendFileSync.mock.calls).toEqual([
        [tmp, `{"a":1}\n`, 'utf8'],
        [tmp, `{"b":2}\n`, 'utf8'],
      ]);
      await producer.flush();
      expect(fsMocks.appendFile).not.toHaveBeenCalled();
    });

    it('still writes an item the queue has taken up but not appended yet, and the queue then skips it', async () => {
      const producer = await BatchProducer.create(config);
      let finishDirectoryCheck!: () => void;
      fsMocks.access.mockImplementationOnce(() => new Promise<void>((resolve) => (finishDirectoryCheck = resolve)));
      producer.post({ checking: true });
      await vi.waitFor(() => expect(fsMocks.access).toHaveBeenCalled());

      // The queue is waiting on the directory check: the item is not on disk, and an exit now
      // would lose it unless the synchronous write takes it.
      producer.writePendingSync();

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      expect(appendFileSync.mock.calls[0][1]).toBe(`{"checking":true}\n`);
      finishDirectoryCheck();
      await producer.flush();
      expect(fsMocks.appendFile).not.toHaveBeenCalled();
    });

    it('writes to a new batch while an append is in flight, which then rotates the batch it was writing', async () => {
      const producer = await BatchProducer.create(config);
      const { dateNow } = await import('@flashcatcloud/browser-core');
      vi.mocked(dateNow).mockReturnValueOnce(1000).mockReturnValueOnce(2000);
      let finishAppend!: () => void;
      fsMocks.appendFile.mockImplementationOnce(() => new Promise<void>((resolve) => (finishAppend = resolve)));
      producer.post({ large: 'x'.repeat(100) });
      await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1));
      producer.post({ fatal: true });

      // A large event is appended in chunks: a line written to the same file between two of them
      // would corrupt both, so the exit flush starts a new batch instead.
      producer.writePendingSync();

      expect(appendFileSync).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-2000.tmp'),
        `{"fatal":true}\n`,
        'utf8'
      );
      expect(renameSync).not.toHaveBeenCalled();
      finishAppend();
      await producer.flush();
      // The append rotated its own batch once done; the flush rotated the current one.
      const renamed = fsMocks.rename.mock.calls.map(([from]) => path.basename(String(from)));
      expect(renamed).toEqual(['batch-1000.tmp', 'batch-2000.tmp']);
    });

    it('keeps the batch the exit flush started when an earlier rotation completes after it', async () => {
      const producer = await BatchProducer.create(makeConfig({ batchSize: 20 }));
      const { dateNow } = await import('@flashcatcloud/browser-core');
      vi.mocked(dateNow).mockReturnValueOnce(1000).mockReturnValueOnce(2000);
      producer.post({ a: 'x'.repeat(10) });
      await producer.flush();
      vi.mocked(dateNow).mockReturnValueOnce(3000);
      producer.post({ b: 'y'.repeat(10) });
      await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(2));
      let finishRename!: () => void;
      fsMocks.rename.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRename = resolve)));
      // The next event does not fit: the queue starts rotating batch 3000…
      producer.post({ c: 'z'.repeat(10) });
      await vi.waitFor(() => expect(fsMocks.rename).toHaveBeenCalledTimes(2));
      // …and an exit flush rotates it itself and writes into the next batch meanwhile.
      producer.writePendingSync();
      expect(appendFileSync).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-3000.tmp'),
        `{"c":"zzzzzzzzzz"}\n`,
        'utf8'
      );

      finishRename();
      await producer.flush();

      // That batch stayed the current one, so the flush rotated it rather than forgetting it.
      expect(fsMocks.rename).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-3000.tmp'),
        path.join(config.trackPath, 'batch-3000.log')
      );
    });

    it('leaves a write the queue already started to complete on its own', async () => {
      const producer = await BatchProducer.create(config);
      let finishWrite!: () => void;
      fsMocks.appendFile.mockImplementationOnce(() => new Promise<void>((resolve) => (finishWrite = resolve)));
      producer.post({ started: true });
      await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1));
      producer.post({ pending: true });

      producer.writePendingSync();

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      expect(appendFileSync.mock.calls[0][1]).toBe(`{"pending":true}\n`);
      finishWrite();
      await producer.flush();
      expect(fsMocks.appendFile).toHaveBeenCalledTimes(1);
    });

    it('rotates in place when the batch size is exceeded, never onto the name of an earlier batch', async () => {
      const producer = await BatchProducer.create(makeConfig({ batchSize: 20 }));
      producer.post({ a: 'x'.repeat(10) });
      producer.post({ b: 'y'.repeat(10) });
      producer.post({ c: 'z'.repeat(10) });

      producer.writePendingSync();

      // Three batches within the same millisecond: each named after a later one than the last.
      expect(renameSync.mock.calls).toEqual([
        [path.join(config.trackPath, 'batch-1234567890.tmp'), path.join(config.trackPath, 'batch-1234567890.log')],
        [path.join(config.trackPath, 'batch-1234567891.tmp'), path.join(config.trackPath, 'batch-1234567891.log')],
      ]);
      expect(appendFileSync.mock.calls.map(([file]) => file)).toEqual([
        path.join(config.trackPath, 'batch-1234567890.tmp'),
        path.join(config.trackPath, 'batch-1234567891.tmp'),
        path.join(config.trackPath, 'batch-1234567892.tmp'),
      ]);
    });

    it('never rotates onto a .log that exists, as one left by an earlier launch may share the name', async () => {
      const producer = await BatchProducer.create(makeConfig({ batchSize: 20 }));
      producer.post({ a: 'x'.repeat(10) });
      producer.post({ b: 'y'.repeat(10) });
      existsSync.mockImplementation((candidate: string) => String(candidate).endsWith('batch-1234567890.log'));

      producer.writePendingSync();

      expect(renameSync).toHaveBeenCalledWith(
        path.join(config.trackPath, 'batch-1234567890.tmp'),
        path.join(config.trackPath, 'batch-1234567890-1.log')
      );
    });

    it('drops a write that fails, like the queue does', async () => {
      const producer = await BatchProducer.create(config);
      appendFileSync.mockImplementationOnce(() => {
        throw new Error('EACCES');
      });
      producer.post({ a: 1 });
      producer.post({ b: 2 });

      expect(() => producer.writePendingSync()).not.toThrow();

      expect(appendFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('rotation behavior', () => {
    it('flush() renames current batch from .tmp to .log', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ event: 'test' });
      await producer.flush();

      const tmp = path.join(config.trackPath, 'batch-1234567890.tmp');
      const log = path.join(config.trackPath, 'batch-1234567890.log');

      expect(fsMocks.rename).toHaveBeenCalledWith(tmp, log);
    });

    it('flush() does nothing if no data was ever written', async () => {
      const producer = await BatchProducer.create(config);

      await producer.flush();

      expect(fsMocks.appendFile).not.toHaveBeenCalled();
      expect(fsMocks.rename).not.toHaveBeenCalled();
    });

    it('rotates due to size limit BEFORE appending when current batch already has data', async () => {
      const small = makeConfig({ batchSize: 20 });

      const producer = await BatchProducer.create(small);

      const { dateNow } = await import('@flashcatcloud/browser-core');
      vi.mocked(dateNow)
        .mockReturnValueOnce(111) // first tmp
        .mockReturnValueOnce(222); // second tmp after rotation

      producer.post({ x: '123' });
      producer.post({ x: '123' });
      await producer.flush();

      const tmp1 = path.join(small.trackPath, 'batch-111.tmp');
      const log1 = path.join(small.trackPath, 'batch-111.log');
      const tmp2 = path.join(small.trackPath, 'batch-222.tmp');
      const log2 = path.join(small.trackPath, 'batch-222.log');

      expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(1, tmp1, `{"x":"123"}\n`, 'utf8');
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(2, tmp2, `{"x":"123"}\n`, 'utf8');

      expect(fsMocks.rename).toHaveBeenCalledWith(tmp1, log1);
      expect(fsMocks.rename).toHaveBeenCalledWith(tmp2, log2);
    });

    it('swallows rename/access errors during rotation and still resets state (new batch file is created after)', async () => {
      const { dateNow } = await import('@flashcatcloud/browser-core');
      vi.mocked(dateNow).mockReturnValueOnce(1000).mockReturnValueOnce(2000);

      fsMocks.rename.mockRejectedValueOnce(new Error('rename failed'));

      const producer = await BatchProducer.create(config);

      producer.post({ first: true });
      await producer.flush();

      producer.post({ second: true });
      await producer.flush();

      const tmp1 = path.join(config.trackPath, 'batch-1000.tmp');
      const tmp2 = path.join(config.trackPath, 'batch-2000.tmp');

      const appendedFiles = fsMocks.appendFile.mock.calls.map((c) => String(c[0]));
      expect(appendedFiles).toContain(tmp1);
      expect(appendedFiles).toContain(tmp2);
    });
  });

  describe('directory handling', () => {
    it('calls mkdir recursively when directory is missing during a write', async () => {
      // create() consumes one ensureTrackDirectory call and we want the failure to happen during writeData().
      // So we make create succeed and then fail for the subsequent access.
      fsMocks.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ENOENT'));

      const producer = await BatchProducer.create(config);

      producer.post({ event: 'test' });
      await producer.flush();

      expect(fsMocks.mkdir).toHaveBeenCalledWith(config.trackPath, { recursive: true });
    });

    it('does not mkdir when access succeeds during a write', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ event: 'test' });
      await producer.flush();

      expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });
  });
});
