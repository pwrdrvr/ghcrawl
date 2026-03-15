# configure-nodejs action

Sets up Node.js, enables Corepack, checks or restores a lockfile-keyed workspace `node_modules` cache, and only runs `pnpm install --frozen-lockfile` when the cache misses.

## Inputs

- `node-version`: Node.js major version to install. Defaults to `22`.
- `lookup-only`: When `true`, checks whether the cache key exists without downloading the archive. Defaults to `false`.

## Required workflow usage pattern

Use this action in a dedicated `install-deps` job first, then make all build/test jobs depend on that job with `needs: install-deps`.

Why:
- Cache key is based on the lockfile and workspace manifests.
- When the key changes, parallel jobs can all miss cache, run full installs, and race to save the same key.
- The `install-deps` job should call the action with `lookup-only: true` so a cache hit returns immediately without unpacking `node_modules`.
- In that lookup-only hit path, the action also skips `corepack enable`, so the seed job does not set up `pnpm` unless it actually needs to populate the cache.
- If the lookup misses, that same job runs `pnpm install --frozen-lockfile` once and saves the cache.
- Dependent jobs should use the default `lookup-only: false` so they restore `node_modules` from the populated cache and skip install on an exact hit.

## Example

```yaml
jobs:
  install-deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/configure-nodejs
        with:
          lookup-only: true

  typecheck:
    runs-on: ubuntu-latest
    needs: install-deps
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/configure-nodejs
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    needs: install-deps
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/configure-nodejs
      - run: pnpm test
```
