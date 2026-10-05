import {
  computeBytesCount,
  ONE_KIBI_BYTE,
  ONE_SECOND,
  type TimeStamp,
  timeStampNow,
} from '@flashcatcloud/browser-core';
import { EventKind, type EventManager, type LifecycleEvent, LifecycleKind } from '../event';
import type { RumEvent } from '../domain/rum';
import { type SessionManager, withholdsEvents } from '../domain/session';
import { addTelemetryDebug, setTimeout } from '../domain/telemetry';

/**
 * How much history a withheld session keeps: the minute leading up to its error. The browser SDK
 * makes the same promise.
 */
export const WITHHELD_BUFFER_DURATION = 60 * ONE_SECOND;

/** Memory bound. Above it the least valuable events are dropped first, see {@link EvictionTier}. */
export const WITHHELD_BUFFER_BYTES_LIMIT = 64 * ONE_KIBI_BYTE;
export const WITHHELD_BUFFER_EVENTS_LIMIT = 200;

/**
 * A view is the container its events hang from: the backend builds the session row out of view
 * events, so a detail released without its view would be unreachable. Views are kept out of the
 * eviction budget for that reason, and this only bounds pathological navigation counts.
 */
export const WITHHELD_BUFFER_VIEWS_LIMIT = 50;

/**
 * Correlated errors make every client release at the same instant, right when whatever caused them
 * is already under strain. Releases are spread over this window instead.
 */
export const WITHHELD_BUFFER_RELEASE_MAX_DELAY = 3 * ONE_SECOND;

/** What gets dropped first when the buffer is over budget. Lower goes first. */
const EvictionTier = {
  /** Long tasks, and requests that succeeded without complaint. */
  FIRST: 0,
  /** Actions, vitals, failed requests: they explain what led to the error. */
  LAST: 1,
  /**
   * Errors are the reason the session is kept at all, so they go only once nothing else is left —
   * and even then the newest goes first, because the earliest error is the one that releases the
   * buffer and the one the session is about.
   */
  LAST_RESORT: 2,
} as const;
type EvictionTier = (typeof EvictionTier)[keyof typeof EvictionTier];

interface WithheldView {
  event: RumEvent;
  /** When its latest update arrived. */
  time: number;
}

interface WithheldEvent {
  event: RumEvent;
  viewId: string;
  time: number;
  bytes: number;
  tier: EvictionTier;
}

type SessionSource = Pick<SessionManager, 'getSession' | 'setSessionHasError'>;

type SettleCause = 'session-ended' | 'may-exit';

/**
 * Holds the RUM events of a session kept by `sessionOnError` until it reports an error.
 *
 * It sits right before the batch, after assembly: main-process and renderer events alike reach it
 * final, and a renderer error dropped by the renderer's `beforeSend` never gets here, so it cannot
 * release anything. Nothing it holds is written to disk — a session that never errors leaves no
 * trace — and only the last {@link WITHHELD_BUFFER_DURATION} is kept.
 *
 * The session's first error releases the buffer behind a per-session jitter: views oldest first,
 * then errors, then everything else, oldest first. The session is marked as errored at that moment,
 * not when the error arrives: the mark is what a crash reported on the next launch reads as "the
 * crashed view reached the batch", and until the release it has not. From then on its events go
 * straight to the batch.
 * A session that ends without an error is thrown away with everything it held; its stragglers are
 * discarded at assembly (see `SessionContext`).
 *
 * Unlike a browser page, the main process runs several views at once — its own, and the current
 * one of every window — so "the current view", which is never pruned, is every view whose latest
 * update still reports it active. An ended view is kept as long as its latest update or any of its
 * detail is inside the window: a crash reported on the next launch brings its view along ended, and
 * the crash itself, too large for the budget, does not join the buffer to hold the view in place.
 */
export class WithheldEventBuffer {
  /** Latest event per view, in the order they were last updated. */
  private views = new Map<string, WithheldView>();
  private details: WithheldEvent[] = [];
  private bytes = 0;
  private droppedCount = 0;
  private withheldForSessionId: string | undefined;
  private releaseTimeoutId: ReturnType<typeof setTimeout> | undefined;
  /** When the release was scheduled, which is what freezes the window — see {@link prune}. */
  private releaseScheduledAt: number | undefined;

