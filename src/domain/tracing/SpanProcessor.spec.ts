import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { DISCARDED, SKIPPED } from '@flashcatcloud/browser-core';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import type { Event, RawRumEvent, ServerSpansEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import type { Configuration } from '../../config';
import { ExportedSpan, SpanProcessor } from './SpanProcessor';

// SpanProcessor reaches `electron` transitively through the `../../transport` and
// `../rum` barrels. Requiring the real module executes `node_modules/electron/index.js`,
// which throws unless the Electron binary was downloaded at install time. Mocking keeps
// this suite hermetic so it runs without the binary (as in CI).
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    getVersion: vi.fn(() => '1.0.0'),
    getName: vi.fn(() => 'test-app'),
    on: vi.fn(),
    once: vi.fn(),
  },
  crashReporter: { start: vi.fn(), addExtraParameter: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

vi.mock('../telemetry', () => ({
  monitor:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      try {
        return fn(...args);
      } catch {
        return undefined;
      }
    },
}));

const DD_TRACE_SPAN_CHANNEL = 'datadog:apm:electron:export';

function createSpan(overrides: Partial<ExportedSpan> = {}) {
  return {
    trace_id: BigInt(123),
    span_id: BigInt(456),
    parent_id: BigInt(0),
    name: 'http.request',
    service: 'test-service',
    resource: 'GET /api/data',
    type: 'http',
    error: 0,
    meta: {
      'http.url': 'https://example.com/api/data',
      'http.method': 'GET',
      'http.status_code': '200',
    },
    metrics: {},
    start: 1_000_000_000, // 1000ms in nanoseconds
    duration: 50_000_000, // 50ms in nanoseconds
    ...overrides,
  };
}

