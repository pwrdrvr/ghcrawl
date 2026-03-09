# Getting Started

This is the quickest way to run `gitcrawl` locally against `openclaw/openclaw`.

## Prerequisites

- Node.js installed
- `pnpm` installed
- `.env.local` present in the repo root with:
  - `GITHUB_TOKEN`
  - `OPENAI_API_KEY`

## Install

From [gitcrawl](/Users/huntharo/github/gitcrawl):

```bash
pnpm install
```

## Verify local setup

Initialize local runtime paths and DB:

```bash
pnpm --filter @gitcrawl/cli cli init
```

Check GitHub auth, OpenAI auth, DB wiring, and optional OpenSearch config:

```bash
pnpm --filter @gitcrawl/cli cli doctor
```

## Sync `openclaw/openclaw`

Full sync:

```bash
pnpm --filter @gitcrawl/cli cli sync --owner openclaw --repo openclaw
```

Smaller first pass for recent changes only:

```bash
pnpm --filter @gitcrawl/cli cli sync --owner openclaw --repo openclaw --since 2026-03-01T00:00:00Z
```

Smallest smoke-test path:

```bash
pnpm --filter @gitcrawl/cli cli sync --owner openclaw --repo openclaw --limit 25
```

Notes:

- `sync` currently fetches issue comments and PR review data thread-by-thread.
- On a large repository, the full sync can take a while.
- Starting with `--since` is the safer first run.
- `--limit` is the safest way to confirm the pipeline works before attempting a full crawl.
- Long syncs can hit GitHub rate limits because the current implementation does multiple per-thread API calls.

## Enrich the local data

Generate summaries:

```bash
pnpm --filter @gitcrawl/cli cli summarize --owner openclaw --repo openclaw
```

Generate embeddings:

```bash
pnpm --filter @gitcrawl/cli cli embed --owner openclaw --repo openclaw
```

Build similarity clusters:

```bash
pnpm --filter @gitcrawl/cli cli cluster --owner openclaw --repo openclaw
```

## Search

Hybrid search:

```bash
pnpm --filter @gitcrawl/cli cli search --owner openclaw --repo openclaw --query "download stalls" --mode hybrid
```

Keyword-only search:

```bash
pnpm --filter @gitcrawl/cli cli search --owner openclaw --repo openclaw --query "panic nil pointer" --mode keyword
```

Semantic-only search:

```bash
pnpm --filter @gitcrawl/cli cli search --owner openclaw --repo openclaw --query "transfer hangs near completion" --mode semantic
```

## Run the local API

Start the local HTTP API:

```bash
pnpm --filter @gitcrawl/cli cli serve
```

Default address:

- [http://127.0.0.1:5179](http://127.0.0.1:5179)

Useful endpoints:

- [http://127.0.0.1:5179/health](http://127.0.0.1:5179/health)
- [http://127.0.0.1:5179/repositories](http://127.0.0.1:5179/repositories)
- [http://127.0.0.1:5179/threads?owner=openclaw&repo=openclaw](http://127.0.0.1:5179/threads?owner=openclaw&repo=openclaw)
- [http://127.0.0.1:5179/clusters?owner=openclaw&repo=openclaw](http://127.0.0.1:5179/clusters?owner=openclaw&repo=openclaw)
- [http://127.0.0.1:5179/search?owner=openclaw&repo=openclaw&query=download%20stalls&mode=hybrid](http://127.0.0.1:5179/search?owner=openclaw&repo=openclaw&query=download%20stalls&mode=hybrid)

## Current limitations

- There is no web UI yet. `serve` is API-only.
- OpenSearch is not wired yet; search is local SQLite FTS plus exact in-process vector similarity.
- Timeline event ingestion and durable incremental sync cursors are still future work.
