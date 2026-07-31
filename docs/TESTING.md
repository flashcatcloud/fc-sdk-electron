# Testing

Three layers, each catching what the one below cannot:

| Layer       | Command                 | Runs on          | Covers                                                         |
| ----------- | ----------------------- | ---------------- | -------------------------------------------------------------- |
| Unit        | `yarn test:unit`        | every PR         | collection / assembly / transport logic, `electron` mocked     |
| E2E         | `yarn test:e2e`         | every PR         | a real Electron app against a fake intake                      |
| Integration | `yarn test:integration` | pre-release only | the SDK installed from a tarball into three bundler toolchains |

`docs/ACCEPTANCE.md` remains the manual pass against a real staging intake — the only layer that
exercises the real backend.

## Unit Testing

```sh
yarn test:unit    # vitest run --coverage
yarn test         # watch mode
```

### Strategy

- Mock network and disk access (fetch API, `node:fs`) to avoid real I/O in tests.
- Transitive dependency mocks are acceptable to only test orchestration. Consider a manual
  acceptance pass to exercise the real code path.
- Co-locate specs with source files (`src/**/*.spec.ts`).

### Mocking `electron`

Specs must never load the real `electron` module: `node_modules/electron/index.js` resolves the
downloaded binary at require time and throws when it is absent, which is the case in CI
(`ELECTRON_SKIP_BINARY_DOWNLOAD=1`). Any spec that reaches `electron` — including transitively,
through the `transport`, `bridge`, `domain/rum` or `domain/session` barrels — must declare:

```ts
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
  // …only the members the code under test touches
}));
```

A missing mock surfaces as `Error: Electron failed to install correctly` for the whole suite.

## E2E Testing

Playwright drives a real Electron app (`e2e/app/`) whose uploads are pointed at a fake intake
(`e2e/lib/intake.ts`) through the SDK's `proxy` option. Tests assert on the events that reach it.

```sh
yarn test:e2e:init        # build the SDK, then install and build the fixture app against it
yarn test:e2e             # run every scenario
yarn test:e2e:debug       # same, with the Playwright inspector and visible windows
yarn test:e2e:typecheck   # typecheck the harness (needs dist/, so run after test:e2e:init)
```

Run a single file with `yarn test:e2e e2e/scenarios/view.scenario.ts`.

The fake intake does more than record events: it also validates the FlashCat wire contract
(`/api/v2/rum`, `text/plain` content type, newline-delimited JSON body). A breach makes the real
intake answer `400`, which the SDK retries forever — invisible in the event data.
`intake-contract.scenario.ts` asserts there were none.

### Not covered

- **APM spans.** FlashCat exposes no `/api/v2/spans` ingest, so the SPANS track is not uploaded and
  non-HTTP spans (IPC handlers) have no observable output. `span.scenario.ts` pins that decision
  instead; the upstream span assertions are recoverable from `bd4ff29`.
- **`child-process-gone`** (GPU / Utility / Zygote). No reliable trigger from inside the app; unit
  tests only. `render-process-gone` is covered by `process-gone.scenario.ts`.
- **Native crash symbolication.** `crash.scenario.ts` asserts a raw minidump-derived stack; there is
  no desktop symbolicator route yet.

## Integration Testing

Three realistic Electron apps — one per bundler plugin the SDK ships — install the SDK from a
packed tarball and are tested unpackaged and packaged. These plugins exist because bundlers break
the module hook dd-trace installs on `require('electron')`; nothing else in the test suite would
notice a broken one.

```sh
yarn test:integration:init                  # pack the SDK, install and package every app
yarn test:integration:init forge-webpack    # …or just one
yarn test:integration --project=forge-webpack-dev
```

They are slow and flake-prone, so they do **not** run on pull requests — the `Integration` workflow
runs on a `v*` tag or on demand. See [`../e2e/integration/README.md`](../e2e/integration/README.md).

## Acceptance Testing

The automated layers all talk to a fake intake. [`ACCEPTANCE.md`](./ACCEPTANCE.md) is the manual
pass against a real staging intake — run it before every release and after any change to the
transport, assembly, bridge, or session layers.

`playground/` is also the reference implementation for IPC bridge patterns and SDK integration.
