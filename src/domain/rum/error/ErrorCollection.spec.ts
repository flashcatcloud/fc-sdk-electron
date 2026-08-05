import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCollection } from './ErrorCollection';
import { EventFormat, EventKind, EventManager, type RawRumEvent } from '../../../event';
import type { RawRumError } from '../rawRumData.types';
import { StackPathNormalizer } from '../../StackPathNormalizer';

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(() => '/mock/app/root') },
}));

describe('ErrorCollection', () => {
  let eventManager: EventManager;
  let errorCollection: ErrorCollection;
  let rawRumEvents: RawRumEvent[];
  // Off by default so the existing expectations keep seeing raw absolute paths; the tests that
  // care about normalization build their own.
  let stackPathNormalizer: StackPathNormalizer;

  beforeEach(() => {
    eventManager = new EventManager();
    rawRumEvents = [];
    stackPathNormalizer = new StackPathNormalizer(false, undefined);

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
  });

  afterEach(() => {
    errorCollection.stop();
  });

  describe('uncaughtException', () => {
    it('emits an error event with correct fields from an Error object', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      process.emit('uncaughtException', new Error('test error'));

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.type).toBe('error');
      expect(data.error.message).toBe('test error');
      expect(data.error.source).toBe('source');
      expect(data.error.handling).toBe('unhandled');
      expect(data.error.type).toBe('Error');
      expect(data.error.stack).toBeDefined();
      expect(data.error.id).toBeDefined();
    });

    it('emits an error event with fallback message from a non-Error value', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      process.emit('uncaughtException', 'string error' as unknown as Error);

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('Uncaught "string error"');
      expect(data.error.stack).toBeUndefined();
      expect(data.error.type).toBeUndefined();
    });
  });

  describe('unhandledRejection', () => {
    it('emits an error event with correct fields from an Error rejection', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      process.emit('unhandledRejection', new Error('test rejection'), Promise.resolve());

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('test rejection');
      expect(data.error.source).toBe('source');
      expect(data.error.handling).toBe('unhandled');
      expect(data.error.stack).toBeDefined();
    });

    it('emits an error event with fallback message from a non-Error rejection', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      process.emit('unhandledRejection', 'string rejection', Promise.resolve());

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('Uncaught "string rejection"');
      expect(data.error.stack).toBeUndefined();
    });
  });

  describe('getApi().addError', () => {
    it('emits an error event with handling: handled and source: custom', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      errorCollection.getApi().addError(new Error('manual error'));

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.type).toBe('error');
      expect(data.error.message).toBe('manual error');
      expect(data.error.source).toBe('custom');
      expect(data.error.handling).toBe('handled');
      expect(data.error.type).toBe('Error');
      expect(data.error.stack).toBeDefined();
      expect(data.error.id).toBeDefined();
    });

    it('emits an error event with custom context', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      errorCollection.getApi().addError(new Error('manual error'), { context: { key: 'value' } });

      const data = rawRumEvents[0].data as RawRumError;
      expect(data.context).toEqual({ key: 'value' });
    });

    it('emits an error event with custom startTime', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      errorCollection.getApi().addError(new Error('manual error'), { startTime: 1234567890 });

      expect(rawRumEvents[0].startTime).toBe(1234567890);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.date).toBe(1234567890);
    });

    /**
     * `startTime` is caller-supplied, so it arrives with whatever precision the caller had —
     * `performance.timeOrigin + performance.now()` is fractional, for one. The intake decodes
     * `date` into an int64 and Go drops the whole event on a fraction, without a word.
     */
    it('rounds a fractional custom startTime', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      errorCollection.getApi().addError(new Error('manual error'), { startTime: 1785900421429.7532 });

      const data = rawRumEvents[0].data as RawRumError;
      expect(Number.isInteger(data.date)).toBe(true);
      expect(data.date).toBe(1785900421430);
      expect(rawRumEvents[0].startTime).toBe(1785900421430);
    });

    it('still defaults to now when startTime is omitted', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      errorCollection.getApi().addError(new Error('manual error'));

      expect(Number.isInteger(rawRumEvents[0].startTime)).toBe(true);
      expect(rawRumEvents[0].startTime).toBeGreaterThan(0);
    });

    it('emits an error event with fallback message from a non-Error value', () => {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);

      errorCollection.getApi().addError('string error');

      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('Provided "string error"');
      expect(data.error.source).toBe('custom');
      expect(data.error.handling).toBe('handled');
    });
  });

  describe('stack formatting', () => {
    function stackOf(error: unknown): string | undefined {
      errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);
      errorCollection.getApi().addError(error);
      return (rawRumEvents[0].data as RawRumError).error.stack;
    }

    it('rewrites frames to the `at func @ url:line:column` shape the backend parses', () => {
      const stack = stackOf(new Error('formatted'));

      // V8's native `at func (url:line:column)` must not survive.
      expect(stack).not.toMatch(/^\s*at\s+\S+\s+\([^)]*:\d+:\d+\)$/m);
      expect(stack).toMatch(/^\s*at\s+.+\s@\s.+:\d+:\d+$/m);
    });

    it('puts an absolute file path in the URL position, so sourcemap lookup can key on it', () => {
      const stack = stackOf(new Error('formatted'));

      // The frame for this spec file itself.
      expect(stack).toMatch(/\sat\s.+\s@\s\S*ErrorCollection\.spec\.ts:\d+:\d+/);
    });

    it('keeps the `Name: message` header line', () => {
      const stack = stackOf(new TypeError('bad type'));

      expect(stack?.split('\n')[0]).toBe('TypeError: bad type');
    });

    it("leaves Node's internal frames in the stack even though they carry no usable URL", () => {
      // Produced by requiring a missing module: the stack is mostly `node:internal/...` frames.
      let moduleError: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('definitely-not-a-real-module-xyz');
      } catch (error) {
        moduleError = error;
      }

      const stack = stackOf(moduleError);

      // They land wholly in the URL position, which the backend must tolerate by skipping them.
      expect(stack).toContain('node:internal/');
      expect(stack).toMatch(/at\s<anonymous>\s@\s.*node:internal\//);
    });

    it('emits a header-only stack for an Error carrying no stack', () => {
      const error = new Error('no stack');
      error.stack = undefined;

      expect(stackOf(error)).toBe('Error: no stack');
    });

    it('emits no stack at all for a non-Error value', () => {
      expect(stackOf('just a string')).toBeUndefined();
    });

    describe('path normalization', () => {
      it('anchors frames under the app root on `app:///`', () => {
        // This spec file itself lives under the repository root, which stands in for the app root.
        stackPathNormalizer = new StackPathNormalizer(true, process.cwd());

        const stack = stackOf(new Error('normalized'));

        expect(stack).toMatch(/\sat\s.+\s@\sapp:\/\/\/src\/domain\/rum\/error\/ErrorCollection\.spec\.ts:\d+:\d+/);
        expect(stack).not.toContain(process.cwd());
      });

      it('keeps absolute paths when normalization is disabled', () => {
        stackPathNormalizer = new StackPathNormalizer(false, process.cwd());

        const stack = stackOf(new Error('raw'));

        expect(stack).not.toContain('app:///');
        expect(stack).toContain(`${process.cwd()}/src/domain/rum/error/ErrorCollection.spec.ts`);
      });
    });
  });
});
