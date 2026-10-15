import { mockFs } from '../mocks.specUtil';

vi.mock('./display', () => ({
  displayError: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateFile } from './StateFile';

vi.mock('node:fs/promises');
const { writeFileSync, renameSync, unlinkSync, readdirSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => [] as string[]),
}));
vi.mock('node:fs', () => ({ writeFileSync, renameSync, unlinkSync, readdirSync }));
const mfs = mockFs();

const FILE_PATH = '/mock/user/data/_dd_state';

describe('StateFile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mfs.writeFile.mockResolvedValue(undefined);
    mfs.unlink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
    readdirSync.mockReturnValue([]);
  });

  it('writes to a file of its own and renames it into place, asynchronously and synchronously alike', async () => {
    const file = new StateFile(FILE_PATH, 'state');

    await file.write(() => 'async');
    file.writeSync('sync');

    expect(mfs.writeFile).toHaveBeenCalledWith(expect.stringContaining(`${FILE_PATH}.`), 'async', 'utf-8');
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining(`${FILE_PATH}.`), 'sync', 'utf-8');
    expect(renameSync).toHaveBeenCalledTimes(2);
    expect(renameSync.mock.calls.every(([, to]) => to === FILE_PATH)).toBe(true);
  });

  it('never lets a write issued earlier replace a newer synchronous snapshot', async () => {
    const file = new StateFile(FILE_PATH, 'state');
    let finishWrite!: () => void;
    mfs.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => (finishWrite = resolve)));
    const stale = file.write(() => 'old');
    await vi.advanceTimersByTimeAsync(0);

    // The process may be about to exit: the newer state lands first.
    file.writeSync('new');
    finishWrite();
    await stale;

    const committed = renameSync.mock.calls.map(([from]) => String(from));
    expect(committed).toHaveLength(1);
    expect(writeFileSync).toHaveBeenCalledWith(committed[0], 'new', 'utf-8');
    // The stale temp file is not left behind.
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining(`${FILE_PATH}.`));
  });

  it('never lets a delete requested earlier remove a newer synchronous snapshot', async () => {
    const file = new StateFile(FILE_PATH, 'state');
    let finishWrite!: () => void;
    mfs.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => (finishWrite = resolve)));
    const earlier = file.write(() => 'old');
    const deleted = file.delete();
    await vi.advanceTimersByTimeAsync(0);

    file.writeSync('new');
    finishWrite();
    await earlier;
    await deleted;

    expect(unlinkSync).not.toHaveBeenCalledWith(FILE_PATH);
    expect(renameSync).toHaveBeenCalledTimes(1);
  });

  it('deletes synchronously, and a write issued earlier does not bring the file back', async () => {
    const file = new StateFile(FILE_PATH, 'state');
    let finishWrite!: () => void;
    mfs.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => (finishWrite = resolve)));
    const stale = file.write(() => 'old');
    await vi.advanceTimersByTimeAsync(0);

    file.deleteSync();
    finishWrite();
    await stale;

    expect(unlinkSync).toHaveBeenCalledWith(FILE_PATH);
    expect(renameSync).not.toHaveBeenCalled();
  });

  it('keeps writing after a write that failed', async () => {
    const file = new StateFile(FILE_PATH, 'state');
    mfs.writeFile.mockRejectedValueOnce(new Error('EACCES'));

    await file.write(() => 'first');
    await file.write(() => 'second');

    expect(renameSync).toHaveBeenCalledTimes(1);
  });

  it('sweeps the temp files an earlier launch left next to it', () => {
    readdirSync.mockReturnValue(['_dd_state', '_dd_state.123.4.tmp', '_dd_state.123.5.tmp', 'other.1.1.tmp']);

    new StateFile(FILE_PATH, 'state').sweep();

    expect(unlinkSync.mock.calls.map(([f]) => String(f))).toEqual([
      '/mock/user/data/_dd_state.123.4.tmp',
      '/mock/user/data/_dd_state.123.5.tmp',
    ]);
  });
});
