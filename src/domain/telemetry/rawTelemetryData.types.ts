import { TelemetryDebugEvent, TelemetryErrorEvent } from './telemetryEvent.types';
import { RecursivePartial } from '../../tools/coreCompat';

export type RawTelemetryData = RawTelemetryError | RawTelemetryDebug;

export interface RawTelemetryError extends RecursivePartial<TelemetryErrorEvent> {
  type: 'telemetry';
  telemetry: {
    type: 'log';
    status: 'error';
    message: string;
    error?: { stack?: string; kind?: string };
  };
}

export interface RawTelemetryDebug extends RecursivePartial<TelemetryDebugEvent> {
  type: 'telemetry';
  telemetry: {
    type: 'log';
    status: 'debug';
    message: string;
    [k: string]: unknown;
  };
}
