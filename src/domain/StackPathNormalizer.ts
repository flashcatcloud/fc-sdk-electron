import * as fs from 'node:fs/promises';
import { app } from 'electron';
import type { StackTrace } from '@flashcatcloud/browser-core';
import { addError as addTelemetryError } from './telemetry';

/**
 * Scheme every in-application frame is rewritten to. Matches the Sentry Electron SDK, so an
 * application already uploading sourcemaps for Sentry keeps the exact same minified paths.
 *
 * The FlashCat backend keys sourcemap lookup on `url.Parse(<frame url>).Path`, which turns
 * `app:///dist/main.js` into `/dist/main.js` — the path an upload made with
 * `flashcat-cli sourcemaps upload --minified-path-prefix /dist` is stored under.
 */
const APP_URL_PREFIX = 'app:///';

/** Separator `toStackTraceString` puts between a frame's function and its URL. */
const FRAME_URL_SEPARATOR = ' @ ';

/**
 * Rewrite a stack frame's absolute path. Returning `undefined` falls through to the built-in
 * `app:///` normalization; returning a string uses it verbatim.
 */
export type NormalizeStackPath = (absolutePath: string) => string | undefined;

/** Shape of the error payload carried by an assembled renderer RUM event. */
interface NormalizableRumEvent {
  error?: {
    stack?: string;
    causes?: { stack?: string }[];
  };
}

/**
 * Rewrites the absolute file paths in error stacks to `app:///<path relative to the app root>`.
 *
 * Frame URLs are runtime *installation* paths, which the build that produced the sourcemaps cannot
 * know: they carry the user name on Windows (`C:/Users/<user>/AppData/Local/Programs/…`), a random
 * mount point for a Linux AppImage (`/tmp/.mount_XXXXXX/…`), and the bundle location on macOS
 * (`/Applications/MyApp.app/Contents/Resources/app.asar/…`). Uploaded sourcemaps could therefore
 * only ever match on the one machine the paths happened to describe.
 *
 * Anchoring the paths on the application root removes every machine-specific segment and leaves a
 * path that is stable across installs and platforms — the same approach, and the same `app:///`
 * scheme, the Sentry Electron SDK uses.
 *
 * The application root comes from `app.getAppPath()`, which already points *inside* the archive
 * for an asar-packaged app (`…/Resources/app.asar`), so packaged and unpackaged (development)
 * builds both collapse to the same `app:///dist/main.js`.
 *
 * **Anything that is not a path under the application root is returned untouched** — Node's
 * internal frames, Electron's own code, native modules in `app.asar.unpacked`, `http(s)` URLs,
 * and paths an application already normalized itself (`/dist/renderer.js`, `app:///dist/x.js`).
 * That last case matters: applications working around the absence of this feature normalize their
 * renderer stacks in `beforeSend`, and re-normalizing their output would break them.
 */
export class StackPathNormalizer {
  /**
   * `undefined` when the built-in rewriting is not to happen: either it is disabled, or the
   * application root could not be determined, leaving no safe base to anchor paths on.
   */
  private readonly appRootPattern: RegExp | undefined;

  /**
   * Use {@link create} in production; the explicit root exists so tests can pin one.
   *
   * `normalizeStackPath` is honoured even when the built-in normalization is off: the option
   * governs the built-in `app:///` step only, never the application's own rewriting.
   */
  constructor(
    enabled: boolean,
    appRoot: string | undefined,
    private readonly normalizeStackPath?: NormalizeStackPath
  ) {
    this.appRootPattern = enabled ? buildAppRootPattern(appRoot) : undefined;
  }

  static async create(enabled: boolean, normalizeStackPath?: NormalizeStackPath): Promise<StackPathNormalizer> {
    return new StackPathNormalizer(enabled, enabled ? await readAppRoot() : undefined, normalizeStackPath);
  }

  /**
   * Rewrite the frame URLs of a main-process stack trace, in place, before it is formatted.
   *
   * Mirrors how Sentry normalizes `frame.filename`: only the URL of a frame is considered, so a
   * path quoted in the error message can never be mistaken for one.
   */
  normalizeStackTrace(stackTrace: StackTrace): StackTrace {
    if (!this.isActive()) {
      return stackTrace;
    }

    for (const frame of stackTrace.stack) {
      if (frame.url) {
        frame.url = this.normalizePath(frame.url);
      }
    }
    return stackTrace;
  }

  /**
   * Rewrite the stacks carried by an assembled renderer RUM event, in place.
   *
   * Renderer stacks reach the main process already formatted, so they are rewritten frame line by
   * frame line rather than through `StackTrace`. Only stacks are touched — `view.url` and resource
   * URLs identify the page, not the code, and rewriting them would change view attribution.
   */
  normalizeRumEvent(event: unknown): void {
    if (!this.isActive()) {
      return;
    }

    const error = (event as NormalizableRumEvent | undefined)?.error;
    if (!error) {
      return;
    }

    if (error.stack) {
      error.stack = this.normalizeStackString(error.stack);
    }
    for (const cause of error.causes ?? []) {
      if (cause.stack) {
        cause.stack = this.normalizeStackString(cause.stack);
      }
    }
  }

