import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    config = createTestConfiguration();
    session = { id: 'session-id', status: 'active', trackingType: TrackingType.TRACKED, sampleRate: 100 };
    sessionManager = {
      getSession: () => session,
      setSessionHasError: vi.fn(),
      writePendingSync: vi.fn(),
    } as unknown as SessionManager;
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
      eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data } as unknown as ServerEvent);

      expect(mockBatchPost).toHaveBeenCalledWith(data);
    });

    it('should hold the RUM events of a session withheld by sessionOnError', async () => {
      session.trackingType = TrackingType.TRACKED_ON_ERROR;
      await Transport.create(config, eventManager, sessionManager);

      const data = { type: 'action', session: { id: 'session-id' }, view: { id: 'view-id' } };
      eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data } as unknown as ServerEvent);

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
      eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data: view } as unknown as ServerEvent);
      eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data: error } as unknown as ServerEvent);
      const calls: string[] = [];
      const record = (name: string) => () => calls.push(name);
      mockBatchPost.mockImplementationOnce(record('post:view')).mockImplementationOnce(record('post:error'));
      mockBatchWritePendingSync.mockImplementationOnce(record('batch'));
      vi.mocked(sessionManager.writePendingSync).mockImplementationOnce(record('session'));

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.APP_MAY_EXIT });

      // The release first, so that the write takes it along; the session's mark with it.
      expect(calls).toEqual(['post:view', 'post:error', 'batch', 'session']);
    });

    it('should treat a quit as an exit', async () => {
      await Transport.create(config, eventManager, sessionManager);
      const beforeQuit = (vi.mocked(app.on).mock.calls as [string, () => void][]).find(
        ([name]) => name === 'before-quit'
      )![1];

      beforeQuit();

      expect(mockBatchWritePendingSync).toHaveBeenCalled();
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
