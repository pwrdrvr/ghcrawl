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
pnpm --filter @gitcrawl/cli cli sync --owner openclaw --repo openclaw
pnpm --filter @gitcrawl/cli cli sync --owner openclaw --repo openclaw --limit 25
pnpm --filter @gitcrawl/cli cli summarize --owner openclaw --repo openclaw
pnpm --filter @gitcrawl/cli cli embed --owner openclaw --repo openclaw
pnpm --filter @gitcrawl/cli cli cluster --owner openclaw --repo openclaw
pnpm --filter @gitcrawl/cli cli search --owner openclaw --repo openclaw --query "download stalls"
pnpm --filter @gitcrawl/cli cli serve
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
- `sync` currently fetches comments and PR review data thread-by-thread, so a large repo can take a while.
- `sync --limit <count>` is the best smoke-test path on a busy repository.
- GitHub API rate limits can stop a long sync early because the current crawler makes multiple API requests per thread.
- For a first pass on a large repository, prefer `sync --since <iso-timestamp>` before doing a full backfill.
