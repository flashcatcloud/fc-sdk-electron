/**
 * The event fields the intake decodes as integers, by JSON path, per event type. Go's decoder
 * refuses a fraction into an integer and fails the whole event — silently, since the intake
 * answers `202` before it decodes. See `toIntakeTimeStamp` for the timestamps the SDK rounds
 * itself; this is for numbers the SDK did not produce.
 *
 * Only these paths are looked at. Everything else — `context`, `usr`, `feature_flags`, custom
 * attributes — the intake stores as it is, fractions included, and is never inspected here.
 *
 * Taken from the integer-typed fields of the event structs in `fc-rum/types/datadog/rum.go`,
 * walked by type; `[]` stands for each element of an array. The e2e intake keeps the same table
 * to flag what a real intake would drop.
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

/**
 * The path of the first fraction found where the intake decodes an integer, or `undefined` when
 * there is none. An event of an unknown type has no such paths.
 */
export function findFractionAtIntakeIntegerPath(event: unknown): string | undefined {
  const type = (event as { type?: unknown } | undefined)?.type;
  for (const path of INTAKE_INTEGER_PATHS[typeof type === 'string' ? type : ''] ?? []) {
    const found = findFractionAt(event, path.split('.'), '');
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function findFractionAt(value: unknown, segments: readonly string[], at: string): string | undefined {
  if (segments.length === 0) {
    return typeof value === 'number' && !Number.isInteger(value) ? at : undefined;
  }
  const [segment, ...rest] = segments;
  const key = segment.endsWith('[]') ? segment.slice(0, -2) : segment;
  const child = (value as Record<string, unknown> | null | undefined)?.[key];
  const childPath = at === '' ? key : `${at}.${key}`;
  if (!segment.endsWith('[]')) {
    return findFractionAt(child, rest, childPath);
  }
  if (!Array.isArray(child)) {
    return undefined;
  }
  for (const [index, item] of child.entries()) {
    const found = findFractionAt(item, rest, `${childPath}[${index}]`);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Whether `value` holds, anywhere, a property named like a prototype's. Such a key is not data:
 * merged into an object, `__proto__` reaches that object's prototype — `Object.prototype`, for
 * every object of the process. A payload carrying one is dropped whole.
 */
export function hasPrototypeKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasPrototypeKey);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.keys(value).some(
    (key) => PROTOTYPE_KEYS.has(key) || hasPrototypeKey((value as Record<string, unknown>)[key])
  );
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