  constructor(
    eventManager: EventManager,
    private readonly sessionManager: SessionSource,
    private readonly forward: (event: RumEvent) => void
  ) {
    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent =>
        event.kind === EventKind.LIFECYCLE &&
        (event.lifecycle === LifecycleKind.SESSION_EXPIRED || event.lifecycle === LifecycleKind.APP_MAY_EXIT),
      handle: (event) => this.settle(event.lifecycle === LifecycleKind.SESSION_EXPIRED ? 'session-ended' : 'may-exit'),
    });
  }

  collect(event: RumEvent): void {
    const session = this.sessionManager.getSession();
    const sessionId = event.session.id;

    if (session.status === 'active' && sessionId === session.id && withholdsEvents(session)) {
      this.withheldForSessionId = sessionId;
      if (!isReleasingError(event)) {
        this.hold(event);
        return;
      }
      // The session earns its release with this error, which then leaves with the rest, below.
    }

    if (sessionId === this.withheldForSessionId) {
      const bytes = event.type === 'error' ? computeEventBytes(event) : undefined;
      if (bytes !== undefined && bytes > WITHHELD_BUFFER_BYTES_LIMIT) {
        // The session has earned its release, but an error larger than the whole budget would evict
        // the history it is meant to come with. It goes to the batch on its own instead; the history
        // still waits for the jitter, which exists for exactly the correlated outage at hand.
        this.forward(event);
      } else {
        // Typically the error itself: it joins what is held, so the whole history leaves in order.
        this.hold(event, bytes);
      }
      this.scheduleRelease();
      return;
    }

    this.forward(event);
  }

  /** `measuredBytes` is the event's serialized size, when the caller already measured it. */
  private hold(event: RumEvent, measuredBytes?: number): void {
    if (event.type === 'view') {
      // Upsert: a view event is cumulative, so the latest one supersedes the ones before it. The
      // delete moves it to the end, so the map stays ordered by last update.
      this.views.delete(event.view.id);
      this.views.set(event.view.id, { event, time: Date.now() });
      this.evictViewsOverLimit(event.view.id);
      this.prune();
      return;
    }

    const bytes = measuredBytes ?? computeEventBytes(event);
    if (bytes > WITHHELD_BUFFER_BYTES_LIMIT) {
      // It could never be part of a release, and holding it would evict the entire minute before it
      // to make room it will never fit into.
      this.droppedCount += 1;
      return;
    }
    this.details.push({ event, viewId: event.view.id, time: Date.now(), bytes, tier: getEvictionTier(event) });
    this.bytes += bytes;

    this.prune();
    while (this.details.length > WITHHELD_BUFFER_EVENTS_LIMIT || this.bytes > WITHHELD_BUFFER_BYTES_LIMIT) {
      if (!this.evictOne()) {
        break;
      }
    }
  }

  /**
   * Drops the oldest views past the limit: ended ones first, since an active one is still
   * collecting, and never — while any other is left — a view that holds an error, nor the one just
   * updated. A detail is released with or without its view (see {@link release}), but the error is
   * what the session is kept for, and its view is what the backend hangs it from; the view just
   * updated may be the one its error is about to arrive for, as a crash reported on the next launch
   * brings its view first.
   */
  private evictViewsOverLimit(justUpdatedViewId: string): void {
    while (this.views.size > WITHHELD_BUFFER_VIEWS_LIMIT) {
      const viewsWithError = new Set(
        this.details.filter((held) => held.event.type === 'error').map((held) => held.viewId)
      );
      const cost = (viewId: string, view: WithheldView) =>
        (viewsWithError.has(viewId) ? 2 : 0) + (isActiveView(view.event) ? 1 : 0);
      let evictedViewId: string | undefined;
      for (const [viewId, view] of this.views) {
        if (viewId === justUpdatedViewId) {
          continue;
        }
        if (evictedViewId === undefined || cost(viewId, view) < cost(evictedViewId, this.views.get(evictedViewId)!)) {
          evictedViewId = viewId;
        }
      }
      this.views.delete(evictedViewId!);
    }
  }

  /** Drops what has aged out of the window, so the span kept is the one promised. */
  private prune(): void {
    // Once a release is scheduled the window stops moving: a delayed timer must not throw away the
    // very minute the release exists to deliver.
    const oldestAllowed = (this.releaseScheduledAt ?? Date.now()) - WITHHELD_BUFFER_DURATION;
    let cutoff = 0;
    while (cutoff < this.details.length && this.details[cutoff].time < oldestAllowed) {
      this.bytes -= this.details[cutoff].bytes;
      this.droppedCount += 1;
      cutoff += 1;
    }
    if (cutoff > 0) {
      this.details = this.details.slice(cutoff);
    }

    // A view is kept as the container of its detail, so an ended view that aged out of the window
    // with none of its detail left has nothing to contain. An active one stays: it is where the next
    // error hangs from.
    const viewsWithDetail = new Set(this.details.map((held) => held.viewId));
    for (const [viewId, view] of this.views) {
      if (!isActiveView(view.event) && view.time < oldestAllowed && !viewsWithDetail.has(viewId)) {
        this.views.delete(viewId);
      }
    }
  }

  /** Removes one event of the least valuable tier present. Returns false when there is none left. */
  private evictOne(): boolean {
    for (const tier of [EvictionTier.FIRST, EvictionTier.LAST]) {
      const index = this.details.findIndex((held) => held.tier === tier);
      if (index !== -1) {
        this.evictAt(index);
        return true;
      }
    }
    // Only errors are left: the newest goes, so an error storm cannot push out the first error.
    if (this.details.length > 0) {
      this.evictAt(this.details.length - 1);
      return true;
    }
    return false;
  }

  private evictAt(index: number): void {
    this.bytes -= this.details[index].bytes;
    this.droppedCount += 1;
    this.details.splice(index, 1);
  }

  private scheduleRelease(): void {
    if (this.releaseTimeoutId !== undefined) {
      return;
    }
    this.releaseScheduledAt = Date.now();
    this.releaseTimeoutId = setTimeout(() => this.release(), computeReleaseDelay(this.withheldForSessionId!));
  }

  /**
   * Called when what is held may not get another chance to leave: the session ended (discarding
   * what never earned its release), or the application may be about to exit (keeping it: a quit
   * that does not happen leaves the session running, and a real one takes the buffer with it either
   * way). Either way a session that reported its error is released now rather than after the
   * jitter. The transport then writes what an exit would otherwise take along, see `Transport`.
   */
  private settle(cause: SettleCause): void {
    if (this.withheldForSessionId === undefined) {
      return;
    }
    const session = this.sessionManager.getSession();
    const hasErrored = session.id === this.withheldForSessionId && !!session.hasError;
    if (this.releaseTimeoutId !== undefined || hasErrored) {
      this.release();
    } else if (cause === 'session-ended') {
      this.clear();
    }
  }

  private release(): void {
    this.prune();
    // Marked as of when the error arrived, which is inside the session's entry even if the session
    // ended since: a mark on the entry is what lets the session's final events through assembly.
    this.sessionManager.setSessionHasError(
      this.withheldForSessionId!,
      (this.releaseScheduledAt ?? timeStampNow()) as TimeStamp
    );

    // Oldest first: the backend builds the session out of whichever of its views arrives first.
    const views = [...this.views.values()].map((view) => view.event).sort((left, right) => left.date - right.date);

    views.forEach((view) => this.forward(view));
    // Every detail held, whether or not its view still is: an errored session must not lose its
    // error or its history, and the views only order the release. The errors right behind the
    // views, then the rest oldest first: if the application is about to exit, the first writes are
    // the ones most likely to make it.
    this.details.filter((held) => held.event.type === 'error').forEach((held) => this.forward(held.event));
    this.details.filter((held) => held.event.type !== 'error').forEach((held) => this.forward(held.event));

    addTelemetryDebug('Error session event buffer released', {
      'buffer.views_count': views.length,
      'buffer.events_count': this.details.length,
      'buffer.dropped_count': this.droppedCount,
      'buffer.bytes': this.bytes,
    });

    this.clear();
  }

  private clear(): void {
    clearTimeout(this.releaseTimeoutId);
    this.releaseTimeoutId = undefined;
    this.releaseScheduledAt = undefined;
    this.views = new Map();
    this.details = [];
    this.bytes = 0;
    this.droppedCount = 0;
    this.withheldForSessionId = undefined;
  }
}

