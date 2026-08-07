import { createRequire } from 'node:module';
import type { Configuration } from '../../config';
import { computeIntakeOrigin } from '../../transport';
import { addError } from '../telemetry';
import { patchIpcHandleContext, patchFetchContext } from './tracingPatches';

// Support both CJS (__filename) and ESM (import.meta.url) contexts
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

interface ExporterWithFlush {
  flush(done: () => void): void;
}

interface TracerInternals {
  _tracer?: { _exporter?: unknown };
}

/** A dd-trace `blocklist`: outbound requests whose URI it matches never get a span. */
type UriFilter = (uri: string) => boolean;

export class Tracing {
  enabled = false;
  private exporter: ExporterWithFlush | undefined;

  constructor(config: Configuration) {
    try {
      const tracer = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;

      // dd-trace is initialized early via @flashcatcloud/electron-sdk/instrument (before require('electron')).
      // tracer.init() is a no-op if already initialized, so we only configure plugins here.
      // Service/env/version are set by SpanProcessor on each span payload,
      // overriding dd-trace's defaults with the SDK config values.
      const blocklist = createIntakeBlocklist(config);
      // @ts-expect-error electron plugin exists in dd-trace but is not in the type definitions
      tracer.use('electron', { blocklist });
      tracer.use('http', { client: { blocklist } });
      tracer.use('fetch', { blocklist });

      patchIpcHandleContext(tracer);
      patchFetchContext(tracer);

      // TODO(RUM-16445) discuss a more reliable way to flush the exporter
      const internalExporter = (tracer as unknown as TracerInternals)._tracer?._exporter;
      if (internalExporter && typeof (internalExporter as ExporterWithFlush).flush === 'function') {
        this.exporter = internalExporter as ExporterWithFlush;
      }

      this.enabled = true;
    } catch (error) {
      addError(error);
    }
  }

  // dd-trace's electron exporter batches spans on a flushInterval (2s by default).
  // Flushing it before the SDK transport ensures any pending HTTP spans become RUM resource events synchronously,
  // so _flushTransport() captures them in one shot.
  async flush(): Promise<void> {
    if (!this.exporter) {
      return;
    }
    await new Promise<void>((resolve) => this.exporter!.flush(resolve));
  }
}

/**
 * Keeps the SDK's own uploads out of the data it collects, by never instrumenting them.
 *
 * Every path that produces an outbound HTTP span — `node:http`/`https`, global `fetch`, and
 * Electron's `net.request` — is served by a dd-trace plugin deriving from `HttpClientPlugin`, which
 * runs its `blocklist` before the span is recorded. A blocked request produces no span at all, so
 * it cannot reach the exporter, become a RUM resource event, and generate the upload that would
 * feed the next one. This mirrors how the iOS, Android and HarmonyOS SDKs stay out of their own
 * data: their uploader is simply not part of what gets instrumented.
 *
 * The URI dd-trace matches against carries the port (`protocol//host[:port]path`), so comparing
 * origins is what makes this correct for a self-hosted intake sharing a host with the application's
 * own services.
 *
 * Returns `undefined` — meaning "block nothing" — when the configuration yields no parsable intake
 * origin. `SpanProcessor` still filters at export time as a second line of defense.
 */
export function createIntakeBlocklist(config: Configuration): UriFilter | undefined {
  const intakeOrigin = computeIntakeOrigin(config.site, config.proxy);
  if (intakeOrigin === undefined) {
    return undefined;
  }

  return (uri: string) => {
    try {
      return new URL(uri).origin === intakeOrigin;
    } catch {
      return false;
    }
  };
}
