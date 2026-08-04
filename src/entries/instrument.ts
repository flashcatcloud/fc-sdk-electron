/**
 * Instrumentation entry point — must be imported before 'electron'.
 *
 * Usage:
 *   import '@flashcatcloud/electron-sdk/instrument';
 *   import { app, BrowserWindow } from 'electron';
 *
 * Initializes dd-trace with the electron exporter so it can hook require('electron') and
 * instrument the `net` module and IPC, then installs the SDK's own bridge preload into every
 * renderer session.
 *
 * Note: Bundlers may break the import order dd-trace needs. Use the bundler
 * plugins provided by the SDK to ensure correct behavior:
 * - Vite: datadogVitePlugin from '@flashcatcloud/electron-sdk/vite-plugin'
 * - Webpack: DatadogWebpackPlugin from '@flashcatcloud/electron-sdk/webpack-plugin'
 */
import { createRequire } from 'node:module';
import { disableTracerTelemetryByDefault } from '../domain/tracing/tracerTelemetry';
import { installBridgePreload } from '../preload/preloadInjection';

// Support both CJS (__filename) and ESM (import.meta.url) contexts
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

// Must run before dd-trace is required — see the function's documentation.
disableTracerTelemetryByDefault();

try {
  const tracer = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;

  tracer.init({
    // TODO: remove cast when dd-trace releases a fix
    experimental: { exporter: 'electron' as 'datadog' },
  });
} catch {
  console.warn('[datadog] dd-trace not found — monitoring will not work');
}

// `electron` is loaded here, after dd-trace, so dd-trace's hooks are in place first. It is kept out
// of this module's static imports for the same reason: bundlers hoist those above everything else.
try {
  installBridgePreload(_require('electron') as typeof import('electron'));
} catch {
  console.warn('[datadog] electron not found — renderer monitoring will not work');
}
