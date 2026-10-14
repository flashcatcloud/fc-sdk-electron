import { describe, expect, it } from 'vitest';
import { findInvalidIntakeInteger } from './intakeNumbers';

describe('findInvalidIntakeInteger', () => {
  it('leaves free-form subtrees alone: the intake stores them as they are', () => {
    const event = {
      type: 'error',
      date: 1,
      context: { price: 19.99, nested: { ratio: 0.5 }, status_code: '500' },
      usr: { score: 0.25 },
      feature_flags: { rollout: 0.1 },
      error: { message: 'x', resource: { status_code: 500 } },
    };

    expect(findInvalidIntakeInteger(event)).toBeUndefined();
  });

  it('names a fraction where the intake decodes an integer', () => {
    expect(findInvalidIntakeInteger({ type: 'error', date: 1.5 })).toBe('date');
    expect(findInvalidIntakeInteger({ type: 'view', date: 1, view: { time_spent: 1.5 } })).toBe('view.time_spent');
    expect(findInvalidIntakeInteger({ type: 'resource', date: 1, resource: { duration: 2.5 } })).toBe(
      'resource.duration'
    );
    expect(findInvalidIntakeInteger({ type: 'view', date: 1, _dd: { document_version: 1.5 } })).toBe(
      '_dd.document_version'
    );
  });

  it('names a value of the wrong type where the intake decodes an integer', () => {
    expect(findInvalidIntakeInteger({ type: 'error', date: 1, error: { resource: { status_code: '500' } } })).toBe(
      'error.resource.status_code'
    );
    expect(findInvalidIntakeInteger({ type: 'error', date: '1700000000000' })).toBe('date');
    expect(findInvalidIntakeInteger({ type: 'error', date: true })).toBe('date');
    expect(findInvalidIntakeInteger({ type: 'view', date: 1, view: { time_spent: {} } })).toBe('view.time_spent');
    expect(findInvalidIntakeInteger({ type: 'view', date: 1, view: { time_spent: [1] } })).toBe('view.time_spent');
  });

  it('names a number that is not finite, or beyond what the intake can hold exactly', () => {
    expect(findInvalidIntakeInteger({ type: 'error', date: Number.NaN })).toBe('date');
    expect(findInvalidIntakeInteger({ type: 'error', date: Number.POSITIVE_INFINITY })).toBe('date');
    expect(findInvalidIntakeInteger({ type: 'error', date: 2 ** 53 })).toBe('date');
  });

  it('accepts an absent or null value: the intake decodes either as its zero', () => {
    expect(findInvalidIntakeInteger({ type: 'error', date: 1 })).toBeUndefined();
    expect(findInvalidIntakeInteger({ type: 'error', date: 1, error: { resource: null } })).toBeUndefined();
    expect(
      findInvalidIntakeInteger({ type: 'error', date: 1, error: { resource: { status_code: null } } })
    ).toBeUndefined();
  });

  it('checks the values of a map the intake types as integers', () => {
    const view = (custom_timings: unknown) => ({ type: 'view', date: 1, view: { custom_timings } });

    expect(findInvalidIntakeInteger(view({ boot: 1.5 }))).toBe('view.custom_timings.boot');
    expect(findInvalidIntakeInteger(view({ boot: '15' }))).toBe('view.custom_timings.boot');
    expect(findInvalidIntakeInteger(view({ boot: 15, ready: 20 }))).toBeUndefined();
    expect(findInvalidIntakeInteger(view(undefined))).toBeUndefined();
  });

  it('follows arrays on the way to an integer', () => {
    const event = {
      type: 'long_task',
      date: 1,
      long_task: { duration: 1, scripts: [{ duration: 1 }, { duration: 1.5 }] },
    };

    expect(findInvalidIntakeInteger(event)).toBe('long_task.scripts[1].duration');
  });

  it('accepts a float where the intake decodes one', () => {
    const event = {
      type: 'view',
      date: 1,
      view: { time_spent: 1, cumulative_layout_shift: 0.1 },
      _dd: { configuration: { session_sample_rate: 33.3 } },
    };

    expect(findInvalidIntakeInteger(event)).toBeUndefined();
  });
});
