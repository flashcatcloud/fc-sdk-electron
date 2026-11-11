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

/**
 * dd-trace also ships a native crash tracker, on by default (`DD_CRASHTRACKING_ENABLED`). The SDK
 * reports native crashes itself, from Crashpad's minidumps, so the tracker adds nothing — and it does
 * harm in a desktop application:
 *
 * - It installs signal handlers that catch the fault and re-raise it from their own frame. The dump is
 *   written at the re-raise, so the crashed thread's first non-system frame is the tracker, not the
 *   faulting code, and every main-process crash of one exception type gets the same fingerprint.
 * - At the crash it sends its own report to a local Datadog agent on `127.0.0.1:8126`, whether or
 *   not instrumentation telemetry is enabled.
 *
 * Like telemetry, it can only be set through the environment, and is read when dd-trace builds its
 * config, so this must run before dd-trace is required. An explicit choice by the host application
 * is preserved.
 */
export function disableTracerCrashtrackingByDefault(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DD_CRASHTRACKING_ENABLED === undefined) {
    env.DD_CRASHTRACKING_ENABLED = 'false';
  }
}
