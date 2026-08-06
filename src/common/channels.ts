export const BRIDGE_CHANNEL = 'datadog:bridge-send';
export const CONFIG_CHANNEL = 'datadog:bridge-config';
/**
 * Main process → renderer pushes of the identifiers that change while the app runs. The preload
 * caches them so the bridge can answer synchronously, instead of paying a synchronous IPC round
 * trip on every event.
 */
export const IDENTITY_CHANNEL = 'datadog:bridge-identity';
