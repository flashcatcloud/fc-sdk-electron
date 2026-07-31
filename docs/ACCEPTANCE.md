# Manual Acceptance Checklist

The Playwright E2E and integration suites were removed during the fork. This checklist is the
compensating control: run it **before every release**, and after any change to the transport,
assembly, bridge, or session layers.

Expected results below are the values observed on the reference run against staging
(`jira.flashcat.cloud`, SDK `0.1.0`, Electron 41, macOS).

## 0. Setup

```sh
yarn install
yarn build

cd playground
yarn install
yarn build
yarn electron .
```

The playground initialises the SDK in `playground/src/main.ts` (main process, staging site) and
`@flashcatcloud/browser-rum` in `playground/src/renderer.ts` (renderer). Both use the same
`applicationId`. Adjust the credentials there to point at another environment.

To watch what is actually uploaded, open the main-process terminal — or temporarily wrap
`globalThis.fetch` in `main.ts` to log requests whose URL contains `/api/v2/`.

- [ ] `yarn install` completes in **both** the repo root and `playground/`
      (guards against unpublished dependency versions — this has broken before)
- [ ] Main-process console prints `SDK init result: true`

## 1. Bridge wiring (renderer → main)

Run in the renderer DevTools console:

```js
JSON.stringify({
  present: !!window.DatadogEventBridge,
  hosts: window.DatadogEventBridge?.getAllowedWebViewHosts(),
  hostname: location.hostname,
});
```

- [ ] `present` is `true` — the preload injected by the main-process SDK is loaded
- [ ] `hosts` contains the window's own `location.hostname`, so the Browser SDK's
      `canUseEventBridge()` matches

> Reference run: page loaded over `file://`, so `hostname` is `""` and `hosts` is `[""]` — they
> match and bridging is active. This is the case that most needs re-checking, because `file://`
> has an empty host.

- [ ] Renderer events appear in the **main process's** upload batches, not in renderer-originated
      network requests (the Browser SDK must not upload directly)

## 2. Event coverage

Click each playground button, then wait for a batch flush (~10 s at the default
`uploadFrequency`). Verify each event type reaches the intake.

### Main process — expect `source: "electron"`, `view.url: "electron://main-process"`

- [ ] **view** — emitted on init
- [ ] **resource** — `Main fetch (https.get)`, `Main fetch (fetch)`, `Main fetch (net.fetch)`
      all three produce a resource event with the target URL
- [ ] **error** — `Generate uncaught exception` → `test uncaught exception`
- [ ] **error** — `Generate unhandled rejection` → `test unhandled rejection`
- [ ] Both error stacks use the `at ${func} @ ${url}:${line}:${column}` shape — **not** V8's native
      `at ${func} (${url}:${line}:${column})` — and the frame for your own code carries an absolute
      path, e.g. `at Timeout._onTimeout @ /…/playground/dist/main.js:97:15`
- [ ] **vital** — operation buttons (`op-start` / `op-succeed`) produce vital events
- [ ] **crash** — `Crash` button (kills the app; the crash is reported on next launch)
- [ ] **error** — `Kill Renderer` button (`webContents.forcefullyCrashRenderer()`) produces an
      error event **in the same run**, with:
      `error.message: "Renderer process gone: killed"` (macOS; other platforms may report
      `crashed`, which is deliberately **not** reported here — see below),
      `error.type: "RenderProcessGone"`, `error.is_crash: false`,
      `error.meta.exit_reason` / `error.meta.exit_code` / `error.meta.url` set, and
      `container.view.id` equal to the `view.id` of the renderer events that preceded it

> `render-process-gone` and `child-process-gone` only report terminations that produce **no**
> minidump. `crashed` / `oom` are left to `CrashCollection` (reported on the next launch) and
> `clean-exit` is not reported at all, so the two paths never double-report one incident.
> `killed` is the one overlap: on macOS `forcefullyCrashRenderer()` reports `killed` _and_ writes
> a dump, so that specific trigger can yield two events. Reporting it is deliberate — every other
> way a renderer gets killed writes no dump at all.

> These events carry **no stacktrace** — the main process cannot unwind a process that is already
> gone. They are queryable, but the backend does not group stackless errors into an Issue
> (`fc-rum` `logic/issue/group.go`), so they will **not** show up in Error Tracking or raise
> alerts until that is addressed separately.

### Renderer — expect `source: "browser"`, `container.source: "electron"`

- [ ] **view** — emitted on page load
- [ ] **resource** — `Renderer fetch` produces a resource event
- [ ] **error** — an exception thrown in the page is reported
- [ ] **action** — a **real mouse click** produces an action event

> `action` needs a genuine user click. Synthetic `element.click()` from `executeJavaScript` is not
> a trusted event and the Browser SDK will not record it — this is why the reference run saw no
> action events, and why this step must be done by hand.

### Sessions

- [ ] The session file at `<userData>/_dd_s` exists and shows in the playground's session panel
- [ ] `Stop Session` clears it and subsequent events start a new session

## 3. Upload

- [ ] Requests go to `https://<site>/api/v2/rum`
- [ ] Every intake response is **`202 Accepted`**
- [ ] Request headers are `Content-Type: text/plain;charset=UTF-8` and `DD-API-KEY: <clientToken>`
- [ ] Body is newline-delimited JSON — one event per line, **not** a JSON array
- [ ] No request is made to `/api/v2/spans` (that track is intentionally not supported)
- [ ] dd-trace's instrumentation telemetry is off: no request to `/telemetry/proxy/...` and no
      connection attempt to `127.0.0.1:8126`

