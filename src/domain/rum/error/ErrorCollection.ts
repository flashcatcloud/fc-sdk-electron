import {
  computeStackTrace,
  Context,
  generateUUID,
  jsonStringify,
  timeStampNow,
  toStackTraceString,
} from '@flashcatcloud/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import type { RawRumError } from '../rawRumData.types';
import { monitor } from '../../telemetry';
import type { StackPathNormalizer } from '../../StackPathNormalizer';
import { toIntakeTimeStamp } from '../../../tools/intakeTimeStamp';

export interface ErrorOptions {
  /**
   * Custom context for the added error.
   */
  context?: Context;

  /**
   * Timestamp for the added error.
   */
  startTime?: number;
}

/**
 * Collect RUM error events for:
 * - uncaught exception
 * - unhandled rejection
 * - manually added error
 */
export class ErrorCollection {
  private readonly errorListener: (error: unknown) => void;

  constructor(
    private readonly eventManager: EventManager,
    private readonly stackPathNormalizer: StackPathNormalizer
  ) {
    this.errorListener = monitor((error: unknown) =>
      this.emitError(error, {
        handling: 'unhandled',
        source: 'source',
        nonErrorPrefix: 'Uncaught',
      })
    );
    process.on('uncaughtException', this.errorListener);
    process.on('unhandledRejection', this.errorListener);
  }

  getApi() {
    return {
      addError: (error: unknown, options?: ErrorOptions) =>
        this.emitError(error, {
          handling: 'handled',
          source: 'custom',
          nonErrorPrefix: 'Provided',
          ...options,
        }),
    };
  }

  stop(): void {
    process.off('uncaughtException', this.errorListener);
    process.off('unhandledRejection', this.errorListener);
  }

  private emitError(
    error: unknown,
    options: ErrorOptions & {
      handling: RawRumError['error']['handling'];
      source: RawRumError['error']['source'];
      nonErrorPrefix: 'Uncaught' | 'Provided';
    }
  ): void {
    const { message, stack, kind } = formatError(error, options.nonErrorPrefix, this.stackPathNormalizer);
    // `startTime` is caller-supplied through the public `addError` options, so it arrives with
    // whatever precision the caller had — `performance.timeOrigin + performance.now()`, say.
    const startTime = options.startTime === undefined ? timeStampNow() : toIntakeTimeStamp(options.startTime);

    const errorEvent: RawRumError = {
      type: 'error',
      date: startTime,
      context: options.context ?? {},
      error: {
        id: generateUUID(),
        message,
        source: options.source,
        handling: options.handling,
        stack,
        type: kind,
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: errorEvent,
      startTime,
    });
  }
}

/**
 * Normalizes the stack to the `at ${func} @ ${url}:${line}:${column}` shape the FlashCat
 * backend parses, instead of forwarding V8's native `at ${func} (${url}:${line}:${column})`.
 *
 * The same helpers are used by the browser SDK, keeping both processes on one stack format.
 *
 * Frame URLs are then anchored on the application root as `app:///<relative path>`, so the
 * sourcemap upload no longer has to guess where the application was installed. See
 * {@link StackPathNormalizer}.
 *
 * Note that Node's internal frames (`node:internal/...`) carry no usable URL and end up
 * wholly in the URL position as `at <anonymous> @ Module._compile (node:internal/...)`.
 * They are left in place: they are meaningless to symbolicate but valuable to read, and the
 * backend is responsible for skipping frames whose URL it cannot parse.
 */
function formatError(
  error: unknown,
  nonErrorPrefix: string,
  stackPathNormalizer: StackPathNormalizer
): { message: string; stack?: string; kind?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: toStackTraceString(stackPathNormalizer.normalizeStackTrace(computeStackTrace(error))),
      kind: error.name,
    };
  }
  return { message: `${nonErrorPrefix} ${jsonStringify(error)}` };
}
