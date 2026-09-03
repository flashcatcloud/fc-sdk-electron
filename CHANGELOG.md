# Changelog

All notable changes to `@flashcatcloud/electron-sdk` are documented here.

## [0.3.0]

### ✨ Features

- The supported floor is now **Electron 30**, down from 39. `session.registerPreloadScript`, which the SDK and dd-trace both register the bridge preload through, only exists from Electron 35; below that the SDK now fills the method in from `session.setPreloads`, which has been there since Electron 2. Filling the method in rather than branching at each call site keeps the SDK and dd-trace written against one API, and means dd-trace's registration from inside the `BrowserWindow` constructor is redirected to the SDK's script exactly as it is on a newer runtime.

  `setPreloads` replaces the session's preload list instead of adding to it, so the list is read back and appended to and an application's own preloads survive. The reverse does not hold: on Electron 30 to 34, an application that calls `session.setPreloads()` itself _after_ the SDK has installed the bridge drops it, where `registerPreloadScript` would have kept both. Applications that set preloads per window through `webPreferences.preload` are unaffected.

  An Electron with neither API still degrades rather than failing: registrations are accepted and dropped, and a single warning names what is lost.

### 🔧 Internal

- The e2e suite runs on the supported floor as well as the current Electron, so the floor cannot rot unnoticed.

## [0.2.2]

### 🐛 Bug Fixes

- An Electron older than 35 no longer stops the application from starting. `session.registerPreloadScript` was introduced in Electron 35, and both this SDK and dd-trace's `BrowserWindow` subclass call it unconditionally — the SDK from an `app` 'ready' listener, dd-trace from every `new BrowserWindow()`. On an older runtime the missing method threw where the host application had no way to catch it, and since the instrumentation entry point runs before the application's own 'ready' handler, the failure preempted window creation: the application died at startup with `Cannot read properties of undefined (reading 'bind')`, a message that says nothing about the Electron version behind it. `peerDependencies` did not prevent this — it is an installation error only under npm, a warning under Yarn and pnpm.

  Sessions on such a runtime now get a stand-in that accepts preload registrations and drops them, which makes dd-trace's call harmless too, and a single warning names the cause. The renderer bridge is what an unsupported Electron costs: main process monitoring is unaffected and the Browser SDK keeps collecting in renderers, though renderer events do not share the main process session. The listeners the SDK puts on the host application are wrapped as well, so no failure inside them can propagate into it.

## [0.2.1]

### 🐛 Bug Fixes

- Minidump crash events now carry `error.fingerprint`, so Error Tracking groups native crashes **per crash site** instead of merging every crash of one exception type into a single issue. The fingerprint is built from the exception type plus the top non-system frame of the crashed thread — module basename and module offset (`SIGSEGV|MyApp|0x12ab3c`), normalized so equivalent offset spellings group together. The offset, not the instruction address, is what identifies the site: ASLR rebases modules on every launch, while an offset is stable across runs of the same build. Offsets drift between builds, so a new app version opens fresh issues — the same trade-off as Android NDK top-frame grouping. The backend uses an event-provided fingerprint verbatim and skips similarity grouping when one is present, so this needs **no backend change**. Crashes with no identified crashed thread (dumps written without an exception stream) carry no fingerprint, as before they carry no stack.

## [0.2.0]

### ✨ Features

- The bridge preload is now the SDK's own, shipped as `@flashcatcloud/electron-sdk/preload` and registered by `installBridgePreload()` on `app.on('session-created')` plus the default session at app ready. It replaces the private preload dd-trace registered from the `BrowserWindow` subclass it installs — a script the SDK could not extend, and one a static ESM import bypasses entirely, since dd-trace's registration depends on the app reaching `BrowserWindow` through a hooked `require`. Hooking session creation also covers custom partitions. dd-trace's registration is redirected to this script rather than left to run alongside it: only one bridge can reach the page, so two scripts would make the outcome depend on registration order. dd-trace keeps instrumenting `net` and IPC as before.

  The bridge answers two new identity questions. `getAnonymousId()` returns a device-scoped id, generated once and stored under `app.getPath('userData')` so it survives restarts and outlives the sessions that renew as the user comes and goes. `getSessionId()` returns the session the main process considers active, or `''` while there is none; the main process pushes every change to the renderers that asked for a configuration and the preload answers from that cache, because a synchronous IPC call per event would be far too slow.

