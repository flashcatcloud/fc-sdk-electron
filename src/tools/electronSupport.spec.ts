import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isElectronSupported, MIN_ELECTRON_MAJOR } from './electronSupport';

import * as display from './display';
vi.mock('./display', () => ({
  displayWarn: vi.fn(),
}));

describe('isElectronSupported', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(['30.0.0', '30.0.0-beta.3', '35.1.2', '41.1.0'])('accepts Electron %s without warning', (version) => {
    expect(isElectronSupported(version)).toBe(true);
    expect(display.displayWarn).not.toHaveBeenCalled();
  });

  it.each(['22.3.27', '29.4.6', '', 'not-a-version', undefined])('refuses Electron %s and warns', (version) => {
    expect(isElectronSupported(version)).toBe(false);
    expect(display.displayWarn).toHaveBeenCalledWith(
      expect.stringContaining(`Electron ${MIN_ELECTRON_MAJOR} or later`)
    );
  });

  it('matches the electron peer dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      peerDependencies: { electron: string };
    };

    expect(pkg.peerDependencies.electron).toBe(`>=${MIN_ELECTRON_MAJOR}`);
  });
});
