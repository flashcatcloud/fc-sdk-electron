import { describe, expect, it } from 'vitest';
import { RendererRegistry } from './RendererRegistry';

describe('RendererRegistry', () => {
  it('returns undefined for an unknown renderer', () => {
    expect(new RendererRegistry().get(1)).toBeUndefined();
  });

  it('stores and reads back renderer info', () => {
    const registry = new RendererRegistry();

    registry.set(1, { viewId: 'view-1', url: 'file:///index.html' });

    expect(registry.get(1)).toEqual({ viewId: 'view-1', url: 'file:///index.html' });
  });

  it('merges partial updates instead of dropping known fields', () => {
    const registry = new RendererRegistry();

    registry.set(1, { viewId: 'view-1', url: 'file:///index.html' });
    registry.set(1, { viewId: 'view-2' });

    expect(registry.get(1)).toEqual({ viewId: 'view-2', url: 'file:///index.html' });
  });

  it('deletes a renderer', () => {
    const registry = new RendererRegistry();
    registry.set(1, { viewId: 'view-1' });

    registry.delete(1);

    expect(registry.get(1)).toBeUndefined();
  });

  it('marks a renderer as visibility-tracked without claiming it was visible', () => {
    const registry = new RendererRegistry();

    registry.trackWindowVisibility(1);

    expect(registry.get(1)).toEqual({ visibilityTracked: true });
  });

  it('keeps the first activation instant when a window is shown again', () => {
    const registry = new RendererRegistry();

    registry.recordFirstVisible(1, 100);
    registry.recordFirstVisible(1, 500);

    expect(registry.get(1)?.firstVisibleAt).toBe(100);
  });

  it('keeps the activation instant across later bridge updates', () => {
    const registry = new RendererRegistry();

    registry.recordFirstVisible(1, 100);
    registry.set(1, { viewId: 'view-1' });

    expect(registry.get(1)).toEqual({ viewId: 'view-1', visibilityTracked: true, firstVisibleAt: 100 });
  });

  it('evicts the oldest renderer past the cap so long-running apps do not leak', () => {
    const registry = new RendererRegistry();

    for (let id = 1; id <= 101; id++) {
      registry.set(id, { viewId: `view-${id}` });
    }

    expect(registry.get(1)).toBeUndefined();
    expect(registry.get(2)).toEqual({ viewId: 'view-2', url: undefined });
    expect(registry.get(101)).toEqual({ viewId: 'view-101', url: undefined });
  });
});
