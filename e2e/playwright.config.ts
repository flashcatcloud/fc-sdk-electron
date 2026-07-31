import { defineConfig } from '@playwright/test';
import type { IntegrationFixtures } from './integration/lib/integrationFixture';

// One app per bundler plugin the SDK ships — those plugins exist solely because bundlers break
// dd-trace's module hook, so each needs a packaged app to be verified at all. Upstream had seven
// apps; the four dropped ones only varied the packager or the module format, at roughly twice the
// CI cost. `forge-esbuild-esm` is kept over its CJS twin because it additionally exercises the
// plugin's ESM path (`session.registerPreloadScript()`).
const INTEGRATION_APPS = [
  'forge-webpack', // webpack plugin
  'electron-vite', // vite plugin
  'forge-esbuild-esm', // esbuild plugin, ESM main
] as const;
const INTEGRATION_MODES = ['dev', 'packaged'] as const;

export type IntegrationApp = (typeof INTEGRATION_APPS)[number];
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export default defineConfig<IntegrationFixtures>({
  timeout: 30000,
  workers: 1, // Serial execution
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'e2e',
      testDir: './scenarios',
      testMatch: '**/*.scenario.ts',
    },
    ...INTEGRATION_APPS.flatMap((app) =>
      INTEGRATION_MODES.map((mode) => ({
        name: `${app}-${mode}`,
        testDir: './integration/scenarios',
        testMatch: '**/*.scenario.ts',
        use: { app, mode },
      }))
    ),
  ],
});
