/**
 * The event fields the intake decodes as floating point. Every other number on an event is an
 * `int64` there, and Go's decoder refuses a fraction into an integer — it fails the whole event,
 * silently, since the intake answers `202` before it decodes. See `toIntakeTimeStamp` for the
 * timestamps the SDK rounds itself; this is for numbers the SDK did not produce.
 *
 * Taken from `fc-rum/types/datadog/rum.go` — `grep 'float64 \`json:'`. The e2e intake keeps the
 * same list to flag what a real intake would drop.
 */
const FRACTIONAL_FIELDS = new Set([
  'average',
  'cpu_ticks_count',
  'cpu_ticks_per_second',
  'cumulative_layout_shift',
  'custom',
  'execution_start',
  'freeze_rate',
  'height',
  'max',
  'max_depth',
  'max_depth_scroll_top',
  'max_scroll_height',
  'memory_average',
  'memory_max',
  'metric_max',
  'min',
  'refresh_rate_average',
  'refresh_rate_min',
  'render_start',
  'rule_psr',
  'score',
  'session_replay_sample_rate',
  'session_sample_rate',
  'slow_frames_rate',
  'width',
  'x',
  'y',
]);

/** Whether `value` holds a fraction somewhere the intake decodes an integer, which would drop the event. */
export function hasFractionWhereIntakeDecodesInteger(value: unknown, field = ''): boolean {
  if (typeof value === 'number') {
    return !Number.isInteger(value) && !FRACTIONAL_FIELDS.has(field);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasFractionWhereIntakeDecodesInteger(item, field));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => hasFractionWhereIntakeDecodesInteger(item, key));
  }
  return false;
}
