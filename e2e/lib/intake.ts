import { createHash } from 'node:crypto';
import * as http from 'node:http';

/**
 * Fake FlashCat intake used to assert what the SDK sends.
 *
 * The SDK is configured (via `proxy`) to POST events here instead of the real intake. The
 * `ddforward` query parameter carries the intake path the SDK would have used without a proxy,
 * so asserting on it is equivalent to asserting on the real request path.
 *
 * Beyond storing events, this server validates the wire contract the FlashCat intake enforces.
 * The real intake answers a breach with `400`, which the SDK retries forever — so a test that
 * only looked at the parsed events could stay green while nothing was ever ingested. Breaches
 * are therefore recorded and asserted explicitly by `intake-contract.scenario.ts`:
 *
 * - path is `/api/v2/rum` (the only track FlashCat exposes — there is no `/api/v2/spans`)
 * - `Content-Type: text/plain;charset=UTF-8` (`application/json` is rejected)
 * - body is newline-delimited JSON, one event per line (a JSON array is rejected)
 * - every number is a whole number, except the few fields the intake really types as floats
 *
 * It also stands in for the remote configuration endpoint, `GET /api/v2/rum/config`, so remote
 * configuration is exercised without ever pointing the SDK at a real backend — a fake configuration
 * version reported to a real one would show up in the console's version statistics. What it answers
 * is set per test with {@link Intake.setRemoteConfig}; with nothing set it answers what the real
 * endpoint answers for an application with nothing published: 200, version 0, switched off.
 */
export interface ReceivedEvent {
  timestamp: number;
  body: unknown;
  headers: Record<string, string>;
}

/** A breach of the intake wire contract described above. */
export interface ProtocolViolation {
  timestamp: number;
  reason: string;
  detail: string;
}

const RUM_TRACK_PATH = '/api/v2/rum';
const CONFIG_PATH = '/api/v2/rum/config';

/** How the fake config endpoint answers. */
export type RemoteConfigBehaviour =
  /**
   * 200 with this body, and an `ETag` digested from it the way the real endpoint does — a request
   * that sends the tag back gets a 304.
   */
  | { body: Record<string, unknown> }
  /** This status, with an empty body. */
  | { status: number }
  /** The connection is dropped without an answer: what an offline client sees. */
  | { reset: true };

/** What the real endpoint answers for an application whose configuration was never published. */
const NOTHING_PUBLISHED: RemoteConfigBehaviour = {
  body: {
    schema_version: 1,
    version: 0,
    ttl: 600,
    enabled: false,
    activation: 'next_session',
    refresh_on_foreground: false,
    rum: {},
  },
};

/** A request the SDK made to the config endpoint, as the real endpoint would have read it. */
export interface ConfigRequest {
  timestamp: number;
  /** The query parameters inside `ddforward`, which is where the SDK puts them behind a proxy. */
  params: Record<string, string>;
  headers: Record<string, string>;
}
const EXPECTED_CONTENT_TYPE = 'text/plain';

/**
 * The event fields the intake decodes as integers, by JSON path, per event type: a fraction there
 * fails the whole event on the real intake, silently, since the `202` is sent before decoding. A
 * JavaScript mock parses such an event happily, so without this check the suite stays green while
 * nothing is ingested. Only these paths are looked at; free-form attributes are stored as they are.
 *
 * A mirror of `src/tools/intakeNumbers.ts` — the e2e project cannot import `src` — taken from the
 * integer-typed fields of the event structs in `fc-rum/types/datadog/rum.go`.
 */
const COMMON = ['_dd.format_version', '_dd.session.plan', 'date'];

