# Contributing

This file is for maintainers and contributors working from source.

## Development Setup

```bash
pnpm install
pnpm health
```

Useful local commands from the repo root:

```bash
pnpm tui openclaw/openclaw
pnpm sync openclaw/openclaw --limit 25
pnpm refresh openclaw/openclaw
pnpm embed openclaw/openclaw
pnpm cluster openclaw/openclaw
pnpm search openclaw/openclaw --query "download stalls"
pnpm typecheck
pnpm test
```

## Release Flow

This repo uses tag-driven releases from the GitHub Releases UI.

- Workspace `package.json` files stay at `0.0.0` in git.
- Create a GitHub Release with a tag like `v1.2.3`.
- The publish workflow rewrites workspace versions from that tag during the workflow run, runs typecheck/tests/package smoke, and then publishes:
  - `@ghcrawl/api-contract`
  - `@ghcrawl/api-core`
  - `ghcrawl`

CI also runs a package smoke check on pull requests and `main` by packing the publishable packages, installing them into a temporary project, and executing the packaged CLI.
