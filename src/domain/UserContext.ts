import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow, type TimeStamp } from '@flashcatcloud/browser-core';
import { DiskValueHistory } from '../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from './session';
import { displayWarn } from '../tools/display';
import { EventKind, LifecycleKind, type EventManager } from '../event';

export const USER_HISTORY_FILE_NAME = '_dd_user_history';

/**
 * The logged-in user's identity, as the application knows it.
 *
 * Deliberately only the three standard fields. `anonymous_id` is **not** part of this shape and
 * cannot be reached through it: it is device-scoped, owned by `AnonymousId`, and has to survive a
 * login, a logout, and a different user logging in on the same machine.
 */
export interface User {
  id: string;
  name?: string;
  email?: string;
}

/**
 * The only keys copied out of a caller-supplied object. Everything else is dropped, which is what
 * keeps `setUser({ anonymous_id: 'x' })` from reaching an event.
 *
 * Upstream's equivalent (`@datadog/electron-sdk` 0.7.0, `ContextManager.filterReservedKeys`) only
 * excludes the standard fields from its free-form `extraInfo` bag, so `addUserExtraInfo({
 * anonymous_id })` there overwrites the device id. We do not ship `extraInfo` — if it is ever
 * added, `anonymous_id` has to be reserved alongside `id`/`name`/`email`, or unique-user counting
 * becomes corruptible from application code.
 */
const STANDARD_FIELDS = ['id', 'name', 'email'] as const;

/**
 * Holds the identity set through `setUser`, and answers two different questions with two different
 * stores:
 *
 * - **"who is logged in right now"** (`get`) — what `getUser()` returns and what the bridge
 *   broadcasts to renderers. A plain field, so `clearUser()` takes effect immediately.
 * - **"who was logged in when this event happened"** (`find`) — what event assembly asks. A
 *   time-indexed history, because a main-process event is not necessarily assembled in the moment
 *   it describes: a native crash is parsed on the *next* startup and carries the crash's original
 *   timestamp, and `addError` accepts a caller-supplied `startTime`. Attributing those to whoever
 *   happens to be logged in at assembly time would hand one user's crash to another.
 *
 * The history is disk-backed for the same reason `ViewContext`'s is: it has to outlive the process
 * that recorded it, or the crash parsed on the next startup finds nothing. That does mean the
 * identity is written to `userData` in plain text, like the anonymous id and the session file
 * beside it.
 */
export class UserContext {
  /** Who is logged in now, or `undefined` after `clear()` and before any `set()`. */
  private current: User | undefined;

  private constructor(
    private readonly history: DiskValueHistory<User>,
    private readonly eventManager: EventManager
  ) {}

  static async init(eventManager: EventManager, expireDelay = SESSION_TIME_OUT_DELAY): Promise<UserContext> {
    const filePath = path.join(app.getPath('userData'), USER_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<User>({ filePath, expireDelay });

    // A run that ended without `clearUser` — the normal case, since quitting is not logging out —
    // leaves its entry open, and restoring it still-active would attribute this process's events
    // to the previous run's user until the application calls `setUser` again. If someone else is
    // now using the machine, that is a leak rather than a rounding error. Closing it here draws
    // the line at the process boundary: earlier timestamps still resolve to that user, which is
    // what a crash from the previous run needs, and nothing new does.
    //
    // Closed one millisecond *before* now, because `find` treats `endTime` as inclusive and the
    // first main-process view is created in the same millisecond as this call — observed against
    // dev, where a second run stamped its opening view with the first run's user. The previous run
    // ended strictly before this one began, so excluding the boundary is also the truthful bound.
    history.closeActive((timeStampNow() - 1) as TimeStamp);

    return new UserContext(history, eventManager);
  }

  set(user: User): void {
    const sanitized = sanitizeUser(user);
    if (!sanitized) {
      // Rejected calls must not reach the renderers: pushing here would tell them the identity
      // changed when it did not.
      return;
    }

    // One clock read for both ends. Reading it twice leaves a gap between the entry that closes
    // and the one that opens, and an event landing inside that gap finds no identity at all —
    // the millisecond race `ViewCollection.createNewView` avoids the same way.
    const startTime = timeStampNow();
    this.history.closeActive(startTime);
    this.history.add(sanitized, startTime);
    this.current = sanitized;
    this.notifyChange();
  }

  /**
   * The history entry is closed rather than deleted, so an event describing a moment before the
   * logout still resolves to the user who was logged in then. `find` treats both ends of an entry
   * as inclusive, so an event stamped with the exact millisecond of the logout resolves to that
   * user too — it describes a moment no later than the logout, which is the same answer.
   */
  clear(): void {
    this.history.closeActive(timeStampNow());
    this.current = undefined;
    this.notifyChange();
  }

  /**
   * The identity in force now. Returns a copy: the stored object is handed to every event that
   * looks it up, so a caller mutating it would rewrite history.
   */
  get(): User | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  /**
   * The identity in force at `startTime`, or `undefined` if nobody was logged in then. Events from
   * before the first `setUser` must resolve to `undefined` rather than to the anonymous id — see
   * `registerCommonContext` for why `usr.id` is never backfilled.
   */
  find(startTime: TimeStamp): User | undefined {
    const user = this.history.find(startTime);
    return user ? { ...user } : undefined;
  }

  private notifyChange(): void {
    this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });
  }
}

/**
 * Which moment an event's identity is resolved at.
 *
 * **Point-in-time events** (error, resource, action, vital…) resolve at their own timestamp. That
 * is what lets a native crash parsed on the next startup be attributed to whoever was logged in
 * when it happened, rather than to whoever is logged in when it is finally read off disk.
 *
 * **View events resolve at the moment they are emitted**, because a view is an interval rather
 * than an instant: it is re-reported as it grows (`_dd.document_version`), and the backend derives
 * the session's identity from the **last** view row it receives
 * (`buildSessionViewUpdates` in fc-rum reads `lastView.UserID`). The main process emits exactly one
 * synthetic view per session, spanning the whole session, so resolving it at its start time would
 * mean the identity never reaches the session at all — `setUser` cannot run before `init`, so the
 * view always starts logged-out. The same applies to a renderer page view that spans a login.
 */
export function resolveEventUser(
  getUser: (startTime: TimeStamp) => User | undefined,
  eventType: string | undefined,
  startTime: TimeStamp
): User | undefined {
  return getUser(eventType === 'view' ? timeStampNow() : startTime);
}

/**
 * Copies the standard fields off a caller-supplied object, or rejects the call.
 *
 * Rejection is all-or-nothing on purpose. Accepting an `id` while dropping a malformed `name`
 * would report an identity the application never asked for, and a half-applied identity is harder
 * to notice than none at all.
 */
function sanitizeUser(user: User): User | undefined {
  if (typeof user !== 'object' || user === null) {
    displayWarn('setUser expects an object with a string `id`; the call was ignored.');
    return undefined;
  }

  if (typeof user.id !== 'string' || user.id === '') {
    displayWarn('The property "id" of the user is required and must be a non-empty string; the call was ignored.');
    return undefined;
  }

  const sanitized = { id: user.id } as User;

  for (const field of STANDARD_FIELDS) {
    const value = user[field];
    if (value === undefined || field === 'id') {
      continue;
    }
    if (typeof value !== 'string') {
      displayWarn(`The property "${field}" of the user must be a string; the call was ignored.`);
      return undefined;
    }
    sanitized[field] = value;
  }

  return sanitized;
}
