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
pnpm health
pnpm tui openclaw/openclaw
```

## Verify local setup

Initialize gitcrawl config, runtime paths, and DB:

```bash
pnpm bootstrap
```

This opens the setup wizard the first time. You can either:

- store both keys in plaintext in `~/.config/gitcrawl/config.json`
- or keep them in 1Password CLI (`op`) and let init print a wrapper example for your shell

Use `pnpm bootstrap` for setup. Plain `pnpm init` runs pnpm’s own initializer, not gitcrawl.

Recommended GitHub token shape:

- fine-grained PAT
- scoped to the repos you want to crawl
- repository permissions:
  - `Metadata: Read-only`
  - `Issues: Read-only`
  - `Pull requests: Read-only`

If you use a classic PAT and need private repo access, `repo` is the safe fallback scope.

Check GitHub auth, OpenAI auth, and DB wiring:

```bash
pnpm health
```

`doctor` also validates whether the GitHub token and OpenAI key look structurally correct before it runs the live smoke checks. If you configured `gitcrawl` for 1Password CLI but forgot to run through your `op` wrapper, `doctor` now tells you that too.

From the repo root, use `pnpm health` or `pnpm run doctor`. Plain `pnpm doctor` runs pnpm’s own built-in doctor command.

### 1Password CLI option

If you choose 1Password CLI mode in `pnpm bootstrap`, create a Secure Note in 1Password with concealed fields named exactly:

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`

Then use the wrapper init shows you, or run a command like this:

```bash
env \
  GITHUB_TOKEN="$(op read 'op://Private/gitcrawl/GITHUB_TOKEN')" \
  OPENAI_API_KEY="$(op read 'op://Private/gitcrawl/OPENAI_API_KEY')" \
  pnpm health
```

You can also use the root 1Password helpers:

```bash
pnpm op:doctor
pnpm op:tui
pnpm op:exec -- sync openclaw/openclaw
pnpm op:shell
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
- after the first full completed open scan for a repo, a later plain `sync owner/repo` automatically derives an overlapping incremental `since` window from the last qualifying sync instead of re-pulling the full open set
- `sync` is metadata-only by default, so it skips issue comments, PR reviews, and review comments unless you opt in.
- use `--include-comments` only when you want the extra discussion context badly enough to spend the extra GitHub API budget
- `--since` accepts ISO timestamps and relative durations like `15m`, `2h`, `7d`, and `1mo`
- `--limit` and `--since` are filtered crawls, so they do not mark older locally-open items as closed
- On a large repository, the full sync can take a while.
- Starting with `--since` is the safer first run.
- `--limit` is the safest way to confirm the pipeline works before attempting a full crawl.
- Long syncs can still hit GitHub rate limits, but the crawler now pauses every 100 threads and backs off more aggressively when GitHub asks it to slow down.

## Build embeddings and clusters

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

- `embed` defaults to `text-embedding-3-large`
- `embed` creates separate vectors for `title` and `body`, and also uses stored summary text when present
- unchanged embedding inputs are skipped by stored hash, so reruns do not resubmit identical text
- oversized embedding inputs are truncated locally and requests are split by a conservative token budget before submission
- the embedding worker defaults are `batch_size=8`, `concurrency=10`, and `max_unread=20`; override them with `GITCRAWL_EMBED_BATCH_SIZE`, `GITCRAWL_EMBED_CONCURRENCY`, and `GITCRAWL_EMBED_MAX_UNREAD` if needed
- `neighbors` only works after `embed` has populated at least one embedding source for the repo
- `tui` expects a completed cluster run and shows the latest completed run for the repo
- inside the TUI: `Tab` changes pane, `j/k` moves, `s` changes sort, `f` changes min cluster size, `p` opens repo browsing, `/` filters, `o` opens the selected GitHub URL, and `q` quits
- sort order and min cluster size are remembered per repository
- if you add a brand-new repo from inside the TUI, gitcrawl runs sync -> embed -> cluster and opens that repo at min cluster size `1+`

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
- Timeline event ingestion and durable incremental sync cursors are still future work.
- repo-root `.env.local` is still accepted as a fallback for development, but normal setup should use `pnpm bootstrap`
