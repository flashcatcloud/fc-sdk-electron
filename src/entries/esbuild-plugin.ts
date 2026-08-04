/**
 * esbuild plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin handles dd-trace initialization and dependency externalization
 * for both CJS and ESM esbuild output formats.
 *
 * For CJS output: prepends a banner that initializes dd-trace via require()
 * before any application code, so dd-trace can hook require('electron') and
 * instrument the `net` module and IPC.
 *
 * For ESM output: prepends the same initialization, reached through
 * createRequire because `require` is not defined in an ES module. The bridge
 * preload is registered by the instrument entry itself, so ESM needs nothing
 * more even though it loads `electron` before the banner evaluates.
 *
 * Usage:
 *   import { datadogEsbuildPlugin } from '@flashcatcloud/electron-sdk/esbuild-plugin';
 *
 *   await esbuild.build({
 *     plugins: [datadogEsbuildPlugin()],
 *   });
 */

interface EsbuildPlugin {
  name: string;
  setup: (build: {
    initialOptions: {
      format?: string;
      banner?: { js?: string };
      external?: string[];
    };
  }) => void;
}

const CJS_BANNER = 'try{require("@flashcatcloud/electron-sdk/instrument")}catch{}';

const ESM_BANNER = `
import { createRequire as __ddCR } from "module";
try { __ddCR(import.meta.url)("@flashcatcloud/electron-sdk/instrument"); } catch {}
`.trim();

export function datadogEsbuildPlugin(): EsbuildPlugin {
  return {
    name: 'datadog-electron-sdk',
    setup(build) {
      const isESM = build.initialOptions.format === 'esm';
      const ddBanner = isESM ? ESM_BANNER : CJS_BANNER;

      // Prepend dd-trace initialization banner
      const existingBanner = build.initialOptions.banner?.js;
      build.initialOptions.banner = {
        ...build.initialOptions.banner,
        js: existingBanner ? `${existingBanner}\n${ddBanner}` : ddBanner,
      };

      // Externalize dd-trace and @flashcatcloud/electron-sdk
      const external = build.initialOptions.external ?? [];
      for (const pkg of ['dd-trace', '@flashcatcloud/electron-sdk']) {
        if (!external.includes(pkg)) {
          external.push(pkg);
        }
      }
      build.initialOptions.external = external;
    },
  };
}
