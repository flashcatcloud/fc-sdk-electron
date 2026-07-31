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
const EXPECTED_CONTENT_TYPE = 'text/plain';

const byType = (type: string) => (event: ReceivedEvent) => (event.body as { type?: string }).type === type;

export class Intake {
  private server: http.Server | null = null;
  private rumEvents: ReceivedEvent[] = [];
  private violations: ProtocolViolation[] = [];
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
          const headers: Record<string, string> = {};

          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
              headers[key.toLowerCase()] = value;
            } else if (Array.isArray(value)) {
              headers[key.toLowerCase()] = value.join(', ');
            }
          }

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
  }

  getPort(): number {
    return this.port;
  }
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatViolations(violations: ProtocolViolation[]): string {
  if (violations.length === 0) {
    return '';
  }
  const lines = violations.map((v) => `  - ${v.reason}: ${v.detail}`).join('\n');
  return `\nIntake protocol violations were recorded — events may have been rejected:\n${lines}`;
}