const INTAKE_INTEGER_PATHS: Record<string, readonly string[]> = {
  action: [
    ...COMMON,
    '_dd.action.target.height',
    '_dd.action.target.width',
    'action.crash.count',
    'action.error.count',
    'action.loading_time',
    'action.long_task.count',
    'action.resource.count',
  ],
  error: [...COMMON, 'error.resource.status_code', 'error.time_since_app_start', 'freeze.duration'],
  long_task: [
    ...COMMON,
    'long_task.blocking_duration',
    'long_task.duration',
    'long_task.first_ui_event_timestamp',
    'long_task.scripts[].duration',
    'long_task.scripts[].forced_style_and_layout_duration',
    'long_task.scripts[].pause_duration',
    'long_task.scripts[].source_char_position',
    'long_task.scripts[].start_time',
    'long_task.start_time',
    'long_task.style_and_layout_start',
  ],
  resource: [
    ...COMMON,
    'resource.connect.duration',
    'resource.connect.start',
    'resource.decoded_body_size',
    'resource.dns.duration',
    'resource.dns.start',
    'resource.download.duration',
    'resource.download.start',
    'resource.duration',
    'resource.encoded_body_size',
    'resource.first_byte.duration',
    'resource.first_byte.start',
    'resource.redirect.duration',
    'resource.redirect.start',
    'resource.size',
    'resource.ssl.duration',
    'resource.ssl.start',
    'resource.status_code',
    'resource.transfer_size',
    'resource.worker.duration',
    'resource.worker.start',
  ],
  view: [
    ...COMMON,
    '_dd.document_version',
    '_dd.page_states[].start',
    '_dd.replay_stats.records_count',
    '_dd.replay_stats.segments_count',
    '_dd.replay_stats.segments_total_raw_size',
    'display.scroll.max_scroll_height_time',
    'view.action.count',
    'view.app_launch',
    'view.crash.count',
    'view.cumulative_layout_shift_time',
    'view.dom_complete',
    'view.dom_content_loaded',
    'view.dom_interactive',
    'view.error.count',
    'view.evaluate_script',
    'view.first_byte',
    'view.first_contentful_paint',
    'view.first_input_delay',
    'view.first_input_time',
    'view.first_render',
    'view.frozen_frame.count',
    'view.frustration.count',
    'view.in_foreground_periods[].duration',
    'view.in_foreground_periods[].start',
    'view.interaction_to_next_paint',
    'view.interaction_to_next_paint_time',
    'view.interaction_to_next_view_time',
    'view.largest_contentful_paint',
    'view.load_event',
    'view.loading_time',
    'view.long_task.count',
    'view.network_settled_time',
    'view.onload_to_onshow',
    'view.onshow_to_onready',
    'view.performance.cls.timestamp',
    'view.performance.fcp.timestamp',
    'view.performance.fid.duration',
    'view.performance.fid.timestamp',
    'view.performance.inp.duration',
    'view.performance.inp.timestamp',
    'view.performance.lcp.timestamp',
    'view.resource.count',
    'view.setdata.count',
    'view.setdata.duration',
    'view.slow_frame.count',
    'view.time_spent',
  ],
  vital: [...COMMON, 'vital.duration'],
};

const byType = (type: string) => (event: ReceivedEvent) => (event.body as { type?: string }).type === type;

export class Intake {
  private server: http.Server | null = null;
  private rumEvents: ReceivedEvent[] = [];
  private violations: ProtocolViolation[] = [];
  private configRequests: ConfigRequest[] = [];
  private remoteConfig: RemoteConfigBehaviour | undefined;
  private port = 0;

  private addViolation(reason: string, detail: string) {
    this.violations.push({ timestamp: Date.now(), reason, detail });
  }

