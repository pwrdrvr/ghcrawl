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
pnpm bootstrap
pnpm doctor
```

For a full first-run walkthrough against `openclaw/openclaw`, see [GETTING-STARTED.md](/Users/huntharo/github/gitcrawl/GETTING-STARTED.md).

`pnpm bootstrap` runs the interactive setup wizard the first time and saves config to `~/.config/gitcrawl/config.json` by default. You do not need a repo-local `.env.local` file for normal use.

## Root Helpers

The root package exposes pass-through helpers so you do not need to remember the workspace filter syntax:

```bash
pnpm tui openclaw/openclaw
pnpm sync openclaw/openclaw --since 7d
pnpm summarize openclaw/openclaw
pnpm embed openclaw/openclaw
pnpm cluster openclaw/openclaw
pnpm search openclaw/openclaw --query "download stalls"
pnpm serve
```

## Installed CLI

The CLI package exposes a real `gitcrawl` bin entrypoint for installed use:

```bash
gitcrawl tui openclaw/openclaw
gitcrawl sync openclaw/openclaw --since 7d
```

## Release Flow

This repo is set up for tag-driven releases from the GitHub Releases UI.

- Workspace `package.json` files stay at `0.0.0` in git.
- Create a GitHub Release with a tag like `v1.2.3`.
- The publish workflow rewrites workspace versions from that tag during the workflow run, runs typecheck/tests/package smoke, and then publishes:
  - `@gitcrawl/api-contract`
  - `@gitcrawl/api-core`
  - `@gitcrawl/cli`

CI also runs a package smoke check on pull requests and `main` by packing the publishable packages, installing them into a temporary project, and executing the packaged CLI.

## Typical flow

```bash
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --limit 25
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --include-comments --limit 25
pnpm --filter @gitcrawl/cli cli summarize openclaw/openclaw
pnpm --filter @gitcrawl/cli cli summarize openclaw/openclaw --include-comments --number 42
pnpm --filter @gitcrawl/cli cli purge-comments openclaw/openclaw
pnpm --filter @gitcrawl/cli cli embed openclaw/openclaw
pnpm --filter @gitcrawl/cli cli cluster openclaw/openclaw
pnpm --filter @gitcrawl/cli cli neighbors openclaw/openclaw --number 42 --limit 10
pnpm --filter @gitcrawl/cli cli search openclaw/openclaw --query "download stalls"
pnpm --filter @gitcrawl/cli cli tui openclaw/openclaw
pnpm --filter @gitcrawl/cli cli serve
```

Alternate form:

```bash
pnpm --filter @gitcrawl/cli cli sync --repo openclaw/openclaw --limit 25
```

## Init And Doctor

First-run setup:

```bash
pnpm bootstrap
pnpm doctor
```

`init` / `bootstrap` behavior:

- saves config to `~/.config/gitcrawl/config.json` by default
- prompts for the two required API keys:
  - GitHub personal access token
  - OpenAI API key
- re-running `pnpm bootstrap` is idempotent once both keys are already stored
- use `pnpm bootstrap -- --reconfigure` or `gitcrawl init --reconfigure` if you want to replace stored keys

GitHub token guidance:

- recommended: fine-grained PAT scoped to the repositories you want to crawl
- repository permissions:
  - `Metadata: Read-only`
  - `Issues: Read-only`
  - `Pull requests: Read-only`
- if you use a classic PAT and need private repositories, `repo` is the safe fallback scope

`doctor` checks:

- config file presence and path
- local DB path wiring
- GitHub token presence, token-shape validation, and a live auth smoke check
- OpenAI key presence, key-shape validation, and a live auth smoke check
- optional OpenSearch reachability if configured

Environment overrides are still supported and take precedence over the saved config:

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- `GITCRAWL_DB_PATH`
- `GITCRAWL_API_PORT`
- `GITCRAWL_SUMMARY_MODEL`
- `GITCRAWL_EMBED_MODEL`
- `GITCRAWL_EMBED_BATCH_SIZE`
- `GITCRAWL_EMBED_CONCURRENCY`
- `GITCRAWL_EMBED_MAX_UNREAD`
- `GITCRAWL_OPENSEARCH_URL`
- `GITCRAWL_OPENSEARCH_INDEX`

For local development, repo-root `.env.local` is still accepted as a fallback, but it is no longer the primary setup path.

## Current caveats

- `serve` starts the local HTTP API only. The web UI is not built yet.
- `sync` only pulls open issues and PRs now.
- `sync` is metadata-only by default. It pulls titles, bodies, labels, assignees, state, and timestamps without fetching comment bodies.
- `sync --include-comments` enables issue comments, PR reviews, and review comments for deeper per-thread context.
- `summarize` is metadata-only by default too. It summarizes title, body, and labels unless you pass `--include-comments`.
- `summarize` now logs per-thread token usage when the OpenAI API reports it.
- `purge-comments` removes hydrated comments from the local DB and refreshes canonical documents so older comment-heavy crawls can be cleaned up.
- `embed` now defaults to `text-embedding-3-large`.
- `embed` generates separate vectors for `title` and `body`, and also a summary-derived vector when summary fields exist.
- `embed` stores an input hash per source kind and will not resubmit unchanged text for re-embedding.
- `embed` now truncates oversized source text before submission and splits requests on a conservative token budget to avoid OpenAI context-limit failures.
- semantic search, neighbors, and clustering now aggregate across the stored embedding sources instead of relying only on summary vectors.
- `sync --since` accepts either an ISO timestamp or a relative duration like `15m`, `2h`, `7d`, or `1mo`.
- `sync --limit <count>` and `sync --since <iso|duration>` are filtered crawls. They do not run stale-open reconciliation for items outside the filtered window.
- `sync --limit <count>` is the best smoke-test path on a busy repository.
- `summarize`, `embed`, and `cluster` now print timestamped progress lines to stderr during long runs.
- `neighbors` shows exact local nearest neighbors for one embedded thread and is useful for inspecting vector quality before clustering.
- `tui` opens the local full-screen cluster browser with cluster list, member list, and thread detail panes.
- `tui` defaults to showing clusters of size `10+`; use `f` inside the TUI to cycle `10`, `20`, `50`, and `all`.
- sync now pauses between 100-thread batches and uses stronger rate-limit backoff, but a long crawl can still hit GitHub limits.
- For a first pass on a large repository, prefer `sync --since <iso-timestamp>` before doing a full backfill.
