import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchSizes, BatchUploadFrequencies } from '../config';
import type { RawEvent, ServerEvent } from '../event';
import { EventKind, EventTrack, EventManager, LifecycleKind } from '../event';
import { createTestConfiguration } from '../mocks.specUtil';
import { type Session, type SessionManager, TrackingType } from '../domain/session';
import { Transport } from './Transport';
import { app } from 'electron';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

const { mockBatchPost, mockBatchWritePendingSync, mockBatchFlush, mockBatchCreate } = vi.hoisted(() => {
  const mockBatchPost = vi.fn();
  const mockBatchWritePendingSync = vi.fn();
  const mockBatchFlush = vi.fn().mockResolvedValue(undefined);
  const mockBatchCreate = vi.fn().mockResolvedValue({
    post: mockBatchPost,
    writePendingSync: mockBatchWritePendingSync,
    flush: mockBatchFlush,
    stop: vi.fn(),
  });

  return { mockBatchPost, mockBatchWritePendingSync, mockBatchFlush, mockBatchCreate };
});

vi.mock('./batch', () => ({
  BatchManager: {
    create: mockBatchCreate,
  },
}));

describe('Transport', () => {
  let eventManager: EventManager;
  let config: ReturnType<typeof createTestConfiguration>;
  let session: Session;
  let sessionManager: SessionManager;

  /** What `Transport` hooks on the process, captured rather than registered: the test process must not accumulate exit listeners. */
  let processListeners: Record<string, () => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    processListeners = {};
    vi.spyOn(process, 'on').mockImplementation(((name: string, listener: () => void) => {
      processListeners[name] = listener;
      return process;
    }) as typeof process.on);
    eventManager = new EventManager();
    config = createTestConfiguration();
    session = { id: 'session-id', status: 'active', trackingType: TrackingType.TRACKED, sampleRate: 100 };
    sessionManager = {
      getSession: () => session,
      setSessionHasError: vi.fn(),
      writePendingSync: vi.fn(),
    } as unknown as SessionManager;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create', () => {
    it('should register event handlers for known tracks', async () => {
      const spy = vi.spyOn(eventManager, 'registerHandler');
      await Transport.create(config, eventManager, sessionManager);

      expect(spy).toHaveBeenCalled();
    });

    it('should setup batch manager for known tracks', async () => {
      await Transport.create(config, eventManager, sessionManager);

      expect(mockBatchCreate).toHaveBeenCalled();
    });
  });

  describe('event handling', () => {
    it('should handle SERVER events matching domain track type', async () => {
      await Transport.create(config, eventManager, sessionManager);

      const data = { type: 'action', session: { id: 'session-id' }, view: { id: 'view-id' } };
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data,
      } as unknown as ServerEvent);

      expect(mockBatchPost).toHaveBeenCalledWith(data);
    });

    it('should hold the RUM events of a session withheld by sessionOnError', async () => {
      session.trackingType = TrackingType.TRACKED_ON_ERROR;
      await Transport.create(config, eventManager, sessionManager);

      const data = { type: 'action', session: { id: 'session-id' }, view: { id: 'view-id' } };
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data,
      } as unknown as ServerEvent);

      expect(mockBatchPost).not.toHaveBeenCalled();
    });

    it('should release a withheld session, then write what is pending, when the application may exit', async () => {
      session.trackingType = TrackingType.TRACKED_ON_ERROR;
      await Transport.create(config, eventManager, sessionManager);
      const view = { type: 'view', date: 1, session: { id: 'session-id' }, view: { id: 'view-id', is_active: true } };
      const error = {
        type: 'error',
        error: { source: 'source' },
        session: { id: 'session-id' },
        view: { id: 'view-id' },
      };
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data: view,
      } as unknown as ServerEvent);
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data: error,
      } as unknown as ServerEvent);
      const calls: string[] = [];
      const record = (name: string) => () => calls.push(name);
      mockBatchPost.mockImplementationOnce(record('post:view')).mockImplementationOnce(record('post:error'));
      mockBatchWritePendingSync.mockImplementationOnce(record('batch'));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- a mock's call list, not a method to call
      vi.mocked(sessionManager.writePendingSync).mockImplementationOnce(record('session'));

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.APP_MAY_EXIT });

      // The release first, so that the write takes it along; the session's mark with it.
      expect(calls).toEqual(['post:view', 'post:error', 'batch', 'session']);
    });

    it('should release and write an error reported after before-quit, on will-quit', async () => {
      session.trackingType = TrackingType.TRACKED_ON_ERROR;
      await Transport.create(config, eventManager, sessionManager);
      const listeners: Record<string, () => void> = Object.fromEntries(
        // eslint-disable-next-line @typescript-eslint/unbound-method -- a mock's call list, not a method to call
        vi.mocked(app.on).mock.calls as [string, () => void][]
      );
      const view = { type: 'view', date: 1, session: { id: 'session-id' }, view: { id: 'view-id', is_active: true } };
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data: view,
      } as unknown as ServerEvent);
      listeners['before-quit'].call(undefined);
      expect(mockBatchPost).not.toHaveBeenCalled();

      // A host listener registered after the SDK's reports an error while quitting.
      const error = {
        type: 'error',
        error: { source: 'source' },
        session: { id: 'session-id' },
        view: { id: 'view-id' },
      };
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data: error,
      } as unknown as ServerEvent);
      listeners['will-quit'].call(undefined);

      expect(mockBatchPost.mock.calls.map(([data]) => (data as { type: string }).type)).toEqual(['view', 'error']);
      expect(mockBatchWritePendingSync).toHaveBeenCalled();
    });

    it('should release and write an error reported right before the process exits', async () => {
      session.trackingType = TrackingType.TRACKED_ON_ERROR;
      await Transport.create(config, eventManager, sessionManager);
      const view = { type: 'view', date: 1, session: { id: 'session-id' }, view: { id: 'view-id', is_active: true } };
      const error = {
        type: 'error',
        error: { source: 'source' },
        session: { id: 'session-id' },
        view: { id: 'view-id' },
      };
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data: view,
      } as unknown as ServerEvent);
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'main-process',
        data: error,
      } as unknown as ServerEvent);

      // `process.exit()` runs only the synchronous 'exit' listeners: no quit event, no later turn.
      processListeners.exit.call(undefined);

      expect(mockBatchPost.mock.calls.map(([data]) => (data as { type: string }).type)).toEqual(['view', 'error']);
      expect(mockBatchWritePendingSync).toHaveBeenCalled();
    });

    it('should treat a quit as an exit', async () => {
      await Transport.create(config, eventManager, sessionManager);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- a mock's call list, not a method to call
      const beforeQuit = (vi.mocked(app.on).mock.calls as [string, () => void][]).find(
        ([name]) => name === 'before-quit'
      )![1];

      beforeQuit();

      expect(mockBatchWritePendingSync).toHaveBeenCalled();
    });

    it('should hold a renderer event that calls itself telemetry like any other renderer event', async () => {
      session.trackingType = TrackingType.TRACKED_ON_ERROR;
      await Transport.create(config, eventManager, sessionManager);

      const data = {
        type: 'telemetry',
        telemetry: { status: 'error' },
        session: { id: 'session-id' },
        view: { id: 'v' },
      };
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: 'renderer',
        data,
      } as unknown as ServerEvent);

      expect(mockBatchPost).not.toHaveBeenCalled();
    });

    it('should post telemetry straight to the batch, even while the session is withheld', async () => {
      session.trackingType = TrackingType.TRACKED_ON_ERROR;
      await Transport.create(config, eventManager, sessionManager);

      const data = { type: 'telemetry', telemetry: { status: 'error' } };
      eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data } as unknown as ServerEvent);

      expect(mockBatchPost).toHaveBeenCalledWith(data);
    });

    it('should not handle events that do not match', async () => {
      await Transport.create(config, eventManager, sessionManager);

      eventManager.notify({
        kind: EventKind.RAW,
        source: 'main-process',
        data: { test: 'data' },
      } as unknown as RawEvent);

      expect(mockBatchPost).not.toHaveBeenCalled();
    });

    it('should not handle SERVER events with different track type', async () => {
      await Transport.create(config, eventManager, sessionManager);

      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.LOGS,
        data: { test: 'data' },
      });

      expect(mockBatchPost).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should flush all batch managers', async () => {
      const transport = await Transport.create(config, eventManager, sessionManager);
      await transport.flush();

      // FlashCat only has the RUM track (no spans intake), so exactly one batch manager.
      expect(mockBatchFlush).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch configuration', () => {
    it('should use default batch size when not specified', async () => {
      await Transport.create(config, eventManager, sessionManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          batchSize: BatchSizes.MEDIUM,
        })
      );
    });

    it('should use configured batch size', async () => {
      const configWithBatchSize = createTestConfiguration({ batchSize: 'SMALL' });
      await Transport.create(configWithBatchSize, eventManager, sessionManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        configWithBatchSize,
        expect.objectContaining({
          batchSize: BatchSizes.SMALL,
        })
      );
    });

    it('should use default upload frequency when not specified', async () => {
      await Transport.create(config, eventManager, sessionManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          uploadFrequency: BatchUploadFrequencies.NORMAL,
        })
      );
    });

    it('should use configured upload frequency', async () => {
      const configWithFrequency = createTestConfiguration({ uploadFrequency: 'FREQUENT' });
      await Transport.create(configWithFrequency, eventManager, sessionManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        configWithFrequency,
        expect.objectContaining({
          uploadFrequency: BatchUploadFrequencies.FREQUENT,
        })
      );
    });
  });
});
