import type { TimeStamp } from '@flashcatcloud/browser-core';

/**
 * Round a millisecond value to the whole millisecond the intake can decode.
 *
 * Every timestamp and duration on an event is an `int64` on the intake side, and Go's JSON decoder
 * refuses a fractional number into an integer — it fails the **whole event**. Nothing surfaces on
 * this side either: the intake answers `202` before it decodes, so a dropped event is
 * indistinguishable from an accepted one.
 *
 * JavaScript draws no such line, which is what makes this worth a named helper rather than a bare
 * `Math.round` at each site: any millisecond value that did not come from `Date.now()` is suspect.
 * Two sources have already been caught shipping fractions — `fs.Stats.birthtimeMs`, which carries
 * sub-millisecond precision, and dd-trace span starts, which are nanosecond counts that do not
 * divide evenly. Route new ones through here.
 */
export function toIntakeTimeStamp(milliseconds: number): TimeStamp {
  return Math.round(milliseconds) as TimeStamp;
}
