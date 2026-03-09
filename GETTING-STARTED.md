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
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw
```

Full sync with comment and review hydration:

```bash
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --include-comments
```

Smaller first pass for recent changes only:

```bash
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --since 2026-03-01T00:00:00Z
```

Smallest smoke-test path:

```bash
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --limit 25
```

Alternate explicit form:

```bash
pnpm --filter @gitcrawl/cli cli sync --repo openclaw/openclaw --limit 25
```

Notes:

- `sync` only ingests open issues and PRs.
- `sync` is metadata-only by default, so it skips issue comments, PR reviews, and review comments unless you opt in.
- use `--include-comments` only when you want the extra discussion context badly enough to spend the extra GitHub API budget
- `--limit` and `--since` are filtered crawls, so they do not mark older locally-open items as closed
- On a large repository, the full sync can take a while.
- Starting with `--since` is the safer first run.
- `--limit` is the safest way to confirm the pipeline works before attempting a full crawl.
- Long syncs can still hit GitHub rate limits, but the crawler now pauses every 100 threads and backs off more aggressively when GitHub asks it to slow down.

## Enrich the local data

Generate summaries:

```bash
pnpm --filter @gitcrawl/cli cli summarize openclaw/openclaw
```

Generate embeddings:

```bash
pnpm --filter @gitcrawl/cli cli embed openclaw/openclaw
```

Build similarity clusters:

```bash
pnpm --filter @gitcrawl/cli cli cluster openclaw/openclaw
```

## Search

Hybrid search:

```bash
pnpm --filter @gitcrawl/cli cli search openclaw/openclaw --query "download stalls" --mode hybrid
```

Keyword-only search:

```bash
pnpm --filter @gitcrawl/cli cli search openclaw/openclaw --query "panic nil pointer" --mode keyword
```

Semantic-only search:

```bash
pnpm --filter @gitcrawl/cli cli search openclaw/openclaw --query "transfer hangs near completion" --mode semantic
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
