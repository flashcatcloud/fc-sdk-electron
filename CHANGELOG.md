# Changelog

All notable changes to `@flashcatcloud/electron-sdk` are documented here.

## [0.1.0]

First FlashCat release. Forked from `@datadog/electron-sdk` v0.3.0 and rebranded to report to the FlashCat platform.

### ✨ Features

- Report RUM events to the FlashCat intake. `site` is now the intake host directly (`browser.flashcat.cloud` for production, `jira.flashcat.cloud` for staging); the intake URL is `https://${site}/api/v2/${track}`.
- Renderer integration uses the `@flashcatcloud/browser-rum` fork; the SDK's build-time core utilities come from `@flashcatcloud/browser-core`.
- `site` is optional and accepts any host, so self-hosted deployments can point at their own intake. It defaults to `browser.flashcat.cloud`. `proxy` remains available for intakes that `site` cannot express. See the README.
- dd-trace's instrumentation telemetry, which reports to a Datadog agent and is unrelated to FlashCat RUM, is disabled by default. Set `DD_INSTRUMENTATION_TELEMETRY_ENABLED=true` to opt back in.

### ⚠️ Breaking Changes / Notes

- Package renamed to `@flashcatcloud/electron-sdk` (internal `dd-`/`Datadog` names and the `DatadogEventBridge` global are kept per the fork convention).
- The intake URL template hardcodes `https://`, so an intake served over plain HTTP is only reachable through `proxy`, not `site`.
- Main-process events are tagged `source: electron`; renderer events bridged from `@flashcatcloud/browser-rum` keep `source: browser` and are tagged `container.source: electron`. Query both to see all of an app's events.
- The main-process transport now sends `Content-Type: text/plain;charset=UTF-8` with a newline-delimited-JSON body, as required by the FlashCat intake.
- APM/trace (`spans`) is not uploaded — FlashCat has no `/api/v2/spans` ingest. Main-process HTTP activity is still reported as RUM `resource` events. Native APM tracing is pending product support.

## [0.3.0] - 2026-05-27 (upstream Datadog)

### ✨ Features

- [RUM-15104] Add main-process resource tracking and tracing via `dd-trace` integration (#95). Preload injection is now handled by `dd-trace` instead of the SDK's `registerPreload()`, and new bundler plugins (`DatadogWebpackPlugin`, `datadogVitePlugin`, `datadogEsbuildPlugin`) are provided for Vite, Webpack, and esbuild.

### 🐛 Bug Fixes

- 🐛 fix crash source_type mapping (#127)

### ⚠️ Breaking Changes

- The old `registerPreload()` (which deferred `session.registerPreloadScript()` to `app.whenReady()`) and the bundled `preload-auto.cjs` bridge have been removed. dd-trace wraps `BrowserWindow` at require-time to inject its own preload script automatically.
- Apps must import `@datadog/electron-sdk/instrument` before `electron` — either directly in the main entry file (e.g. `import '@datadog/electron-sdk/instrument'` as the first import in `main.ts`), or via one of the new bundler plugins which prepend dd-trace initialization as a banner.
- When using **Vite**, **Webpack**, or **esbuild**, the corresponding bundler plugin is mandatory. These plugins ensure dd-trace and `@datadog/electron-sdk` are externalized and correctly initialized before application code runs.
- For **ESM output** (esbuild/vite with `format: "esm"`), the bundler plugins register dd-trace's preload script directly via `session.defaultSession.registerPreloadScript()` on `app.ready`, since ESM's two-phase module loading prevents dd-trace's `BrowserWindow` wrapping from taking effect.

### Internal

- 👷 Update dependency eslint-plugin-unicorn to v64 (#122)
- 👷 Update actions/checkout action to v6 (#118)
- 👷 Update actions/setup-node action to v6 (#119)
- 👷: migrate Renovate config (#117)
- 👷 Update dependency webpack to v5.104.1 [SECURITY] (#115)

## [0.2.0] - 2026-05-04

### ✨ Features

- ⚗️ [RUM-15521] add RUM Operations API to the main process (#102)

### 🐛 Bug Fixes

- 🐛 recover orphaned .tmp batch files on init (#104)
- 🐛 [RUM-15689] fix view date to use start time instead of update time (#97)

### Internal

- ✅ [RUM-15484] bootstrap integration test infrastructure (#91)
- 🔥 remove `_generateActivity` and clean up e2e infrastructure (#90)
- 👷 Update dependency electron to v41.1.0 [SECURITY] (#110)
- 👷 Update dependency vite to v8.0.5 [SECURITY] (#109)
- 👷 Configure Renovate (#92)
- 👷 fix renovate config and integration app yarn version (#112)
- 👷 skip lockfile updates for integration apps in renovate (#113)
- 👷 restore integration apps yarn.lock after packaging (#114)
- 👷 [RUM-15055] fix npm publish OIDC auth after v0.1.3 (#89)

## [0.1.3] - 2026-04-08

### Internal

- 👷 [RUM-15055] fix release / publish pipeline issues from v0.1.2 (#87)

## [0.1.2] - 2026-04-07

### Internal

- 👷 [RUM-15055] fix publish pipeline issues from v0.1.1 (#81)

## [0.1.1] - 2026-04-02

### 🐛 Bug Fixes

- 🐛 fix session management and event attribution issues (#79)
- 🐛 [RUM-15336] Fix preload script resolution (#73)

### Internal

- 👷 [RUM-15055] fix release/publish pipeline issues from v0.1.0 (#77)
- ♻️ move browser-core to devDependencies (#78)
- ♻️ chore: re-enable dependabot with 2-day cooldown (#64)

## [0.1.0] - 2026-03-26

### ✨ Features

- ✨ [RUM-14998] IPC Renderer process support (#38)
- ✨ [RUM-14260] add native crash reporting (#37)
- ✨ [RUM-14514] support session and view attribution by event startTime (#36)
- ✨ [RUM-14243] Implement transport layer & batch management (#19)
- ✨ [RUM-15003] attach user-agent header to intake requests (#35)
- ✨ [RUM-14259] Add RUM error collection (#23)
- ✨ [RUM-14340] attach sdk version to events (#24)
- ✨ [RUM-14582] track view counters (#21)
- ✨ [RUM-14242] Introduce event bus pattern for data processing (#6)
- ✨ [RUM-14582] Initiate view collection (#20)
- ✨ [RUM-14241] Implement Assembly with Hooks system (#11)
- ✨ [RUM-14244] bootstrap SDK telemetry (#9)
- ✨ [RUM-14240] Add session manager (#3)

### Internal

- 👷 [RUM-15055] configure and verify npm package content (#61)
- 👷 [RUM-15055] add release / publish pipeline (#56)
- 👷 [RUM-14260] add rust license tracking (#57)
- 👷 Setup PR / Issue templates (#4)
- Setup basic e2e scenario
- Setup playground
- Setup CI
- Add license files + check
- Init project + node + yarn