## 3b. `site` and `proxy` resolution

`site` accepts any host and is optional — there is no whitelist. Verify by editing the `init()` call
in `playground/src/main.ts`:

- [ ] Omitting `site` entirely still initialises, and uploads go to `browser.flashcat.cloud`
- [ ] A self-hosted-style host (e.g. `rum.example.internal`) is accepted and used verbatim in the
      upload URL — no error is logged
- [ ] `site: ''` (or a non-string) fails init with
      `Configuration error: 'site' must be a non-empty string`
- [ ] With `proxy` set, uploads go to `<proxy>?ddforward=%2Fapi%2Fv2%2Frum` and `site` is ignored

> Reminder: `https://` is hardcoded in the URL template. An intake on plain HTTP, or one not at the
> root of its host, must be reached through `proxy` — `site` cannot express it.

## 3c. Main-process stack un-minification

> **Gate:** this depends on the fc-rum fix for frame-index misalignment when a frame URL fails to
> parse. Node's internal frames (`node:internal/...`) produce exactly such URLs. Do not release this
> SDK ahead of that backend fix — enrichment for main-process errors would misalign or crash.

- [ ] The backend fix is deployed to the environment under test
- [ ] Sourcemaps for the main-process bundle have been uploaded with `--minified-path-prefix /dist`
- [ ] A main-process error raised from minified code resolves to the original file, function and
      line in the console
- [ ] `node:internal/...` frames are skipped rather than breaking enrichment, and the surrounding
      application frames still resolve correctly

## 3d. Pre-warmed window paint timings

Verifies `correctPrewarmedViewTimings`. Only reproducible against a real window lifecycle — the
correction rebases FCP/LCP on when the window became visible, which no unit test can prove.

Edit `playground/src/main.ts` to pre-warm the window: `new BrowserWindow({ show: false, … })`,
`loadURL` immediately, and `setTimeout(() => win.show(), 8000)`.

- [ ] The renderer `view` event's `first_contentful_paint` / `largest_contentful_paint` are on the
      order of the paint delay **after** `show()` — not ~8s
- [ ] Same for `view.performance.fcp.timestamp` / `view.performance.lcp.timestamp`
- [ ] With the window left hidden for the whole run, the `view` event carries **no** FCP/LCP at all
      rather than an inflated value
- [ ] Reverting to the normal `show: true` window leaves FCP/LCP exactly as before the change
- [ ] `correctPrewarmedViewTimings: false` restores the raw (inflated) values

> The standalone Electron probe used to characterise the platform behaviour, and a harness that
> replays its logs through the shipped corrector, live in the task report
> `2026-07-30-electron-fcp-prewarm/` (see its README).

## 3e. Stack path normalization

Verifies `normalizeStackPaths` and `normalizeStackPath`. The unit tests cover the rewriting itself;
what only a real run can show is that the application root the SDK derives matches the paths V8 and
Chromium actually report — which differs between a packaged (asar) and an unpackaged build.

- [ ] Main-process frames are reported as `app:///dist/main.js`, not as an absolute install path
- [ ] Renderer frames are reported as `app:///dist/renderer.js`, not as `file:///…`
- [ ] Same for an **asar-packaged** build (`app.getAppPath()` ends in `app.asar`) — package the
      playground and repeat
- [ ] `node:internal/...` frames still carry their original text
- [ ] `view.url` is **not** rewritten — it stays `file:///…/index.html`
- [ ] `normalizeStackPaths: false` restores the raw absolute paths
- [ ] With `normalizeStackPath` returning a string, that string is used verbatim; returning
      `undefined` falls back to `app:///`
- [ ] With `normalizeStackPath` throwing, frames fall back to `app:///` and events keep flowing

> Point `--minified-path-prefix` at the directory the rewritten path names (`/dist` for
> `app:///dist/…`) — `url.Parse("app:///dist/main.js").Path` is `/dist/main.js`, which is what the
> upload stores the sourcemap under.

## 4. Console verification

- [ ] Events are queryable in the FlashCat RUM console for the target application
- [ ] Both main-process and renderer events are visible

> Query on `source:electron OR container.source:electron`. Main-process events carry
> `source: electron`; renderer events carry `source: browser` with `container.source: electron`.
> Filtering on `source:electron` alone silently drops every renderer event — which is most of the
> volume (views, actions, resources, web vitals).

## 5. Package

```sh
npm pack --dry-run
```

- [ ] Name is `@flashcatcloud/electron-sdk`, version matches `package.json`
- [ ] `dist/index.*`, `dist/instrument.*`, `dist/wasm.chunk.*`, and the three bundler plugins
      (`vite-plugin`, `webpack-plugin`, `esbuild-plugin`) are all present
- [ ] `README.md`, `LICENSE`, `LICENSE-3rdparty.csv` are included

## 6. Fresh-project integration

Not covered by the playground, which consumes the SDK through a yarn `portal:` link.

- [ ] A new Electron project installing the published tarball can `init()` and upload,
      following only the README
- [ ] At least one bundler plugin path (Vite / Webpack / esbuild) is exercised, since each one
      copies `dd-trace`'s preload into the build output
