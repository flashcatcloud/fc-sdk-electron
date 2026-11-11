import { createTestConfiguration, mockFs } from '../../../mocks.specUtil';

let resolveWhenReady: () => void;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/crash/dumps'),
    getName: vi.fn(() => 'TestApp'),
    whenReady: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWhenReady = resolve;
        })
    ),
  },
  crashReporter: {
    start: vi.fn(),
  },
}));

vi.mock('../../../tools/display', () => ({
  displayError: vi.fn(),
  displayInfo: vi.fn(),
}));

vi.mock('../../telemetry', () => ({
  addError: vi.fn(),
  monitor: vi.fn((fn: () => unknown) => fn),
  setTimeout: vi.fn(),
}));

vi.mock('../../../wasm', () => ({
  processMinidump: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crashReporter } from 'electron';
import { type TimeStamp } from '@flashcatcloud/browser-core';
import { CrashCollection } from './CrashCollection';
import { ViewContext, type MainView } from '../view';
import { EventManager, EventKind, EventFormat, type RawRumEvent, type ServerRumEvent } from '../../../event';
import { processMinidump } from '../../../wasm';
import type { CrashReport } from '../../../wasm';
import type { RawRumError, RawRumView } from '../rawRumData.types';
import { displayError } from '../../../tools/display';
import { addError } from '../../telemetry';
import { SessionManager, type SessionRecord, TrackingType } from '../../session';
import { UserContext, USER_HISTORY_FILE_NAME, type User } from '../../UserContext';
import { Assembly, createFormatHooks, registerCommonContext } from '../../../assembly';
import type { RumEvent } from '../rumEvent.types';

vi.mock('node:fs/promises');
const mfs = mockFs();

function createMinidumpResult(overrides?: Partial<CrashReport>): CrashReport {
  return {
    status: 'OK',
    crash_info: { type: 'SIGSEGV', address: '0x0', crashing_thread: 0 },
    system_info: { os: 'mac', cpu: 'amd64', cpu_info: '' },
    crashing_thread: {
      thread_index: 0,
      frame_count: 1,
      frames: [
        { module: '/usr/lib/app', function: 'main', instruction: '0x1000', module_offset: '0x100', trust: 'context' },
      ],
    },
    thread_count: 1,
    threads: [
      {
        thread_index: 0,
        frame_count: 1,
        frames: [
          { module: '/usr/lib/app', function: 'main', instruction: '0x1000', module_offset: '0x100', trust: 'context' },
        ],
      },
    ],
    module_count: 1,
    modules: [
      {
        base_address: '0x1000',
        size: 4096,
        code_file: '/usr/lib/libSystem.B.dylib',
        code_identifier: null,
        debug_file: null,
        debug_identifier: 'AABB',
        version: null,
      },
    ],
    ...overrides,
  };
}

function mockDmpFile(name = 'crash.dmp', birthtimeMs = 0) {
  mfs.readdir.mockResolvedValue([{ name, isFile: () => true, isDirectory: () => false }]);
  mfs.stat.mockResolvedValue({ birthtimeMs });
  mfs.readFile.mockResolvedValue(new Uint8Array([1]));
  mfs.unlink.mockResolvedValue(undefined);
}

/** A session that is always collected, and a main-process view that always exists. */
const TRACKED_SESSION_MANAGER = {
  findSession: () => ({ id: 'session-id', trackingType: TrackingType.TRACKED, sampleRate: 0 }),
  getSession: () => ({
    id: 'session-id',
    trackingType: TrackingType.TRACKED,
    sampleRate: 0,
    status: 'active' as const,
  }),
  drawSession: vi.fn(),
  setSessionHasError: vi.fn(),
};

function startCollection(
  eventManager: EventManager,
  sessionManager: Pick<
    SessionManager,
    'findSession' | 'drawSession' | 'getSession' | 'setSessionHasError'
  > = TRACKED_SESSION_MANAGER
) {
  return CrashCollection.start(
    eventManager,
    sessionManager,
    () => ({ id: 'main-view-id', startTime: 0 as TimeStamp }),
    () => Promise.resolve()
  );
}

async function startAndFlush(
  eventManager: EventManager,
  sessionManager?: Pick<SessionManager, 'findSession' | 'drawSession' | 'getSession' | 'setSessionHasError'>
) {
  startCollection(eventManager, sessionManager);
  resolveWhenReady();
  await vi.advanceTimersToNextTimerAsync();
}

describe('CrashCollection', () => {
  let eventManager: EventManager;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    eventManager = new EventManager();
    rawRumEvents = [];

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });

    mfs.readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  it('starts the native crash reporter', () => {
    startCollection(eventManager);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(crashReporter.start).toHaveBeenCalledWith({ uploadToServer: false, ignoreSystemCrashHandler: true });
  });

  it('does nothing when no crash dumps exist', async () => {
    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(0);
  });

  it('does nothing when crash dumps directory does not exist', async () => {
    mfs.readdir.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(0);
  });

  it('processes a .dmp file and emits a crash error event', async () => {
    const crashTime = 1000 as TimeStamp;
    mockDmpFile('crash.dmp', crashTime);
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
    const event = rawRumEvents[0];
    expect(event.startTime).toBe(crashTime);

    const data = event.data as RawRumError;
    expect(data.date).toBe(crashTime);
    expect(data.type).toBe('error');
    expect(data.error.is_crash).toBe(true);
    expect(data.error.category).toBe('Exception');
    expect(data.error.handling).toBe('unhandled');
    expect(data.error.source).toBe('source');
    expect(data.error.type).toBe('SIGSEGV');
    expect(data.error.message).toBe('Application crashed');
  });

  /**
   * Guard, not an observation. `fs.Stats` timestamps carry sub-millisecond precision, so the raw
   * value is a float; the intake decodes `date` into an int64 and Go drops the whole event on a
   * fractional number — silently, because the `202` is sent before decoding. That kept every
   * native crash out of Error Tracking up to v0.1.0. Asserting the field merely *has* a value
   * would not have caught it, and would not catch it coming back.
   */
  it('emits a whole-millisecond date, since fs timestamps are fractional', async () => {
    const birthtimeMs = 1785900421429.7532;
    mockDmpFile('crash.dmp', birthtimeMs);
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    const event = rawRumEvents[0];
    const data = event.data as RawRumError;
    expect(Number.isInteger(data.date)).toBe(true);
    expect(data.date).toBe(1785900421430);
    expect(Number.isInteger(event.startTime)).toBe(true);
  });

  it('emits a whole-millisecond date when falling back to mtimeMs', async () => {
    // birthtimeMs is 0 on Linux ext4, and mtimeMs is just as fractional.
    mfs.readdir.mockResolvedValue([{ name: 'crash.dmp', isFile: () => true, isDirectory: () => false }]);
    mfs.stat.mockResolvedValue({ birthtimeMs: 0, mtimeMs: 1785900421429.7532 });
    mfs.readFile.mockResolvedValue(new Uint8Array([1]));
    mfs.unlink.mockResolvedValue(undefined);
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(Number.isInteger(data.date)).toBe(true);
    expect(data.date).toBe(1785900421430);
  });

  it('maps mac os to macos source_type', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({ system_info: { os: 'mac', cpu: 'arm64', cpu_info: '' } })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.source_type).toBe('macos');
  });

  it('maps linux os to linux source_type', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({ system_info: { os: 'linux', cpu: 'amd64', cpu_info: '' } })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.source_type).toBe('linux');
  });

  it('maps windows os to windows source_type', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({ system_info: { os: 'windows', cpu: 'amd64', cpu_info: '' } })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.source_type).toBe('windows');
  });

  it('passes through unknown os value and reports a telemetry error', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({ system_info: { os: 'solaris', cpu: 'sparc', cpu_info: '' } })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.source_type).toBe('solaris' as RawRumError['error']['source_type']);
    expect(vi.mocked(addError)).toHaveBeenCalledWith(expect.any(Error));
  });

  it('formats thread stack with addresses and decimal offset', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 2,
            frames: [
              {
                module: '/path/to/app',
                function: 'crashFunc',
                instruction: '0x1010',
                module_offset: '0x10',
                trust: 'context',
              },
              { module: '/path/to/app', function: 'main', instruction: '0x1020', module_offset: '0x20', trust: 'cfi' },
            ],
          },
        ],
        modules: [
          {
            base_address: '0x1000',
            size: 4096,
            code_file: '/path/to/app',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.stack).toBe(
      '0  app 0x0000000000001010 0x0000000000001000 + 16\n' + '0  app 0x0000000000001020 0x0000000000001000 + 32'
    );
  });

  it('uses error.stack from crashed thread', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        crash_info: { type: 'SIGSEGV', address: '0x0', crashing_thread: 1 },
        threads: [
          {
            thread_index: 0,
            frame_count: 1,
            frames: [
              { module: '/path/to/lib', function: 'wait', instruction: '0x2000', module_offset: '0x100', trust: 'cfi' },
            ],
          },
          {
            thread_index: 1,
            frame_count: 1,
            frames: [
              {
                module: '/path/to/app',
                function: 'crash',
                instruction: '0x1000',
                module_offset: '0x50',
                trust: 'context',
              },
            ],
          },
        ],
        modules: [
          {
            base_address: '0x1000',
            size: 100,
            code_file: '/path/to/app',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
          {
            base_address: '0x2000',
            size: 100,
            code_file: '/path/to/lib',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'BB',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.stack).toBe('1  app 0x0000000000001000 0x0000000000001000 + 80');
  });

  it('includes threads with crashed flag', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        crash_info: { type: 'SIGSEGV', address: '0x0', crashing_thread: 0 },
        threads: [
          {
            thread_index: 0,
            frame_count: 1,
            frames: [
              { module: '/path/to/app', function: 'crash', instruction: '0x1', module_offset: '0x1', trust: 'context' },
            ],
          },
          {
            thread_index: 1,
            frame_count: 1,
            frames: [
              { module: '/path/to/lib', function: 'wait', instruction: '0x2', module_offset: '0x2', trust: 'cfi' },
            ],
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.threads).toHaveLength(2);
    expect(data.error.threads![0].crashed).toBe(true);
    expect(data.error.threads![0].name).toBe('Thread 0');
    expect(data.error.threads![1].crashed).toBe(false);
    expect(data.error.threads![1].name).toBe('Thread 1');
  });

  it('formats binary images with 64-bit addresses and arch', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        system_info: { os: 'mac', cpu: 'arm64', cpu_info: '' },
        modules: [
          {
            base_address: '0x7fff5fc01000',
            size: 4096,
            code_file: '/usr/lib/libSystem.B.dylib',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.binary_images).toHaveLength(1);
    const image = data.error.binary_images![0];
    expect(image.load_address).toBe('0x00007fff5fc01000');
    expect(image.max_address).toBe('0x00007fff5fc02000');
    expect(image.arch).toBe('arm64');
    expect(image.name).toBe('libSystem.B.dylib');
    expect(image.is_system).toBe(true);
  });

  it('classifies binary images with is_system', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        modules: [
          {
            base_address: '0x1000',
            size: 100,
            code_file: '/usr/lib/libSystem.B.dylib',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
          {
            base_address: '0x2000',
            size: 200,
            code_file: '/Applications/MyApp.app/Contents/MacOS/MyApp',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'BB',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.binary_images).toHaveLength(2);
    expect(data.error.binary_images![0].is_system).toBe(true);
    expect(data.error.binary_images![0].name).toBe('libSystem.B.dylib');
    expect(data.error.binary_images![1].is_system).toBe(false);
    expect(data.error.binary_images![1].name).toBe('MyApp');
  });

  it('deletes processed .dmp file', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    expect(mfs.unlink).toHaveBeenCalledWith('/mock/crash/dumps/crash.dmp');
  });

  it('emits an event without exception details when the report has no crash_info', async () => {
    mockDmpFile();
    const report = createMinidumpResult();
    delete report.crash_info;
    delete report.crashing_thread;
    vi.mocked(processMinidump).mockResolvedValue(report);

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.message).toBe('Application crashed');
    expect(data.error.is_crash).toBe(true);
    expect(data.error.type).toBeUndefined();
    expect(data.error.meta).toEqual({ code_type: 'amd64', process: 'TestApp' });
    // No thread can be flagged as crashed, so no stack is promoted to error.stack,
    // but every thread stack and binary image is still reported.
    expect(data.error.stack).toBeUndefined();
    expect(data.error.threads).toHaveLength(1);
    expect(data.error.threads![0].crashed).toBe(false);
    expect(data.error.threads![0].stack).toContain('app');
    expect(data.error.binary_images).toHaveLength(1);
    expect(displayError).not.toHaveBeenCalled();
  });

  it('deletes the .dmp file when processing fails', async () => {
    mockDmpFile('bad.dmp');
    vi.mocked(processMinidump).mockRejectedValue(new Error('invalid minidump'));

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(0);
    expect(mfs.unlink).toHaveBeenCalledWith('/mock/crash/dumps/bad.dmp');
    expect(displayError).toHaveBeenCalledWith(
      'Failed to process crash dump:',
      '/mock/crash/dumps/bad.dmp',
      expect.any(Error)
    );
  });

  it('reports an error but keeps going when a .dmp file cannot be deleted', async () => {
    mockDmpFile();
    mfs.unlink.mockRejectedValue(new Error('EPERM'));
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
    expect(displayError).toHaveBeenCalledWith(
      'Failed to delete crash dump:',
      '/mock/crash/dumps/crash.dmp',
      expect.any(Error)
    );
    expect(vi.mocked(addError)).toHaveBeenCalledWith(expect.any(Error));
  });

  it('skips non-.dmp files', async () => {
    mfs.readdir.mockResolvedValue([
      { name: 'crash.dmp', isFile: () => true, isDirectory: () => false },
      { name: 'notes.txt', isFile: () => true, isDirectory: () => false },
    ]);
    mfs.stat.mockResolvedValue({ birthtimeMs: 0 });
    mfs.readFile.mockResolvedValue(new Uint8Array([1]));
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());
    mfs.unlink.mockResolvedValue(undefined);

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
  });

  it('continues processing remaining files when one fails', async () => {
    mfs.readdir.mockResolvedValue([
      { name: 'bad.dmp', isFile: () => true, isDirectory: () => false },
      { name: 'good.dmp', isFile: () => true, isDirectory: () => false },
    ]);
    mfs.stat.mockResolvedValue({ birthtimeMs: 0 });
    mfs.readFile.mockRejectedValueOnce(new Error('read error')).mockResolvedValueOnce(new Uint8Array([1]));
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());
    mfs.unlink.mockResolvedValue(undefined);

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
    expect(displayError).toHaveBeenCalledWith(
      'Failed to process crash dump:',
      '/mock/crash/dumps/bad.dmp',
      expect.any(Error)
    );
    expect(mfs.unlink).toHaveBeenCalledWith('/mock/crash/dumps/bad.dmp');
    expect(mfs.unlink).toHaveBeenCalledWith('/mock/crash/dumps/good.dmp');
  });

  it('uses ??? for unknown module names', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 1,
            frames: [
              { module: '', function: 'unknown', instruction: '0x1000', module_offset: '0x100', trust: 'context' },
            ],
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.threads![0].stack).toContain('???');
  });

  it('includes meta with process info', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.meta).toEqual({
      code_type: 'amd64',
      process: 'TestApp',
      exception_type: 'SIGSEGV',
      exception_codes: '0x0000000000000000',
    });
  });

  /**
   * The processor reports the faulting address and it used to be dropped here. It is often the
   * only usable lead: a minidump written without a real exception record names its type
   * `unknown 0x00000000 / 0x00000000` while still recording where the process faulted.
   */
  it('reports the faulting address as a 64-bit exception code', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        crash_info: { type: 'EXC_BAD_ACCESS / KERN_INVALID_ADDRESS', address: '0x7fff6f41333a', crashing_thread: 0 },
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.meta!.exception_codes).toBe('0x00007fff6f41333a');
  });

  it('builds the fingerprint from the first non-system frame of the crashed thread', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 2,
            frames: [
              {
                module: '/usr/lib/libSystem.B.dylib',
                function: 'start',
                instruction: '0x1',
                module_offset: '0x50',
                trust: 'context',
              },
              {
                module: '/Applications/MyApp.app/Contents/MacOS/MyApp',
                function: 'crash',
                instruction: '0x2',
                module_offset: '0x0012ab3c',
                trust: 'cfi',
              },
            ],
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.fingerprint).toBe('SIGSEGV|MyApp|0x12ab3c');
  });

  it('skips frames without a module when picking the fingerprint frame', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 2,
            frames: [
              { module: '', function: 'unknown', instruction: '0x1', module_offset: '0x10', trust: 'context' },
              {
                module: '/Applications/MyApp.app/Contents/MacOS/MyApp',
                function: 'crash',
                instruction: '0x2',
                module_offset: '0x20',
                trust: 'cfi',
              },
            ],
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.fingerprint).toBe('SIGSEGV|MyApp|0x20');
  });

  it('falls back to the first frame when every frame of the crashed thread is a system module', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 2,
            frames: [
              {
                module: '/usr/lib/libA.dylib',
                function: 'crash',
                instruction: '0x1',
                module_offset: '0x30',
                trust: 'context',
              },
              {
                module: '/System/Library/Frameworks/CoreFoundation',
                function: 'run',
                instruction: '0x2',
                module_offset: '0x40',
                trust: 'cfi',
              },
            ],
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.fingerprint).toBe('SIGSEGV|libA.dylib|0x30');
  });

  it('emits no fingerprint when crash_info is missing', async () => {
    mockDmpFile();
    const report = createMinidumpResult();
    delete report.crash_info;
    delete report.crashing_thread;
    vi.mocked(processMinidump).mockResolvedValue(report);

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error).not.toHaveProperty('fingerprint');
  });

  it('emits no fingerprint when the crashing thread is not identified', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({ crash_info: { type: 'SIGSEGV', address: '0x0', crashing_thread: null } })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error).not.toHaveProperty('fingerprint');
  });

  it('emits no fingerprint when the crashed thread has no frames', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [{ thread_index: 0, frame_count: 0, frames: [] }],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error).not.toHaveProperty('fingerprint');
  });

  it('normalizes offset spellings so equivalent offsets produce the same fingerprint', async () => {
    mfs.readdir.mockResolvedValue([
      { name: 'a.dmp', isFile: () => true, isDirectory: () => false },
      { name: 'b.dmp', isFile: () => true, isDirectory: () => false },
    ]);
    mfs.stat.mockResolvedValue({ birthtimeMs: 0 });
    mfs.readFile.mockResolvedValue(new Uint8Array([1]));
    mfs.unlink.mockResolvedValue(undefined);
    const reportWithOffset = (moduleOffset: string) =>
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 1,
            frames: [
              {
                module: '/Applications/MyApp.app/Contents/MacOS/MyApp',
                function: 'crash',
                instruction: '0x1',
                module_offset: moduleOffset,
                trust: 'context',
              },
            ],
          },
        ],
      });
    vi.mocked(processMinidump)
      .mockResolvedValueOnce(reportWithOffset('0x0012AB3C'))
      .mockResolvedValueOnce(reportWithOffset('0x12ab3c'));

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(2);
    const first = rawRumEvents[0].data as RawRumError;
    const second = rawRumEvents[1].data as RawRumError;
    expect(first.error.fingerprint).toBe('SIGSEGV|MyApp|0x12ab3c');
    expect(second.error.fingerprint).toBe(first.error.fingerprint);
  });

  describe('a crash of a session kept by sessionOnError', () => {
    const VIEW_START = 400 as TimeStamp;
    const CRASH_TIME = 1000 as TimeStamp;
    let calls: string[];

    const WITHHELD: SessionRecord = { id: 'withheld', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0 };
    const NEXT_SESSION: SessionRecord = { id: 'next', trackingType: TrackingType.TRACKED, sampleRate: 100 };

    /** `session` is the one the crash happened in; `current` the one in force now. */
    function sessionManagerFor(session: SessionRecord | undefined, current: SessionRecord = NEXT_SESSION) {
      return {
        findSession: () => session,
        drawSession: vi.fn(),
        getSession: () => ({ ...current, status: 'active' as const }),
        setSessionHasError: vi.fn(() => calls.push('setSessionHasError')),
      };
    }

    async function processCrash(
      sessionManager: Pick<SessionManager, 'findSession' | 'drawSession' | 'getSession' | 'setSessionHasError'>,
      findView: () => MainView | undefined = () => ({ id: 'crashed-view', startTime: VIEW_START }),
      writtenToDisk: () => Promise<void> = () => Promise.resolve()
    ) {
      mockDmpFile('crash.dmp', CRASH_TIME);
      vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());
      eventManager.registerHandler<RawRumEvent>({
        canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW,
        handle: (event) => calls.push(event.data.type),
      });
      CrashCollection.start(eventManager, sessionManager, findView, writtenToDisk);
      resolveWhenReady();
      await vi.advanceTimersToNextTimerAsync();
    }

    beforeEach(() => {
      calls = [];
    });

    it('releases a session that is over and had not reported an error, and rebuilds its view ahead of the crash', async () => {
      const sessionManager = sessionManagerFor(WITHHELD);

      await processCrash(sessionManager);

      // Nothing of a session that is over is held, so the mark comes first: it is what lets the
      // view and the crash pass assembly.
      expect(sessionManager.setSessionHasError).toHaveBeenCalledWith('withheld', CRASH_TIME);
      expect(calls).toEqual(['setSessionHasError', 'view', 'error']);
      expect(rawRumEvents[0]).toMatchObject({
        startTime: VIEW_START,
        data: {
          type: 'view',
          date: VIEW_START,
          view: { id: 'crashed-view', is_active: false, error: { count: 1 }, time_spent: 600_000_000 },
          _dd: { document_version: 1 },
        },
      });
      expect((rawRumEvents[1].data as RawRumError).error.is_crash).toBe(true);
    });

    it('still releases the session and reports the crash, under a view of its own, when its view is gone from the history', async () => {
      const sessionManager = sessionManagerFor(WITHHELD);

      await processCrash(sessionManager, () => undefined);

      expect(sessionManager.setSessionHasError).toHaveBeenCalledWith('withheld', CRASH_TIME);
      expect(calls).toEqual(['setSessionHasError', 'error']);
      const crash = rawRumEvents[0].data as RawRumError;
      expect(crash.error.is_crash).toBe(true);
      expect(typeof crash.view?.id).toBe('string');
    });

    it('keeps the dump until its report is written to disk, and deletes it then', async () => {
      let written!: () => void;
      const writtenToDisk = () => new Promise<void>((resolve) => (written = resolve));
      mfs.unlink.mockResolvedValue(undefined);
      const processing = processCrash(sessionManagerFor(WITHHELD), undefined, writtenToDisk);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toContain('error');
      expect(mfs.unlink).not.toHaveBeenCalled();

      written();
      await processing;
      expect(mfs.unlink).toHaveBeenCalledWith('/mock/crash/dumps/crash.dmp');
    });

    it('keeps the dump when its report could not be written, to report it on the next launch', async () => {
      mfs.unlink.mockResolvedValue(undefined);

      await processCrash(sessionManagerFor(WITHHELD), undefined, () => Promise.reject(new Error('ENOSPC')));

      expect(calls).toContain('error');
      expect(mfs.unlink).not.toHaveBeenCalled();
    });

    it('leaves the mark to the release when the crashed session was resumed and is the current one', async () => {
      const sessionManager = sessionManagerFor(WITHHELD, WITHHELD);

      await processCrash(sessionManager);

      // The rebuilt view and the crash join what this launch holds, and the mark lands when that
      // is released — a mark now would say the view had reached the batch before it had.
      expect(sessionManager.setSessionHasError).not.toHaveBeenCalled();
      expect(calls).toEqual(['view', 'error']);
    });

    it.each([
      ['a drawn session', { id: 'drawn', trackingType: TrackingType.TRACKED, sampleRate: 0 }],
      [
        'a session already released',
        { id: 'released', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0, hasError: true },
      ],
      ['a session the draw did not keep', { id: 'not-kept', trackingType: TrackingType.NOT_TRACKED, sampleRate: 0 }],
    ])('reports the crash alone for %s', async (_, session) => {
      const sessionManager = sessionManagerFor(session);

      await processCrash(sessionManager);

      expect(sessionManager.setSessionHasError).not.toHaveBeenCalled();
      expect(sessionManager.drawSession).not.toHaveBeenCalled();
      expect(calls).toEqual(['error']);
      expect(rawRumEvents[0].session).toBeUndefined();
    });
  });

  describe('a crash after the session of its launch had ended', () => {
    const CRASH_TIME = 1000 as TimeStamp;
    const CURRENT: SessionRecord = { id: 'current', trackingType: TrackingType.TRACKED, sampleRate: 100 };

    function sessionManagerDrawing(drawn: SessionRecord) {
      return {
        findSession: () => undefined,
        drawSession: vi.fn(() => drawn),
        getSession: () => ({ ...CURRENT, status: 'active' as const }),
        setSessionHasError: vi.fn(),
      };
    }

    async function processCrash(sessionManager: ReturnType<typeof sessionManagerDrawing>) {
      mockDmpFile('crash.dmp', CRASH_TIME);
      vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());
      // A view of the ended session still in the history must not be the crash's.
      CrashCollection.start(
        eventManager,
        sessionManager,
        () => ({ id: 'ended-session-view', startTime: 400 as TimeStamp }),
        () => Promise.resolve()
      );
      resolveWhenReady();
      await vi.advanceTimersToNextTimerAsync();
    }

    it('reports it in a session drawn for it, under a view of its own that starts at the crash', async () => {
      const drawn: SessionRecord = { id: 'drawn', trackingType: TrackingType.TRACKED, sampleRate: 40, rcVersion: 2 };
      const sessionManager = sessionManagerDrawing(drawn);

      await processCrash(sessionManager);

      expect(sessionManager.drawSession).toHaveBeenCalledTimes(1);
      expect(rawRumEvents).toHaveLength(2);
      const [view, crash] = rawRumEvents;
      expect(view).toMatchObject({
        startTime: CRASH_TIME,
        session: drawn,
        data: {
          type: 'view',
          date: CRASH_TIME,
          view: { is_active: false, error: { count: 1 }, time_spent: 0 },
          _dd: { document_version: 1 },
        },
      });
      const viewId = (view.data as RawRumView).view.id;
      expect(viewId).not.toBe('ended-session-view');
      expect(crash).toMatchObject({ startTime: CRASH_TIME, session: drawn });
      expect((crash.data as RawRumError).error.is_crash).toBe(true);
      expect((crash.data as RawRumError).view?.id).toBe(viewId);
      expect(sessionManager.setSessionHasError).not.toHaveBeenCalled();
    });

    it('reports a session drawn for sessionOnError as released, since the crash is its error', async () => {
      const sessionManager = sessionManagerDrawing({
        id: 'drawn',
        trackingType: TrackingType.TRACKED_ON_ERROR,
        sampleRate: 0,
      });

      await processCrash(sessionManager);

      const released = { id: 'drawn', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0, hasError: true };
      expect(rawRumEvents.map((event) => [event.data.type, event.session])).toEqual([
        ['view', released],
        ['error', released],
      ]);
      // The mark is the drawn session's own: there is no history entry or state to write it to.
      expect(sessionManager.setSessionHasError).not.toHaveBeenCalled();
    });

    it('still deletes the dump when the draw did not keep the session', async () => {
      const drawn: SessionRecord = { id: 'drawn', trackingType: TrackingType.NOT_TRACKED, sampleRate: 0 };
      mfs.unlink.mockResolvedValue(undefined);

      await processCrash(sessionManagerDrawing(drawn));

      // Assembly discards both: a session that is not collected reports nothing.
      expect(rawRumEvents.map((event) => event.session)).toEqual([drawn, drawn]);
      expect(mfs.unlink).toHaveBeenCalledWith('/mock/crash/dumps/crash.dmp');
    });
  });

  describe.each(['a crash-only session', 'a historical on-error session'] as const)(
    'assembled user identity for %s',
    (recovery) => {
      const CRASH_TIME = 1000 as TimeStamp;
      const VIEW_START = 400 as TimeStamp;
      const ALICE: User = { id: 'alice', name: 'Alice', email: 'alice@example.com' };
      const BOB: User = { id: 'bob', name: 'Bob', email: 'bob@example.com' };
      const ANONYMOUS_ID = 'device-anonymous-id';
      const historicalSession = recovery === 'a historical on-error session';
      const session: SessionRecord = {
        id: 'crashed-session',
        trackingType: TrackingType.TRACKED_ON_ERROR,
        sampleRate: 0,
      };

      it.each<{
        title: string;
        pastUser: User | undefined;
        currentUser: User | undefined;
        missingHistory?: boolean;
      }>([
        { title: 'Alice to anonymous', pastUser: ALICE, currentUser: undefined },
        { title: 'Alice to Bob', pastUser: ALICE, currentUser: BOB },
        { title: 'anonymous to Bob', pastUser: undefined, currentUser: BOB },
        { title: 'Alice without email to Bob', pastUser: { id: 'alice' }, currentUser: BOB },
        { title: 'missing user history to Bob', pastUser: undefined, currentUser: BOB, missingHistory: true },
      ])('keeps the crash-time identity on both events: $title', async ({ pastUser, currentUser, missingHistory }) => {
        vi.setSystemTime(2000);
        mockDmpFile('crash.dmp', CRASH_TIME);
        vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());
        mfs.readFile.mockImplementation((filePath: string) => {
          if (filePath.endsWith('.dmp')) return Promise.resolve(new Uint8Array([1]));
          if (filePath.endsWith(USER_HISTORY_FILE_NAME)) {
            if (missingHistory) return Promise.reject(new Error('ENOENT'));
            // The user logs in after the old view began. An ended entry models a logout before the crash.
            return Promise.resolve(
              JSON.stringify([{ startTime: 500, endTime: pastUser ? null : 900, value: pastUser ?? ALICE }])
            );
          }
          if (filePath.endsWith('_dd_session_history')) {
            return Promise.resolve(
              JSON.stringify(historicalSession ? [{ startTime: 0, endTime: 1100, value: { ...session } }] : [])
            );
          }
          if (filePath.endsWith('_dd_view_history')) {
            return Promise.resolve(
              JSON.stringify(historicalSession ? [{ startTime: VIEW_START, endTime: 1100, value: 'crashed-view' }] : [])
            );
          }
          return Promise.reject(new Error(`Unexpected file: ${filePath}`));
        });

        const users = await UserContext.init(eventManager);
        if (currentUser) users.set(currentUser);
        const hooks = createFormatHooks();
        registerCommonContext(createTestConfiguration(), hooks, ANONYMOUS_ID, (at) => users.find(at));
        const sessions = await SessionManager.start(eventManager, hooks, () => ({
          sessionSampleRate: 100,
          sessionOnError: false,
        }));
        const views = await ViewContext.init(hooks);
        new Assembly(eventManager, hooks);
        const events: RumEvent[] = [];
        eventManager.registerHandler<ServerRumEvent>({
          canHandle: (event): event is ServerRumEvent => event.kind === EventKind.SERVER,
          handle: (event) => events.push(event.data),
        });
        CrashCollection.start(
          eventManager,
          sessions,
          (at) => views.findView(at),
          () => Promise.resolve()
        );
        resolveWhenReady();
        await vi.advanceTimersToNextTimerAsync();

        expect(events.map((event) => event.type)).toEqual(['view', 'error']);
        for (const event of events) {
          expect(event.usr).toEqual({ ...pastUser, anonymous_id: ANONYMOUS_ID });
        }
        expect(events[0].date).toBe(historicalSession ? VIEW_START : CRASH_TIME);
        expect(events[1].date).toBe(CRASH_TIME);
        expect(events[0].session.id).toBe(events[1].session.id);
        expect(events[0].view.id).toBe(events[1].view.id);
      });
    }
  );
});
