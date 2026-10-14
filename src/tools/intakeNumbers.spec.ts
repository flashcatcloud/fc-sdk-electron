import { describe, expect, it } from 'vitest';
import { findFractionAtIntakeIntegerPath } from './intakeNumbers';

describe('findFractionAtIntakeIntegerPath', () => {
  it('leaves free-form subtrees alone: the intake stores them as they are', () => {
    const event = {
      type: 'error',
      date: 1,
      context: { price: 19.99, nested: { ratio: 0.5 } },
      usr: { score: 0.25 },
      feature_flags: { rollout: 0.1 },
      error: { message: 'x', resource: { status_code: 500 } },
    };

    expect(findFractionAtIntakeIntegerPath(event)).toBeUndefined();
  });

  it('names a fraction where the intake decodes an integer', () => {
    expect(findFractionAtIntakeIntegerPath({ type: 'error', date: 1.5 })).toBe('date');
    expect(findFractionAtIntakeIntegerPath({ type: 'view', date: 1, view: { time_spent: 1.5 } })).toBe(
      'view.time_spent'
    );
    expect(findFractionAtIntakeIntegerPath({ type: 'resource', date: 1, resource: { duration: 2.5 } })).toBe(
      'resource.duration'
    );
    expect(findFractionAtIntakeIntegerPath({ type: 'view', date: 1, _dd: { document_version: 1.5 } })).toBe(
      '_dd.document_version'
    );
  });

  it('follows arrays on the way to an integer', () => {
    const event = {
      type: 'long_task',
      date: 1,
      long_task: { duration: 1, scripts: [{ duration: 1 }, { duration: 1.5 }] },
    };

    expect(findFractionAtIntakeIntegerPath(event)).toBe('long_task.scripts[1].duration');
  });

  it('accepts a float where the intake decodes one', () => {
    const event = {
      type: 'view',
      date: 1,
      view: { time_spent: 1, cumulative_layout_shift: 0.1 },
      _dd: { configuration: { session_sample_rate: 33.3 } },
    };

    expect(findFractionAtIntakeIntegerPath(event)).toBeUndefined();
  });
});
