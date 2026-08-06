import { mockFs } from '../mocks.specUtil';
vi.mock('node:fs/promises');
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

import * as display from '../tools/display';
vi.mock('../tools/display', () => ({
  displayError: vi.fn(),
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initAnonymousId, ANONYMOUS_ID_FILE_NAME } from './AnonymousId';

const FILE_PATH = `/mock/user/data/${ANONYMOUS_ID_FILE_NAME}`;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const mfs = mockFs();

/** Backs the mocked fs with an in-memory file, so a second `init()` behaves like a restart. */
function withPersistentDisk(initialContent?: string) {
  let content = initialContent;
  mfs.readFile.mockImplementation(() =>
    content === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(content)
  );
  mfs.writeFile.mockImplementation((_path: string, data: string) => {
    content = data;
    return Promise.resolve();
  });
  return { read: () => content };
}

describe('anonymousId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfs.reset();
  });

  it('should generate an id when none is stored yet', async () => {
    withPersistentDisk();

    const anonymousId = await initAnonymousId();

    expect(anonymousId).toMatch(UUID_PATTERN);
  });

  it('should store the generated id under the user data directory', async () => {
    const disk = withPersistentDisk();

    const anonymousId = await initAnonymousId();

    expect(mfs.writeFile).toHaveBeenCalledWith(FILE_PATH, anonymousId, 'utf-8');
    expect(disk.read()).toBe(anonymousId);
  });

  it('should read the stored id back after a restart', async () => {
    withPersistentDisk();
    const firstRun = await initAnonymousId();
    mfs.writeFile.mockClear();

    const secondRun = await initAnonymousId();

    expect(secondRun).toBe(firstRun);
    // The identifier is device-scoped: a restart must not rewrite it.
    expect(mfs.writeFile).not.toHaveBeenCalled();
  });

  it('should ignore a stored id that is blank', async () => {
    withPersistentDisk('  \n');

    const anonymousId = await initAnonymousId();

    expect(anonymousId).toMatch(UUID_PATTERN);
    expect(mfs.writeFile).toHaveBeenCalledWith(FILE_PATH, anonymousId, 'utf-8');
  });

  it('should stay usable for the run when the id cannot be stored', async () => {
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockRejectedValue(new Error('EACCES'));

    const anonymousId = await initAnonymousId();

    expect(anonymousId).toMatch(UUID_PATTERN);
    expect(display.displayError).toHaveBeenCalled();
  });
});