describe('SpanProcessor', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let processor: SpanProcessor;
  let collected: Event[];

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    hooks = createFormatHooks();
    collected = [];

    eventManager.registerHandler({
      canHandle: (_event): _event is Event => true,
      handle: (event) => collected.push(event),
    });

    processor = new SpanProcessor(eventManager, hooks, {
      env: 'test',
      service: 'test-service',
      site: 'browser.flashcat.cloud',
    } as Configuration);
  });

  afterEach(() => {
    processor.stop();
  });

  function publish(traces: unknown[][]) {
    DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL).publish(traces);
  }

  describe('HTTP spans', () => {
    it('should emit both a span envelope and a RUM resource for HTTP spans', () => {
      const span = createSpan();
      publish([[span]]);

      const rawEvents = collected.filter((e) => e.kind === EventKind.RAW) as RawRumEvent[];
      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER) as ServerSpansEvent[];

      expect(rawEvents).toHaveLength(1);
      expect(rawEvents[0].format).toBe(EventFormat.RUM);
      expect(rawEvents[0].source).toBe(EventSource.MAIN);
      expect((rawEvents[0].data as { type: string }).type).toBe('resource');

      expect(serverEvents).toHaveLength(1);
      expect(serverEvents[0].track).toBe(EventTrack.SPANS);
    });

    /**
     * Guard, not an observation. dd-trace derives span starts from `performance.now()` and reports
     * them in nanoseconds, so the count is essentially never a whole number of milliseconds. The
     * intake decodes `date` into an int64 and Go drops the whole event on a fraction — silently,
     * because the `202` is sent before decoding. Note that `createSpan()`'s round
     * `1_000_000_000` is precisely what hid this: the division is exact there and never in
     * production, so every other case in this file would stay green with the bug present.
     *
     * A realistic epoch-nanosecond value cannot be written as a literal here — it is past
     * `Number.MAX_SAFE_INTEGER`, which is part of why these values are awkward. A small exact one
     * carrying the same sub-millisecond remainder proves the same thing.
     */
    it('should emit a whole-millisecond date, since span starts do not divide evenly', () => {
      const span = createSpan({ start: 1_000_700_000 as ExportedSpan['start'] });
      publish([[span]]);

      const rawEvent = collected.find((e) => e.kind === EventKind.RAW) as RawRumEvent;
      const resource = rawEvent.data as { date: number };
      expect(Number.isInteger(resource.date)).toBe(true);
      expect(resource.date).toBe(1001); // 1000.7ms
      expect(Number.isInteger(rawEvent.startTime)).toBe(true);
    });

    it('should convert trace/span IDs to decimal in RUM resources', () => {
      const span = createSpan({ trace_id: BigInt(255), span_id: BigInt(16) });
      publish([[span]]);

      const rawEvent = collected.find((e) => e.kind === EventKind.RAW) as RawRumEvent;
      const resource = rawEvent.data as { _dd: { trace_id: string; span_id: string } };
      expect(resource._dd.trace_id).toBe('255');
      expect(resource._dd.span_id).toBe('16');
    });

    it('should convert trace/span IDs to hex in span envelopes', () => {
      const span = createSpan({ trace_id: BigInt(255), span_id: BigInt(16) });
      publish([[span]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { trace_id: string; span_id: string }[] };
      expect(payload.spans[0].trace_id).toBe('ff');
      expect(payload.spans[0].span_id).toBe('10');
    });

    it('should map HTTP method and status code to the RUM resource', () => {
      const span = createSpan({
        meta: { 'http.url': 'https://example.com', 'http.method': 'POST', 'http.status_code': '201' },
      });
      publish([[span]]);

      const rawEvent = collected.find((e) => e.kind === EventKind.RAW) as RawRumEvent;
      const resource = rawEvent.data as { resource: { method: string; status_code: number } };
      expect(resource.resource.method).toBe('POST');
      expect(resource.resource.status_code).toBe(201);
    });

    it('should default method to GET and status_code to 0 when missing', () => {
      const span = createSpan({ meta: { 'http.url': 'https://example.com' } });
      publish([[span]]);

      const rawEvent = collected.find((e) => e.kind === EventKind.RAW) as RawRumEvent;
      const resource = rawEvent.data as { resource: { method: string; status_code: number } };
      expect(resource.resource.method).toBe('GET');
      expect(resource.resource.status_code).toBe(0);
    });
  });

  describe('non-HTTP spans', () => {
    it('should emit only a span envelope, not a RUM resource', () => {
      const span = createSpan({ type: 'system', meta: {} });
      publish([[span]]);

      const rawEvents = collected.filter((e) => e.kind === EventKind.RAW);
      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER);

      expect(rawEvents).toHaveLength(0);
      expect(serverEvents).toHaveLength(1);
    });
  });

  /**
   * This is the second line of defense: `Tracing` blocklists the intake origin so these spans are
   * normally never created. It still has to be right, and for the same reason — it compares the
   * request's origin, port included, not just its host.
   */
  describe('SDK request filtering', () => {
    function useConfig(overrides: Partial<Configuration>) {
      processor.stop();
      processor = new SpanProcessor(eventManager, hooks, {
        env: 'test',
        service: 'test-service',
        site: 'browser.flashcat.cloud',
        ...overrides,
      } as Configuration);
    }

    function publishRequest(url: string) {
      publish([[createSpan({ meta: { 'http.url': url, 'http.method': 'POST' } })]]);
    }

    it('should filter out requests to the intake host', () => {
      publishRequest('https://browser.flashcat.cloud/api/v2/rum');

      expect(collected).toHaveLength(0);
    });

    it('should filter out requests to the configured staging intake host', () => {
      useConfig({ site: 'jira.flashcat.cloud' });
      publishRequest('https://jira.flashcat.cloud/api/v2/rum');

      expect(collected).toHaveLength(0);
    });

    it('should filter out requests to the configured proxy', () => {
      useConfig({ proxy: 'http://localhost:9999/api/v2/rum' });
      publishRequest('http://localhost:9999/api/v2/rum');

      expect(collected).toHaveLength(0);
    });

    it('should not filter localhost requests when no proxy is configured', () => {
      publishRequest('http://localhost:3000/api/data');

      expect(collected.length).toBeGreaterThan(0);
    });

    it('should not filter external HTTP requests', () => {
      publishRequest('https://api.example.com/data');

      expect(collected.length).toBeGreaterThan(0);
    });

    /**
     * Guard. Matching on the hostname alone made every application request sharing a host with the
     * proxy disappear — the normal shape of a self-hosted deployment, where the intake and the
     * application's own services differ only by port.
     */
    it('should keep application requests that share the proxy host but not its port', () => {
      useConfig({ proxy: 'http://127.0.0.1:8790/api/v2/rum' });
      publishRequest('http://127.0.0.1:9001/api/orders');

      expect(collected.length).toBeGreaterThan(0);
    });

    /**
     * Guard, the same bug seen from the other side. A `site` carrying a port never equalled the
     * hostname of an intake URL, so the filter silently matched nothing and the SDK reported its
     * own uploads as resources — which produced more uploads.
     */
    it('should filter out requests to an intake host that carries a port', () => {
      useConfig({ site: '10.0.0.5:8790' });
      publishRequest('https://10.0.0.5:8790/api/v2/rum');

      expect(collected).toHaveLength(0);
    });

    it('should keep application requests on the site host but another port', () => {
      useConfig({ site: '10.0.0.5:8790' });
      publishRequest('https://10.0.0.5:9001/api/orders');

      expect(collected.length).toBeGreaterThan(0);
    });

    /**
     * dd-trace sets a client span's `resource` to the HTTP method, so it never carries a host.
     * The previous substring match on it could therefore only ever produce false positives.
     */
    it('should not filter a span on its resource name', () => {
      publish([[createSpan({ type: 'dns', resource: 'browser.flashcat.cloud', meta: {} })]]);

      expect(collected.length).toBeGreaterThan(0);
    });

    it('should filter nothing when the configuration yields no intake origin', () => {
      useConfig({ proxy: 'not a url' });
      publishRequest('https://browser.flashcat.cloud/api/v2/rum');

      expect(collected.length).toBeGreaterThan(0);
    });
  });

  describe('span envelope', () => {
    it('should include the env in the envelope', () => {
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { env: string };
      expect(payload.env).toBe('test');
    });

    it('should override the span service with the configured service', () => {
      const span = createSpan({ service: 'dd-trace-default' });
      publish([[span]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { service: string }[] };
      expect(payload.spans[0].service).toBe('test-service');
    });

    it('should group multiple spans in a single trace envelope', () => {
      const span1 = createSpan({ name: 'span1' });
      const span2 = createSpan({ name: 'span2', type: 'system', meta: {} });
      publish([[span1, span2]]);

      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER) as ServerSpansEvent[];
      expect(serverEvents).toHaveLength(1);
      const payload = serverEvents[0].data as { spans: { name: string }[] };
      expect(payload.spans).toHaveLength(2);
    });

    it('should not emit an envelope when all spans in a trace are filtered', () => {
      const span = createSpan({
        meta: { 'http.url': 'https://browser.flashcat.cloud/api/v2/rum', 'http.method': 'POST' },
      });
      publish([[span]]);

      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER);
      expect(serverEvents).toHaveLength(0);
    });
  });

  describe('context enrichment', () => {
    it('should enrich span meta with hook results', () => {
      hooks.registerSpan(() => ({ meta: { '_dd.application.id': 'app-123', '_dd.session.id': 'sess-456' } }));
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { meta: Record<string, string> }[] };
      expect(payload.spans[0].meta['_dd.application.id']).toBe('app-123');
      expect(payload.spans[0].meta['_dd.session.id']).toBe('sess-456');
    });

    it('should not emit server spans event when hooks return DISCARDED', () => {
      hooks.registerSpan(() => DISCARDED);
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      expect(serverEvent).toBeUndefined();
    });

    it('should not enrich when hooks return SKIPPED', () => {
      hooks.registerSpan(() => SKIPPED);
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { meta: Record<string, string> }[] };
      expect(payload.spans[0].meta['_dd.application.id']).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('should unsubscribe from the diagnostics channel', () => {
      processor.stop();
      publish([[createSpan()]]);

      expect(collected).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should not throw on malformed messages (errors caught by monitor)', () => {
      // Publish a malformed message — monitor() swallows the error
      expect(() => {
        DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL).publish('not an array');
      }).not.toThrow();
    });
  });
});
