# configure-nodejs action

Sets up Node.js, enables Corepack, restores a lockfile-keyed pnpm store cache, and runs `pnpm install --frozen-lockfile`.

## Required workflow usage pattern

Use this action in a dedicated `install-deps` job first, then make all build/test jobs depend on that job with `needs: install-deps`.

Why:
- Cache key is based on `pnpm-lock.yaml`.
- When lockfile hash changes, parallel jobs can all miss cache, run full installs, and race to save the same key.
- Running one install job first seeds the new cache key once; dependent jobs then restore it and install quickly.

## Example

```yaml
jobs:
  install-deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/configure-nodejs

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
