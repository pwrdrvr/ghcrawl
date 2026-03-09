# gitcrawl

`gitcrawl` is a local-first GitHub issue and pull request crawler for maintainers.

Current status:

- `pnpm` monorepo scaffold is in place
- SQLite is the canonical local store
- the CLI hosts the only supported runtime in V1
- the future web UI is intentionally deferred

## Quick start

```bash
pnpm install
pnpm --filter @gitcrawl/cli cli init
pnpm --filter @gitcrawl/cli cli doctor
```

For a full first-run walkthrough against `openclaw/openclaw`, see [GETTING-STARTED.md](/Users/huntharo/github/gitcrawl/GETTING-STARTED.md).

## Typical flow

```bash
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --limit 25
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --include-comments --limit 25
pnpm --filter @gitcrawl/cli cli summarize openclaw/openclaw
pnpm --filter @gitcrawl/cli cli embed openclaw/openclaw
pnpm --filter @gitcrawl/cli cli cluster openclaw/openclaw
pnpm --filter @gitcrawl/cli cli search openclaw/openclaw --query "download stalls"
pnpm --filter @gitcrawl/cli cli serve
```

Alternate form:

```bash
pnpm --filter @gitcrawl/cli cli sync --repo openclaw/openclaw --limit 25
```

## Environment

`gitcrawl` explicitly loads `.env.local` from the repo root.

Supported variables:

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- `GITCRAWL_DB_PATH`
- `GITCRAWL_API_PORT`
- `GITCRAWL_SUMMARY_MODEL`
- `GITCRAWL_EMBED_MODEL`
- `GITCRAWL_OPENSEARCH_URL`
- `GITCRAWL_OPENSEARCH_INDEX`

## Current caveats

- `serve` starts the local HTTP API only. The web UI is not built yet.
- `sync` only pulls open issues and PRs now.
- `sync` is metadata-only by default. It pulls titles, bodies, labels, assignees, state, and timestamps without fetching comment bodies.
- `sync --include-comments` enables issue comments, PR reviews, and review comments for deeper per-thread context.
- `sync --limit <count>` and `sync --since <iso>` are filtered crawls. They do not run stale-open reconciliation for items outside the filtered window.
- `sync --limit <count>` is the best smoke-test path on a busy repository.
- sync now pauses between 100-thread batches and uses stronger rate-limit backoff, but a long crawl can still hit GitHub limits.
- For a first pass on a large repository, prefer `sync --since <iso-timestamp>` before doing a full backfill.
