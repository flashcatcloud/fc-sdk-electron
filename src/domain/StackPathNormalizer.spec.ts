import { describe, expect, it, vi } from 'vitest';
import type { StackTrace } from '@flashcatcloud/browser-core';
import { StackPathNormalizer } from './StackPathNormalizer';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    getAppPath: vi.fn(() => '/mock/app/root'),
  },
}));

/** Run a single frame URL through the normalizer and read it back. */
function normalizeUrl(url: string, appRoot: string | undefined, enabled = true): string | undefined {
  const stackTrace = { stack: [{ func: 'fn', url, line: 1, column: 2 }] } as StackTrace;
  return new StackPathNormalizer(enabled, appRoot).normalizeStackTrace(stackTrace).stack[0].url;
}

describe('StackPathNormalizer', () => {
  describe('normalizeStackTrace', () => {
    it('rewrites a frame under the app root to app:///', () => {
      expect(normalizeUrl('/home/user/my-app/dist/main.js', '/home/user/my-app')).toBe('app:///dist/main.js');
    });

    it('keeps the path below the app root, however deep', () => {
      expect(normalizeUrl('/home/user/my-app/dist/chunks/vendor.js', '/home/user/my-app')).toBe(
        'app:///dist/chunks/vendor.js'
      );
    });

    it('leaves frames outside the app root untouched', () => {
      expect(normalizeUrl('node:internal/modules/cjs/loader', '/home/user/my-app')).toBe(
        'node:internal/modules/cjs/loader'
      );
      expect(normalizeUrl('/usr/lib/node_modules/thing/index.js', '/home/user/my-app')).toBe(
        '/usr/lib/node_modules/thing/index.js'
      );
    });

    it('leaves a Node internal frame that landed wholly in the URL position untouched', () => {
      // `toStackTraceString` puts such frames in the URL position, parentheses and all.
      expect(normalizeUrl('Module._compile (node:internal/modules/cjs/loader:1234:14)', '/home/user/my-app')).toBe(
        'Module._compile (node:internal/modules/cjs/loader:1234:14)'
      );
    });

    it('leaves http(s) URLs untouched', () => {
      expect(normalizeUrl('https://some.host/index.html', '/home/user/my-app')).toBe('https://some.host/index.html');
      expect(normalizeUrl('http://localhost:5173/src/renderer.ts', '/home/user/my-app')).toBe(
        'http://localhost:5173/src/renderer.ts'
      );
    });

    it('leaves frames without a URL alone', () => {
      const stackTrace = { stack: [{ func: 'fn', line: 1, column: 2 }] } as StackTrace;

      expect(new StackPathNormalizer(true, '/home/user/my-app').normalizeStackTrace(stackTrace).stack[0].url).toBe(
        undefined
      );
    });

    describe('asar packaging', () => {
      it('rewrites a macOS asar-packaged frame', () => {
        expect(
          normalizeUrl(
            '/Applications/MyApp.app/Contents/Resources/app.asar/dist/main.js',
            '/Applications/MyApp.app/Contents/Resources/app.asar'
          )
        ).toBe('app:///dist/main.js');
      });

      it('rewrites an unpackaged (development) frame to the same path', () => {
        expect(normalizeUrl('/Users/dev/projects/my-app/dist/main.js', '/Users/dev/projects/my-app')).toBe(
          'app:///dist/main.js'
        );
      });

      // Sentry's pattern ends in `/*` and would produce `app:///.unpacked/…` here.
      it('does not claim the sibling app.asar.unpacked directory', () => {
        expect(
          normalizeUrl(
            '/Applications/MyApp.app/Contents/Resources/app.asar.unpacked/node_modules/native/index.js',
            '/Applications/MyApp.app/Contents/Resources/app.asar'
          )
        ).toBe('/Applications/MyApp.app/Contents/Resources/app.asar.unpacked/node_modules/native/index.js');
      });
    });

    describe('platform path shapes', () => {
      it('rewrites Windows backslash paths, drive letter case included', () => {
        const appRoot = 'C:\\Users\\Someone\\AppData\\Local\\Programs\\MyApp\\resources\\app.asar';

        expect(
          normalizeUrl(
            'c:\\Users\\Someone\\AppData\\Local\\Programs\\MyApp\\resources\\app.asar\\dist\\main.js',
            appRoot
          )
        ).toBe('app:///dist/main.js');
      });

      it('rewrites a Windows file:// URL', () => {
        expect(
          normalizeUrl(
            'file:///C:/Program%20Files/My%20App/resources/app.asar/index.html',
            'C:/Program Files/My App/resources/app.asar'
          )
        ).toBe('app:///index.html');
      });

      it('rewrites the leading-slash form Chromium produces for Windows paths', () => {
        expect(
          normalizeUrl(
            '/C:/Program%20Files/My%20App/resources/app.asar/dist/renderer.js',
            'C:/Program Files/My App/resources/app.asar'
          )
        ).toBe('app:///dist/renderer.js');
      });

      it('rewrites a Linux AppImage mount point', () => {
        expect(
          normalizeUrl(
            '/tmp/.mount_MyApp3Xk2Qz/resources/app.asar/dist/main.js',
            '/tmp/.mount_MyApp3Xk2Qz/resources/app.asar'
          )
        ).toBe('app:///dist/main.js');
      });

      it('rewrites a macOS file:// renderer URL', () => {
        expect(
          normalizeUrl(
            'file:///Applications/MyApp.app/Contents/Resources/app.asar/dist/renderer/index.js',
            '/Applications/MyApp.app/Contents/Resources/app.asar'
          )
        ).toBe('app:///dist/renderer/index.js');
      });

      it('decodes percent-escaped app roots containing spaces and parentheses', () => {
        expect(normalizeUrl('/Users/dev/my%20app%20(beta)/dist/main.js', '/Users/dev/my app (beta)')).toBe(
          'app:///dist/main.js'
        );
      });

      it('still matches a URL whose escape sequences cannot be decoded', () => {
        // `%.j` is not a valid escape, so `decodeURI` throws and the raw URL is used as-is.
        expect(normalizeUrl('/home/user/my-app/dist/100%.js', '/home/user/my-app')).toBe('app:///dist/100%.js');
      });

      it("strips webpack's intermediate segment", () => {
        expect(normalizeUrl('/home/user/my-app/webpack:/src/main/index.ts', '/home/user/my-app/')).toBe(
          'app:///src/main/index.ts'
        );
      });
    });

    describe('when normalization cannot or must not happen', () => {
      it('leaves every frame untouched when disabled', () => {
        expect(normalizeUrl('/home/user/my-app/dist/main.js', '/home/user/my-app', false)).toBe(
          '/home/user/my-app/dist/main.js'
        );
      });

      it('leaves every frame untouched when the app root is unknown', () => {
        expect(normalizeUrl('/home/user/my-app/dist/main.js', undefined)).toBe('/home/user/my-app/dist/main.js');
      });

      // An empty root would otherwise build a pattern matching the head of every path.
      it('leaves every frame untouched when the app root is empty', () => {
        expect(normalizeUrl('/home/user/my-app/dist/main.js', '')).toBe('/home/user/my-app/dist/main.js');
        expect(normalizeUrl('/home/user/my-app/dist/main.js', '/')).toBe('/home/user/my-app/dist/main.js');
      });
    });

    // Pinned because applications that worked around the absence of this feature already emit
    // normalized paths; rewriting their output a second time would break them.
    describe('strict no-op outside the app root', () => {
      it.each([
        '/dist/renderer.js',
        'app:///dist/x.js',
        'node:internal/modules/cjs/loader',
        '<anonymous>',
        '/opt/other-app/dist/main.js',
        'C:/Users/Someone/other-app/dist/main.js',
      ])('leaves %s exactly as it is', (url) => {
        expect(normalizeUrl(url, '/Applications/MyApp.app/Contents/Resources/app.asar')).toBe(url);
      });
    });
  });

  describe('create', () => {
    it('reads the app root from Electron', async () => {
      const stackTrace = {
        stack: [{ func: 'fn', url: '/mock/app/root/dist/main.js', line: 1, column: 2 }],
      } as StackTrace;
      const normalizer = await StackPathNormalizer.create(true);

      expect(normalizer.normalizeStackTrace(stackTrace).stack[0].url).toBe('app:///dist/main.js');
    });

    it('does not read the app root when the built-in normalization is off', async () => {
      const stackTrace = {
        stack: [{ func: 'fn', url: '/mock/app/root/dist/main.js', line: 1, column: 2 }],
      } as StackTrace;
      const normalizer = await StackPathNormalizer.create(false);

      expect(normalizer.normalizeStackTrace(stackTrace).stack[0].url).toBe('/mock/app/root/dist/main.js');
    });
  });
});
