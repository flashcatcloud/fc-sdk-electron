# Development Guide

Development workflow, build configuration, and dependencies.

## Getting Started

After cloning, run the one-time setup script:

```sh
yarn repo:init
```

This initializes the git submodule, installs playground dependencies, and builds the SDK.

## Development Workflow

### Manual Checks

Run appropriate tests based on your changes:

- **Format & tint**: `yarn lint-staged` - Format and lint only staged files
- **Type check**: `yarn typecheck` - Verify TypeScript types
- **Build**: `yarn build` - Verify the SDK builds correctly
- **Unit tests**: `yarn test:unit` - For SDK code changes
- **E2E tests**: `yarn test:e2e:init && yarn test:e2e` - For collection, assembly, bridge or transport changes
- **Integration tests**: `yarn test:integration:init && yarn test:integration` - For bundler-plugin changes; slow, pre-release only
- **Acceptance pass**: see `docs/ACCEPTANCE.md` - Manual end-to-end run against `playground/`

### Git Hooks

The project uses [husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/lint-staged/lint-staged) for git hooks:

- **pre-commit**: Runs `yarn lint-staged` to format and lint only staged files

Git hooks are installed automatically when running `yarn install` via the `prepare` script.

## Build System

### Dual Output (Rollup)

The SDK builds both CommonJS and ES modules for maximum compatibility:

- **CJS**: `dist/index.cjs` - For Node.js and Electron main process
- **ESM**: `dist/index.mjs` - For modern bundlers
- **Types**: `dist/index.d.ts` - Single TypeScript definition file

### Build-Time Constants

`@rollup/plugin-replace` injects constants at build time. They are declared in `src/globals.d.ts` and replaced with actual values during the Rollup build.

- **`__SDK_VERSION__`** — SDK version from `package.json`, used in telemetry events and RUM `ddtags`.

For unit tests, these constants are defined via Vitest's `define` option in `vitest.config.mjs`.

## Commit messages and Pull Request titles

Messages should be concise but explanatory. We are using a convention inspired by [gitmoji][1], to
label our Commit messages and Pull Request titles:

### User-facing changes

- 💥 **Breaking change** - Breaking API changes
- ✨ **New feature** - New public API, behavior, event, property
- 🐛 **Bug fix** - Fix bugs, regressions, crashes
- ⚡️ **Performance** - Improve performance, reduce bundle size
- 📝 **Documentation** - User-facing documentation
- ⚗️ **Experimental** - New public feature behind a feature flag

### Internal changes

- 👷 **Build/CI** - Dependencies, tooling, deployment, CI config
- ♻️ **Refactor** - Code restructuring, architectural changes
- 🎨 **Code structure** - Improve code structure, formatting
- ✅ **Tests** - Add/fix/improve tests
- 🔧 **Configuration** - Config files, project setup
- 🔥 **Removal** - Remove code, features, deprecated items
- 👌 **Code review** - Address code review feedback
- 🚨 **Linting** - Add/fix linter rules
- 🧹 **Cleanup** - Minor cleanup, housekeeping
- 🔊 **Logging** - Add/modify debug logs, telemetry

## Dependency Management

### Adding Dependencies

When adding a new dependency, you must update `LICENSE-3rdparty.csv`.

`LICENSE-3rdparty.csv` tracks four categories of dependencies:

| Component   | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| `npm-prod`  | NPM production deps (`dependencies` in any `package.json`)             |
| `npm-dev`   | NPM dev deps (`devDependencies` in any `package.json`)                 |
| `rust-prod` | Rust crates compiled into the distributed WASM binary (non-dev deps)   |
| `rust-dev`  | Rust crates used only during minidump-processor development (dev-deps) |

**Section order** (must be respected):

1. `npm-prod`
2. `rust-prod`
3. `npm-dev`
4. `rust-dev`

**Rules for all:**

1. Format: `Component,Origin,License,Copyright`
2. Do not include version numbers — list package name only
3. Maintain alphabetical order by package name within each component group
4. Fetch license info from the crate/package repository

**Validation:** Run `node scripts/check-licenses.ts` to verify both NPM and Rust entries are in sync.

### Bundled vs runtime dependencies

