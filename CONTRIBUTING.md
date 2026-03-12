# Contributing

This file is for maintainers and contributors working from source.

## Development Setup

```bash
pnpm install
pnpm bootstrap
pnpm health
```

Useful local commands from the repo root:

```bash
pnpm tui openclaw/openclaw
pnpm sync openclaw/openclaw --limit 25
pnpm seed-install openclaw/openclaw
pnpm refresh openclaw/openclaw
pnpm seed-export openclaw/openclaw --output /tmp/ghcrawl-seeds
pnpm seed-audit --asset /tmp/ghcrawl-seeds/<snapshot>.seed.json.gz --repo openclaw/openclaw --sources title,body
pnpm embed openclaw/openclaw
pnpm cluster openclaw/openclaw
pnpm search openclaw/openclaw --query "download stalls"
pnpm typecheck
pnpm test
```

If you configured 1Password CLI support in init:

```bash
pnpm op:doctor
pnpm op:tui
pnpm op:exec -- sync openclaw/openclaw
pnpm op:shell
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

## Seed Audit

Before publishing a starter seed, audit the exported sidecar locally:

```bash
pnpm seed-export openclaw/openclaw --output /tmp/ghcrawl-seeds
pnpm seed-audit --asset /tmp/ghcrawl-seeds/<snapshot>.seed.json.gz --repo openclaw/openclaw --sources title,body
```

The audit is a streaming validation pass over the compressed sidecar. It fails if:

- the manifest points at the wrong repository
- any thread or edge row references a different repo
- unexpected keys appear in the payload
- source kinds drift outside the expected set
- manifest counts do not match the observed rows

Use `--json` if you want a machine-readable report for release notes or future automation.
