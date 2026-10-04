import { app } from 'electron';

import { BatchSizes, BatchUploadFrequencies, type Configuration } from '../config';
import { EventKind, EventTrack, type EventManager, type ServerEvent } from '../event';
import type { SessionManager } from '../domain/session';
import { BatchManager } from './batch';
import { WithheldEventBuffer } from './WithheldEventBuffer';

/**
 * Orchestrates event transport by routing server events from registered domains
 * through dedicated {@link BatchManager} instances for disk-buffered delivery.
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
    const post = (data: unknown) => batchManager.post(data);
    const withheldEventBuffer =
      track === EventTrack.RUM ? new WithheldEventBuffer(this.eventManager, this.sessionManager, post) : undefined;

    this.eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER && event.track === track,
      handle: (event) => {
        // `canHandle` already filtered on the track at runtime; the repeat is what narrows `data`.
        if (withheldEventBuffer && event.track === EventTrack.RUM && event.data.type !== 'telemetry') {
          withheldEventBuffer.collect(event.data);
        } else {
          post(event.data);
        }
      },
    });
  }

  /** Flushes all batch managers, rotating pending data and triggering uploads. */
  async flush() {
    await Promise.all(this.batchManagers.map((m) => m.flush()));
  }
}