- New `setUser` / `getUser` / `clearUser`: identify the logged-in user from the main process. The identity is attached to main-process events and to the renderer events that arrive over the bridge, and is served to renderers through `DatadogEventBridge.getUser()` for what they upload themselves. `id` is required; only `id`, `name` and `email` are read. The names match `flashcatRum.setUser()` in `@flashcatcloud/browser-rum` so both processes of an application share one vocabulary. See the README.

  `usr.anonymous_id` is untouched by all three, and `usr.id` is still never backfilled with it: the two coexist so unique users can be counted off `COALESCE(NULLIF(usr_anonymous_id, ''), NULLIF(usr_id, ''))` across a login. `clearUser` removes `usr.id` rather than blanking it, since `NULLIF(usr_id, '')` distinguishes an absent field from an empty string.

  An identity set in the main process takes precedence over one set in a renderer, and replaces it wholesale rather than merging field by field — a merge could emit one person's id beside another's email. Applications that only call `flashcatRum.setUser()` in their renderers are unaffected.

- Main-process RUM events now carry `usr.anonymous_id`, so an application can be counted for unique users even when a session has no renderer activity. The synthetic `electron://main-process` view is usually a session's first, and a session takes its user identity from its first view — without the stamp such a session had no identity at all, and unique-user counts came out empty. Renderer events are left alone: the renderer reads the same id off the bridge itself, so stamping a second one here would fight with it.

### 🐛 Bug Fixes

- **Native crash reports now reach Error Tracking at all.** The crash time was read straight off the dump file's `fs.Stats` (`birthtimeMs || mtimeMs`), both of which carry sub-millisecond precision — so `date` was a fraction, and the intake decodes `date` into an int64, where Go's JSON decoder refuses a fractional number and fails the whole event. Nothing surfaced on the SDK side, because the intake answers `202` before it decodes. **No released version has ever delivered a native crash**, while every test stayed green — a JavaScript mock parses such an event perfectly happily.

- **Main-process `resource` events now reach the intake at all.** `SpanProcessor` divided a dd-trace span start by 1e6 to get milliseconds, and dd-trace measures starts off `performance.now()` and reports nanoseconds, so the division essentially never came out even and `resource.date` was fractional — dropped by the intake for the same reason as the crash date, and just as silently. **No released version has ever delivered a main-process resource event.**

  Both fixes go through a shared `toIntakeTimeStamp` rather than a bare `Math.round`, because the shape generalises: any millisecond value that did not come from `Date.now()` is suspect. The end-to-end suite now walks every uploaded event and fails on a fractional number in any field the backend types as an integer, which is the only way this class of defect is visible in CI at all.

- `addError`'s caller-supplied `startTime` is rounded on the way in, so an error timed off anything derived from `performance.now()` is no longer lost the same way. A `null` `startTime` still means _now_ rather than the epoch. The pre-warmed-view rebase rounds the paint metrics it writes too — not a live defect, since its inputs are whole milliseconds today, but the guarantee now belongs to the module rather than to an assumption about what the renderer sends.

- A renderer no longer hangs when it starts before the SDK is ready. The bridge preload asks the main process for its configuration over a **synchronous** channel, and Electron leaves a synchronous request that no listener answers blocked forever — registering one afterwards does not release it. The window never ran a line of the page: blank, unresponsive, for the rest of its life.

  > **This affects 0.1.0 as well**, through the preload dd-trace ships. It is reachable four ways, and the last two need no mistake in ordering at all: a window created without awaiting `init()`, a window created while `init()` is still running, **`init()` returning `false` because it rejected the configuration** — a mistyped `clientToken` was enough to hang every window in the application — and **`init()` never being called**.

  A fallback listener now answers from the moment a preload can run, so nothing can ask before something can answer, and `BridgeHandler` supersedes it and pushes the real configuration to renderers that got the placeholder.

- A session that timed out can be renewed again. Renewal ran on click actions forwarded over the bridge, which made it depend on the Browser SDK still collecting — and from `@flashcatcloud/browser-rum` 0.0.7 the Browser SDK stops collecting while the host reports no session. The host waited for a click to renew; the renderer would not report the click because the host had no session. The application went quiet until it was restarted.

  Renewal now reads input from `webContents` directly, so it does not depend on what a renderer reports. It is wider than what it replaces: keyboard counts, windows that never loaded the Browser SDK count, and it no longer quietly requires `trackUserInteractions` — **with that option off, a session could not be renewed at all**, in 0.1.0 too.