/**
 * An error the application reported. The SDK's own failures are not: counting them would turn every
 * session into an error session for any customer whose network blocks the intake.
 */
function isReleasingError(event: RumEvent): boolean {
  return event.type === 'error' && event.error.source !== 'agent';
}

function isActiveView(view: RumEvent): boolean {
  return view.type === 'view' && view.view.is_active !== false;
}

function computeEventBytes(event: RumEvent): number {
  return computeBytesCount(JSON.stringify(event));
}

function getEvictionTier(event: RumEvent): EvictionTier {
  switch (event.type) {
    case 'error':
      return EvictionTier.LAST_RESORT;
    case 'long_task':
      return EvictionTier.FIRST;
    case 'resource': {
      // A request that failed is part of how the error happened; one that succeeded rarely is. An
      // unknown status code is treated like an ordinary success.
      const statusCode = event.resource.status_code ?? -1;
      return statusCode === 0 || statusCode >= 400 ? EvictionTier.LAST : EvictionTier.FIRST;
    }
    default:
      return EvictionTier.LAST;
  }
}

/**
 * Deterministic per session, so a client always spreads to the same offset.
 *
 * Multiplicative rather than a running sum: session ids are same-length strings drawn from the same
 * small alphabet, so summing their character codes lands almost every session within a few hundred
 * milliseconds of the same value — which delays the herd instead of spreading it.
 */
export function computeReleaseDelay(sessionId: string): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = Math.imul(hash, 31) + sessionId.charCodeAt(i);
  }
  return Math.abs(hash) % WITHHELD_BUFFER_RELEASE_MAX_DELAY;
}
