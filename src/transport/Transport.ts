import { app } from 'electron';

import { BatchSizes, BatchUploadFrequencies, type Configuration } from '../config';
import {
  EventKind,
  EventTrack,
  type AppMayExitEvent,
  type EventManager,
  LifecycleKind,
  type ServerEvent,
} from '../event';
import type { SessionManager } from '../domain/session';
import { addError, monitor } from '../domain/telemetry';
import { BatchManager } from './batch';
import { WithheldEventBuffer } from './WithheldEventBuffer';

/**
 * Orchestrates event transport by routing server events from registered domains
 * through dedicated {@link BatchManager} instances for disk-buffered delivery.
 *
 * When the application may be about to exit — an uncaught exception in the main process, or a quit
 * — whatever is queued but not written yet is written before returning, the session state with it:
 * the batch writes on later turns of the event loop, and an exit leaves none. An append already
 * issued is not completed here.
 */
export class Transport {
  // FlashCat ingest only exposes the RUM track (POST /api/v2/rum). It has no
  // APM/trace (`spans`) intake, so the SPANS track is intentionally omitted to
  // avoid uploading to a non-existent endpoint. Main-process HTTP spans are still
  // observable: SpanProcessor converts them into RUM `resource` events on the RUM
  // track. Native APM tracing remains pending product support.
  private tracks: EventTrack[] = [EventTrack.RUM];
  private batchManagers: BatchManager[] = [];
  private basePath: string;
  /**
   * The process is exiting: only the synchronous listeners of the `exit` event run from here on, so
   * whatever arrives is written before returning rather than queued for a turn that never comes.
   */
  private terminal = false;

  private constructor(
    private readonly config: Configuration,
    private readonly eventManager: EventManager,
    private readonly sessionManager: SessionManager
  ) {
    this.basePath = app.getPath('userData');
  }

  /** Creates and fully initializes a Transport instance. */
  static async create(config: Configuration, eventManager: EventManager, sessionManager: SessionManager) {
    const transport = new Transport(config, eventManager, sessionManager);
    for (const track of transport.tracks) {
      await transport.setupTrackBatching(track);
    }

    // After the tracks, whose handlers release what an exit must take along, so this runs last.
    eventManager.registerHandler<AppMayExitEvent>({
      canHandle: (event): event is AppMayExitEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.APP_MAY_EXIT,
      handle: () => transport.writePendingSync(),
    });
    // Every point a quit passes, and the last one a `process.exit()` runs: an error reported after
    // one of them — by a later listener, while quitting — is still taken along by the next. Each
    // pass writes only what arrived since the one before. The exit event is terminal: an error a
    // later exit listener reports has no next pass, so from there on everything is written as it
    // arrives.
    const mayExit = (terminal: boolean) =>
      monitor(() => {
        transport.terminal ||= terminal;
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.APP_MAY_EXIT, terminal });
      });
    app.on('before-quit', mayExit(false));
    app.on('will-quit', mayExit(false));
    process.on('exit', mayExit(true));

    return transport;
  }

  /**
   * Creates a {@link BatchManager} configured with the resolved batch size,
   * upload frequency, and storage path for the given track type.
   */
  private async createBatchManager(trackType: EventTrack) {
    const path = this.basePath;
    const batchSize = this.config.batchSize ? BatchSizes[this.config.batchSize] : BatchSizes.MEDIUM;
    const uploadFrequency = this.config.uploadFrequency
      ? BatchUploadFrequencies[this.config.uploadFrequency]
      : BatchUploadFrequencies.NORMAL;

    const manager = await BatchManager.create(this.config, {
      path,
      trackType,
      batchSize,
      uploadFrequency,
    });
    this.batchManagers.push(manager);

    return manager;
  }

  /**
   * Create a batch manager for a specific track
   * and register an event handler that forwards matching server events.
   *
   * RUM events go through a {@link WithheldEventBuffer} first, which holds those of a session kept by
   * `sessionOnError` until it reports an error. Telemetry shares the track but is not session data,
   * so it goes straight to the batch.
   */
  private async setupTrackBatching(track: EventTrack) {
    const batchManager = await this.createBatchManager(track);
    const withheldEventBuffer =
      track === EventTrack.RUM
        ? new WithheldEventBuffer(this.eventManager, this.sessionManager, (event) => batchManager.post(event))
        : undefined;

    this.eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER && event.track === track,
      handle: (event) => {
        // By provenance, not by what the event calls itself: the SDK's own telemetry is assembled
        // without a source, and is the one thing that bypasses the buffer. A renderer's event
        // carries one whatever its `type` says.
        if (withheldEventBuffer && event.track === EventTrack.RUM && 'source' in event) {
          withheldEventBuffer.collect(event.data);
        } else {
          batchManager.post(event.data);
        }
        if (this.terminal) {
          this.writePendingSync();
        }
      },
    });
  }

  /** Flushes all batch managers, rotating pending data and triggering uploads. */
  async flush() {
    await Promise.all(this.batchManagers.map((m) => m.flush()));
  }

  /** Flushes all batch managers to disk, without uploading. */
  flushToDisk(): Promise<void> {
    return Promise.all(this.batchManagers.map((m) => m.flushToDisk())).then(() => undefined);
  }

  private writePendingSync() {
    for (const batchManager of this.batchManagers) {
      try {
        batchManager.writePendingSync();
      } catch (error) {
        // A batch that cannot be written must not cost the session its state: that write is the
        // one the next launch reads.
        addError(error);
      }
    }
    // After the batches: the release they carry has just marked the session, and the mark must
    // reach disk with them.
    this.sessionManager.writePendingSync();
  }
}