- Main-process HTTP calls no longer lose their `resource` events to a sibling request that never returns. dd-trace only exported a trace once every span in it had finished, so one hung request withheld the resource events of every other request made from the same `ipcMain.handle` invocation, for the rest of the process' life. Spans are now exported as they finish (`flushMinSpans: 1`).

- The SDK's own uploads are now excluded from tracing by **origin** — scheme, host and port — and at the instrumentation layer, so they never produce a span in the first place. The previous exclusion compared hostnames only and was wrong in both directions: with a `proxy` set, it dropped every application request sharing the proxy's host, whatever its port; and when `site` carried a port of its own (`rum.example.internal:8443`), it matched nothing at all, so the SDK reported its own uploads as resources — which produced more uploads.

  > **Self-hosted deployments will see more `resource` events.** Application requests that share a host with the intake and differ only by port were being dropped and are now reported. This is data coming back, not new data.

- Native crash reports now carry the faulting address in `error.meta.exception_codes`. The minidump processor had always resolved it and the SDK dropped it. It is often the only usable lead when the exception type has no name: a process killed from the outside produces a dump with no exception record, reported as `unknown 0x00000000 / 0x00000000`.

### ⚠️ Breaking Changes / Notes

- The renderer's `@flashcatcloud/browser-rum` must be **0.0.7 or newer**. `sessionReplayDirectUpload` landed there, and the Browser SDK drops options it does not recognise — on anything earlier Session Replay records nothing and reports no reason for it.

## [0.1.0]

First FlashCat release. Forked from `@datadog/electron-sdk` v0.3.0 and rebranded to report to the FlashCat platform.

### ✨ Features

- Report RUM events to the FlashCat intake. `site` is now the intake host directly (`browser.flashcat.cloud` for production, `jira.flashcat.cloud` for staging); the intake URL is `https://${site}/api/v2/${track}`.
- Renderer integration uses the `@flashcatcloud/browser-rum` fork; the SDK's build-time core utilities come from `@flashcatcloud/browser-core`.
- `site` is optional and accepts any host, so self-hosted deployments can point at their own intake. It defaults to `browser.flashcat.cloud`. `proxy` remains available for intakes that `site` cannot express. See the README.
- dd-trace's instrumentation telemetry, which reports to a Datadog agent and is unrelated to FlashCat RUM, is disabled by default. Set `DD_INSTRUMENTATION_TELEMETRY_ENABLED=true` to opt back in.
- Main-process error stacks are normalized to the `at ${func} @ ${url}:${line}:${column}` shape the FlashCat backend parses, using the same helpers as the browser SDK. Frame URLs are the absolute paths of the main-process bundle, so main-process stacks can now be un-minified from uploaded sourcemaps. Native crash stacks are unaffected.

  > **Release ordering:** this requires the fc-rum fix for frame-index misalignment when a frame URL fails to parse. Node's internal frames (`node:internal/...`) produce exactly such URLs. Publishing this SDK before that backend fix is deployed will misalign — or crash — sourcemap enrichment for main-process errors.

- FCP and LCP of pre-warmed windows (`new BrowserWindow({ show: false })`, navigated ahead of time) are rebased onto the moment the window first became visible, the way the Paint Timing spec handles prerendered pages. Without it, an application that renders its first screen at `show()` reports paint metrics inflated by the whole pre-warm interval. Set `correctPrewarmedViewTimings: false` to keep the raw document-level values. See the README.

- Stack frame paths are rewritten to `app:///<path relative to the app root>`, the same scheme the Sentry Electron SDK uses, for main-process and renderer stacks alike — a renderer no longer needs a `beforeSend` to be un-minifiable. Frame URLs are runtime installation paths — they carry the user name on Windows, a random mount point for a Linux AppImage, and the bundle location on macOS — so sourcemaps uploaded against them could only match on the machine those paths described. Upload with `--minified-path-prefix /dist` to match `app:///dist/…`. Anything outside the app root (`node:internal/…`, `http(s)` URLs, `app.asar.unpacked`, paths an application already normalized itself) is left untouched. Set `normalizeStackPaths: false` for the raw paths. See the README.

- New `normalizeStackPath` option: rewrite a frame's absolute path yourself, before the built-in normalization runs, for build layouts a single application root cannot express (e.g. emitting to `<app root>/public/dist` but uploading under `/dist`). Returning `undefined` falls through to `app:///`. It applies to main-process and renderer frames alike, and a callback that throws is reported as an SDK error and falls back to the built-in behaviour. See the README.

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
