import { describe, it, expect } from 'vitest';
import { disableTracerTelemetryByDefault } from './tracerTelemetry';

describe('disableTracerTelemetryByDefault', () => {
  it('disables dd-trace instrumentation telemetry when the host application did not choose', () => {
    const env: NodeJS.ProcessEnv = {};

    disableTracerTelemetryByDefault(env);

    expect(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED).toBe('false');
  });

  it.each([
    { variable: 'DD_INSTRUMENTATION_TELEMETRY_ENABLED' as const },
    { variable: 'DD_TRACE_TELEMETRY_ENABLED' as const },
  ])('preserves an explicit opt-in through $variable', ({ variable }) => {
    const env: NodeJS.ProcessEnv = { [variable]: 'true' };

    disableTracerTelemetryByDefault(env);

    expect(env[variable]).toBe('true');
    // The opt-in must not be overridden by writing the other variable either.
    expect(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED).not.toBe('false');
  });

  it('leaves an explicit opt-out untouched', () => {
    const env: NodeJS.ProcessEnv = { DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false' };

    disableTracerTelemetryByDefault(env);

    expect(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED).toBe('false');
  });

  it('defaults to the real process environment', () => {
    // Guards the default parameter: calling with no argument must not throw.
    expect(() => disableTracerTelemetryByDefault({ DD_TRACE_TELEMETRY_ENABLED: 'true' })).not.toThrow();
    expect(() => disableTracerTelemetryByDefault()).not.toThrow();
  });
});
