# Getting Started

This is the quickest way to run `gitcrawl` locally against `openclaw/openclaw`.

## Prerequisites

- Node.js installed
- `pnpm` installed
- a GitHub personal access token
- an OpenAI API key

## Install

From [gitcrawl](/Users/huntharo/github/gitcrawl):

```bash
pnpm install
```

You can use the root helper scripts instead of the longer workspace filter form:

```bash
pnpm bootstrap
pnpm doctor
pnpm tui openclaw/openclaw
```

## Verify local setup

Initialize gitcrawl config, runtime paths, and DB:

```bash
pnpm bootstrap
```

This opens the setup wizard the first time and stores config in `~/.config/gitcrawl/config.json`.

Recommended GitHub token shape:

- fine-grained PAT
- scoped to the repos you want to crawl
- repository permissions:
  - `Metadata: Read-only`
  - `Issues: Read-only`
  - `Pull requests: Read-only`

If you use a classic PAT and need private repo access, `repo` is the safe fallback scope.

Check GitHub auth, OpenAI auth, DB wiring, and optional OpenSearch config:

```bash
pnpm doctor
```

`doctor` also validates whether the GitHub token and OpenAI key look structurally correct before it runs the live smoke checks.

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
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --since 7d
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
- `--since` accepts ISO timestamps and relative durations like `15m`, `2h`, `7d`, and `1mo`
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

Generate one summary with hydrated human comments included:

```bash
pnpm --filter @gitcrawl/cli cli summarize openclaw/openclaw --number 42 --include-comments
```

Remove previously hydrated comments from the local DB and refresh derived documents:

```bash
pnpm --filter @gitcrawl/cli cli purge-comments openclaw/openclaw
```

Generate embeddings:

```bash
pnpm --filter @gitcrawl/cli cli embed openclaw/openclaw
```

Build similarity clusters:

```bash
pnpm --filter @gitcrawl/cli cli cluster openclaw/openclaw
```

Inspect exact nearest neighbors for one embedded thread:

```bash
pnpm --filter @gitcrawl/cli cli neighbors openclaw/openclaw --number 42 --limit 10
```

Open the local cluster browser TUI:

```bash
pnpm --filter @gitcrawl/cli cli tui openclaw/openclaw
```

Notes:

- `summarize` is metadata-only by default and excludes comments unless you pass `--include-comments`
- `summarize` logs per-thread token usage when OpenAI reports it
- `summarize`, `embed`, and `cluster` print timestamped progress to stderr during long runs
- `purge-comments` is useful if you previously hydrated comments and want to get back to a lean metadata-only local corpus
- `embed` defaults to `text-embedding-3-large`
- `embed` creates separate vectors for `title` and `body`, plus a summary-derived vector when summaries exist
- unchanged embedding inputs are skipped by stored hash, so reruns do not resubmit identical text
- oversized embedding inputs are truncated locally and requests are split by a conservative token budget before submission
- the embedding worker defaults are `batch_size=8`, `concurrency=10`, and `max_unread=20`; override them with `GITCRAWL_EMBED_BATCH_SIZE`, `GITCRAWL_EMBED_CONCURRENCY`, and `GITCRAWL_EMBED_MAX_UNREAD` if needed
- `neighbors` only works after `embed` has populated at least one embedding source for the repo
- `tui` expects a completed cluster run and shows the latest completed run for the repo
- inside the TUI: `Tab` changes pane, `j/k` moves, `s` changes sort, `f` changes min cluster size, `/` filters, `o` opens the selected GitHub URL, and `q` quits

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
- [http://127.0.0.1:5179/neighbors?owner=openclaw&repo=openclaw&number=42&limit=10](http://127.0.0.1:5179/neighbors?owner=openclaw&repo=openclaw&number=42&limit=10)
- [http://127.0.0.1:5179/clusters?owner=openclaw&repo=openclaw](http://127.0.0.1:5179/clusters?owner=openclaw&repo=openclaw)
- [http://127.0.0.1:5179/search?owner=openclaw&repo=openclaw&query=download%20stalls&mode=hybrid](http://127.0.0.1:5179/search?owner=openclaw&repo=openclaw&query=download%20stalls&mode=hybrid)

## Current limitations

- There is no web UI yet. `serve` is API-only.
- OpenSearch is not wired yet; search is local SQLite FTS plus exact in-process vector similarity.
- Timeline event ingestion and durable incremental sync cursors are still future work.
- repo-root `.env.local` is still accepted as a fallback for development, but normal setup should use `pnpm bootstrap`
