# Testing

Unit testing strategy, plus the manual acceptance pass that replaces the removed E2E suite.

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

## Acceptance Testing

The Playwright E2E and integration suites were removed when the repository was forked — they were
tightly coupled to Datadog infrastructure. Until they are rebuilt, end-to-end behaviour is covered
by a **manual acceptance pass** against the `playground/` app.

See [`ACCEPTANCE.md`](./ACCEPTANCE.md) for the checklist. Run it before every release and after any
change to the transport, assembly, bridge, or session layers.

`playground/` is also the reference implementation for IPC bridge patterns and SDK integration.
