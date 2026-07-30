/**
 * dd-trace ships its own "instrumentation telemetry", which is unrelated to FlashCat RUM.
 * It reports to a local Datadog agent on `127.0.0.1:8126` and, when the agent request fails
 * and `DD_API_KEY` happens to be present in the environment, falls back to sending directly
 * to Datadog (see `dd-trace/packages/dd-trace/src/telemetry/send-data.js`). Neither is wanted
 * in a customer's desktop application, so it is turned off by default.
 *
 * This has to go through the environment: dd-trace 5.x resolves the setting exclusively from
 * `DD_INSTRUMENTATION_TELEMETRY_ENABLED` (alias `DD_TRACE_TELEMETRY_ENABLED`), and silently
 * ignores `telemetry: false` / `telemetry: { enabled: false }` passed to `tracer.init()`.
 * The value is read when dd-trace builds its config, so this must run before dd-trace is
 * required.
 *
 * An explicit choice by the host application — through either supported variable, and
 * including an explicit opt-in to telemetry — is always preserved.
 */
export function disableTracerTelemetryByDefault(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DD_INSTRUMENTATION_TELEMETRY_ENABLED === undefined && env.DD_TRACE_TELEMETRY_ENABLED === undefined) {
    env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false';
  }
}