This SDK is fully bundled: Rollup inlines all packages not listed in `external` (`rollup.config.mjs`).
Currently `external` contains only `['electron']`.

- **`devDependencies`**: use for packages inlined by Rollup — consumers don't need to install them (e.g. `@datadog/browser-core`).
- **`dependencies` + add to `external`**: only for packages that must remain a shared singleton at runtime (e.g. `electron`).

### License Information Sources

- NPM: check package repository's LICENSE or `package.json`
- Rust crates: check `Cargo.toml` license field or repo LICENSE file; `cargo metadata` reports the license field for registered crates

### GitHub Actions

GitHub Actions must be pinned to a **full commit SHA** (DataDog enterprise policy). Use the version tag as a comment for readability:

```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

To find the SHA for a given version, check the action's GitHub releases page or run:

```bash
git ls-remote --tags https://github.com/actions/checkout | grep 'v4\.'
```

### Updating Dependencies

Always use latest stable versions for new dependencies. Check with:

```bash
npm view <package>@latest version
```

## RUM Events Schema Management

Types auto-generated from [rum-events-format](https://github.com/DataDog/rum-events-format) submodule → `src/rumEvent.types.ts` (committed).

```bash
yarn json-schemas:sync      # Update submodule + regenerate types
yarn json-schemas:generate  # Regenerate types only
```

**Fork dependency**: Uses `bcaudan/json-schema-to-typescript#bcaudan/add-readonly-support` (v11.0.1) for `readonly` modifier support. Built lazily when generating types (not during `yarn install`) to avoid CI rate limiting.

⚠️ Never edit `src/rumEvent.types.ts` manually.

## Playground Architecture

### Module System Split

The playground uses different module systems due to Electron constraints:

- **main.ts, preload.ts**: CommonJS (`tsconfig.json`) - Electron requires this
- **renderer.ts**: ES modules (`tsconfig.renderer.json`) - Runs in browser, can use modern modules
- **ESLint**: Uses `tsconfig.eslint.json` that includes all files for type-checking

**Critical detail:** Using `export {}` in CommonJS code generates `exports` references that fail in browser. Separate compilation configs prevent this.

### Hot Reload System

Two watchers handle different reload scenarios:

1. **electron-reloader** (3s startup delay) - Watches playground files, reloads windows
2. **chokidar** (5s grace period, 200ms debounce) - Watches parent SDK's dist/, clears require cache, relaunches app

Grace periods prevent reload loops during initial TypeScript compilation.

No watching of HTML changes for now to avoid extra complexity.

## Releasing

### Prerequisites

- Maintain permission on the GitHub repository (required to push tags and run the workflow)
- npm publishing credentials configured for the repository

`publish` is the release branch and the repository default. `main` tracks the upstream
project and is not part of this flow.

### Release flow

#### 1. Open a release PR against `publish`

On a branch off `publish`:

- Set the new version in `package.json` — it is the source of truth, and the publish
  workflow refuses to run if the tag does not match it.
- Add the matching `## [X.Y.Z]` section to `CHANGELOG.md`. The workflow extracts this
  section verbatim as the GitHub release notes, so it stops at the next `## ` heading.
- Leave already-released sections alone. Compare against `git show vX.Y.Z:CHANGELOG.md`
  to confirm a published section still says what that version actually shipped.

Run the same gates the workflow runs, so a failure surfaces before the release:

```sh
yarn typecheck && yarn build && yarn test:unit && yarn format:check
```

Merge the PR once CI is green.

#### 2. Tag the merge commit

```sh
git checkout publish && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The tag must be on the merge commit, and `vX.Y.Z` must match `package.json`.

#### 3. Run the publish workflow from the tag

Actions → **Publish** → **Run workflow**, selecting the tag `vX.Y.Z` in the ref dropdown.

- `dry_run` runs the whole pipeline — build, gates, package contents — without publishing
  to npm or creating a GitHub release. Use it first.
- `npm_tag` chooses the dist-tag. Publishing under `next` leaves `npm install` resolving to
  whatever `latest` already points at, so a release can be staged. Promote it afterwards
  without republishing:

  ```sh
  npm dist-tag add @flashcatcloud/electron-sdk@X.Y.Z latest
  ```

[1]: https://gitmoji.carloscuesta.me/
