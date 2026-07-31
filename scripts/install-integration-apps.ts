/**
 * Installs dependencies for integration test apps and prepares them for testing.
 *
 * For each app under e2e/integration/apps/:
 *   - Runs `yarn install`
 *   - Runs `yarn package`
 *
 * Usage: `node scripts/install-integration-apps.ts [app...]`
 * With no argument every app is prepared; naming apps restricts it to those, which is how CI
 * shards the work — packaging an Electron app is by far the most expensive step.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { command } from './lib/command.ts';
import { printLog, runMain } from './lib/executionUtils.ts';

const appsDir = path.join(import.meta.dirname, '../e2e/integration/apps');

runMain(() => {
  const availableApps = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const requestedApps = process.argv.slice(2);
  const unknownApps = requestedApps.filter((app) => !availableApps.includes(app));
  if (unknownApps.length > 0) {
    throw new Error(`Unknown integration app(s): ${unknownApps.join(', ')}. Available: ${availableApps.join(', ')}`);
  }

  const apps = requestedApps.length > 0 ? requestedApps : availableApps;

  for (const app of apps) {
    const appDir = path.join(appsDir, app);

    printLog(`\n=== Installing ${app} ===`);
    // Use --no-immutable because the integration-sdk.tgz is built fresh on every CI run,
    // so its hash changes and the committed yarn.lock needs to be updated.
    command`yarn install --no-immutable`.withCurrentWorkingDirectory(appDir).withLogs().run();

    printLog(`\n=== Packaging ${app} ===`);
    command`yarn package`.withCurrentWorkingDirectory(appDir).withLogs().run();

    // Restore lockfile after packaging so PnP and yarn.lock stay consistent
    // for the install + package steps; the post-package working tree is clean.
    command`git restore yarn.lock`.withCurrentWorkingDirectory(appDir).withLogs().run();
  }

  printLog(`\nIntegration apps ready: ${apps.join(', ')}`);
});