  /**
   * Parses a newline-delimited JSON payload and stores one event per line.
   * Records a violation for anything the real intake would reject.
   */
  private storeBody(rawBody: string, headers: Record<string, string>) {
    const lines = rawBody.split('\n').filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      this.addViolation('empty body', 'received a POST with no payload');
      return;
    }

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.addViolation('body is not newline-delimited JSON', truncate(line));
        continue;
      }

      if (Array.isArray(parsed)) {
        this.addViolation('body is a JSON array instead of newline-delimited JSON', truncate(line));
        continue;
      }

      for (const path of findFractionalFields(parsed)) {
        this.addViolation('fractional number in an integer field', `${eventLabel(parsed)} → ${path}`);
      }

      this.rumEvents.push({ timestamp: Date.now(), body: parsed, headers });
    }
  }

  private checkRequest(req: http.IncomingMessage, headers: Record<string, string>) {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    // Without a `proxy`, the SDK POSTs straight to `https://${site}${ddforward}`, so `ddforward`
    // is the path the real intake would have seen.
    const track = requestUrl.searchParams.get('ddforward') ?? requestUrl.pathname;

    if (track !== RUM_TRACK_PATH) {
      this.addViolation('unexpected intake path', track);
    }

    const contentType = headers['content-type'] ?? '';
    if (!contentType.startsWith(EXPECTED_CONTENT_TYPE)) {
      this.addViolation('unexpected content-type', contentType || '(none)');
    }
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'GET' && this.isConfigRequest(req)) {
          this.answerConfigRequest(req, res);
          return;
        }
        if (req.method !== 'POST') {
          this.addViolation('unexpected method', `${req.method ?? '?'} ${req.url ?? '/'}`);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        let body = '';

        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          const headers = lowerCaseHeaders(req);

          this.checkRequest(req, headers);
          this.storeBody(body, headers);

          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted' }));
        });
      });

      this.server.listen(port, () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((error) => {
          if (error) {
            reject(error);
          } else {
            this.server = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  async getEventsByType(
    type: string,
    options?: { timeout?: number; predicate?: (event: ReceivedEvent) => boolean }
  ): Promise<ReceivedEvent[]> {
    // return as soon as we have one event
    return this.waitForEventCount(type, 1, options);
  }

  async waitForEventCount(
    type: string,
    count: number,
    options?: { timeout?: number; predicate?: (event: ReceivedEvent) => boolean }
  ): Promise<ReceivedEvent[]> {
    const timeout = options?.timeout ?? 10000;
    const byPredicate = options?.predicate ?? (() => true);
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeout) {
      const matchingEvents = this.rumEvents.filter(byType(type)).filter(byPredicate);
      if (matchingEvents.length >= count) {
        return matchingEvents;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    const received = this.rumEvents.filter(byType(type)).filter(byPredicate);
    throw new Error(
      `Timed out waiting for ${count} "${type}" event(s) after ${timeout}ms. Received ${received.length}.` +
        formatViolations(this.violations)
    );
  }

  async assertNoNewEvents(type: string, duration = 500): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < duration) {
      const matchingEvents = this.rumEvents.filter(byType(type));
      if (matchingEvents.length > 0) {
        throw new Error(`Expected no "${type}" events but received ${matchingEvents.length} within ${duration}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /** Sets what the config endpoint answers from now on; `undefined` for an application with nothing published. */
  setRemoteConfig(behaviour: RemoteConfigBehaviour | undefined): void {
    this.remoteConfig = behaviour;
  }

  /** Every request made to the config endpoint so far, in arrival order. */
  getConfigRequests(): ConfigRequest[] {
    return [...this.configRequests];
  }

  async waitForConfigRequests(count: number, timeout = 10000): Promise<ConfigRequest[]> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (this.configRequests.length >= count) {
        return this.getConfigRequests();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${count} config request(s). Received ${this.configRequests.length}.`);
  }

  private isConfigRequest(req: http.IncomingMessage): boolean {
    return forwardedUrl(req).pathname === CONFIG_PATH;
  }

  private answerConfigRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const headers = lowerCaseHeaders(req);
    this.configRequests.push({
      timestamp: Date.now(),
      params: Object.fromEntries(forwardedUrl(req).searchParams),
      headers,
    });

    const behaviour = this.remoteConfig ?? NOTHING_PUBLISHED;
    if ('reset' in behaviour) {
      req.socket.destroy();
    } else if ('status' in behaviour) {
      res.writeHead(behaviour.status);
      res.end();
    } else {
      const body = JSON.stringify(behaviour.body);
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
      if (headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag });
      res.end(body);
    }
  }

  /** Every request that breached the intake wire contract, in arrival order. */
  getProtocolViolations(): ProtocolViolation[] {
    return [...this.violations];
  }

  /** All events received so far, whatever their type. */
  getAllEvents(): ReceivedEvent[] {
    return [...this.rumEvents];
  }

  clear(): void {
    this.rumEvents = [];
    this.violations = [];
    this.configRequests = [];
  }

  getPort(): number {
    return this.port;
  }
}

function lowerCaseHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value.join(', ');
    }
  }
  return headers;
}

/** The URL the real intake would have seen: the one inside `ddforward`, or the request's own. */
function forwardedUrl(req: http.IncomingMessage): URL {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  const forward = requestUrl.searchParams.get('ddforward');
  return forward === null ? requestUrl : new URL(forward, 'http://localhost');
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Dotted paths of every number the intake would fail to decode into an integer. */
function findFractionalFields(event: unknown): string[] {
  const type = (event as { type?: unknown } | undefined)?.type;
  const found: string[] = [];
  for (const path of INTAKE_INTEGER_PATHS[typeof type === 'string' ? type : ''] ?? []) {
    findFractionAt(event, path.split('.'), '', found);
  }
  return found;
}

function findFractionAt(value: unknown, segments: readonly string[], at: string, found: string[]): void {
  if (segments.length === 0) {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      found.push(`${at} = ${value}`);
    }
    return;
  }
  const [segment, ...rest] = segments;
  const key = segment.endsWith('[]') ? segment.slice(0, -2) : segment;
  const child = (value as Record<string, unknown> | null | undefined)?.[key];
  const childPath = at === '' ? key : `${at}.${key}`;
  if (!segment.endsWith('[]')) {
    findFractionAt(child, rest, childPath, found);
  } else if (Array.isArray(child)) {
    child.forEach((item, index) => findFractionAt(item, rest, `${childPath}[${index}]`, found));
  }
}

function eventLabel(event: unknown): string {
  const { type, source } = (event ?? {}) as { type?: string; source?: string };
  return `${source ?? 'unknown'}/${type ?? 'unknown'}`;
}

function formatViolations(violations: ProtocolViolation[]): string {
  if (violations.length === 0) {
    return '';
  }
  const lines = violations.map((v) => `  - ${v.reason}: ${v.detail}`).join('\n');
  return `\nIntake protocol violations were recorded — events may have been rejected:\n${lines}`;
}