  private isActive(): boolean {
    return this.appRootPattern !== undefined || this.normalizeStackPath !== undefined;
  }

  /**
   * Rewrite the URL half of every `at <func> @ <url>:<line>:<column>` frame of a formatted stack.
   *
   * The `Name: message` header carries no separator and is left alone, as is any line whose URL
   * does not sit under the application root.
   */
  private normalizeStackString(stack: string): string {
    return stack
      .split('\n')
      .map((line) => {
        const separatorIndex = line.indexOf(FRAME_URL_SEPARATOR);
        if (separatorIndex === -1) {
          return line;
        }
        const urlStart = separatorIndex + FRAME_URL_SEPARATOR.length;
        return line.slice(0, urlStart) + this.normalizePath(line.slice(urlStart));
      })
      .join('\n');
  }

  /** The application's own rewriting wins; otherwise fall back to the built-in one. */
  private normalizePath(path: string): string {
    const custom = this.applyNormalizeStackPath(path);
    if (custom !== undefined) {
      return custom;
    }
    return this.appRootPattern ? normalizeUrlToAppRoot(path, this.appRootPattern) : path;
  }

  private applyNormalizeStackPath(path: string): string | undefined {
    if (!this.normalizeStackPath) {
      return undefined;
    }

    let rewritten: string | undefined;
    try {
      rewritten = this.normalizeStackPath(path);
    } catch (error) {
      // A user callback must never take the reporting pipeline down: report it as an SDK error
      // and fall back to the built-in behaviour.
      addTelemetryError(error);
      return undefined;
    }

    return typeof rewritten === 'string' && rewritten.length > 0 ? rewritten : undefined;
  }
}

/**
 * Port of Sentry's `normalizeUrlToBase`, whose behaviour this SDK deliberately matches. See
 * {@link buildAppRootPattern} for the differences.
 */
function normalizeUrlToAppRoot(url: string, appRootPattern: RegExp): string {
  let normalized = url;
  try {
    // Chromium percent-encodes renderer frame URLs, so `My App` arrives as `My%20App`.
    normalized = decodeURI(url);
  } catch {
    // Malformed escape sequence — keep the raw URL, it may still match.
  }

  return (
    normalized
      // Windows separators, so one pattern covers every platform.
      .replace(/\\/g, '/')
      // Webpack leaves an intermediate `webpack:/` segment inside otherwise absolute paths.
      .replace(/webpack:\/?/g, '')
      .replace(appRootPattern, APP_URL_PREFIX)
  );
}

/**
 * Build the pattern matching the application root at the head of a frame URL.
 *
 * `(file://)?/*` absorbs the `file:///C:/…` and `/C:/…` forms Chromium and V8 produce, and the
 * match is case-insensitive because Windows drive letters are reported in either case.
 *
 * Two deliberate departures from Sentry's equivalent, both found by running a packaged build:
 *
 * - It is **anchored**. Sentry's pattern matches anywhere in the string, so a root that appears
 *   mid-path rewrites the tail and keeps the head: an application root reported as `/tmp/x.asar`
 *   whose frames resolve through macOS's `/tmp → /private/tmp` symlink yielded the nonsensical
 *   `/privateapp:///dist/main.js`. Only a match at the head denotes "under the app root".
 * - It requires **at least one separator** after the root, where Sentry ends in `/*`. Otherwise a
 *   sibling directory that merely starts with the root matches: `app.asar.unpacked`, where
 *   Electron keeps files excluded from the archive, would become `app:///.unpacked/…`.
 */
function buildAppRootPattern(appRoot: string | undefined): RegExp | undefined {
  // Trailing separators are stripped so the pattern can demand one of its own.
  const normalizedRoot = appRoot?.replace(/\\/g, '/').replace(/\/+$/, '');
  // An empty root would produce a pattern matching the head of every path — refuse to normalize.
  if (!normalizedRoot) {
    return undefined;
  }

  const escapedRoot = normalizedRoot.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  return new RegExp(`^(file://)?/*${escapedRoot}/+`, 'i');
}

/**
 * The application root, or `undefined` outside a usable Electron context.
 *
 * Resolved through `realpath` because V8 and Chromium report frames under the *resolved* path:
 * on macOS an application under `/tmp` reports frames under `/private/tmp`, which the unresolved
 * root would never match.
 */
async function readAppRoot(): Promise<string | undefined> {
  let appRoot: string;
  try {
    appRoot = app.getAppPath();
  } catch {
    return undefined;
  }

  try {
    return await fs.realpath(appRoot);
  } catch {
    // Not resolvable (unusual packaging, a permission error) — the raw path is still the best
    // guess, and a wrong root simply means no frame matches it.
    return appRoot;
  }
}
