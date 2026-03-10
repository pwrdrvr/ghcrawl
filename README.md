# gitcrawl

`gitcrawl` is a local-first GitHub issue and pull request crawler for maintainers.

Current status:

- `pnpm` monorepo scaffold is in place
- SQLite is the canonical local store
- the CLI hosts the only supported runtime in V1

## Requirements

For normal `gitcrawl` use you need both:

- a GitHub personal access token
- an OpenAI API key

GitHub is required to crawl issue/PR data. OpenAI is required for embeddings and the maintainer clustering/search workflow. If you already have a populated local DB you can still browse it without live keys, but a fresh sync + embed + cluster run needs both.

## Quick start

```bash
pnpm install
pnpm bootstrap
pnpm health
```

For a full first-run walkthrough against `openclaw/openclaw`, see [GETTING-STARTED.md](./GETTING-STARTED.md).

`pnpm bootstrap` runs the interactive setup wizard the first time. It can either save plaintext keys in `~/.config/gitcrawl/config.json` or guide you through a 1Password CLI (`op`) setup that keeps keys out of the config file. You do not need a repo-local `.env.local` file for normal use.

Use `pnpm health` for the root-level doctor helper. `pnpm doctor` is a built-in pnpm command and does not run gitcrawl.
Use `pnpm bootstrap` for setup. `pnpm init` is a built-in pnpm command and does not run gitcrawl init.

If you configured gitcrawl for 1Password CLI, there are root helpers for that too:

```bash
pnpm op:doctor
pnpm op:tui
pnpm op:exec -- sync openclaw/openclaw
pnpm op:shell
```

## Cost To Operate

The main variable cost is OpenAI embeddings.

On a real local run against roughly `12k` issues plus about `1.2x` related PR/issue inputs, `text-embedding-3-large` came out to about **$0.65 USD** total to embed the repo. Treat that as an approximate data point for something like `~14k` issue/PR inputs, not a hard guarantee.

This screenshot is the reference point for that estimate:

![OpenAI embeddings cost for a 12k-issue repo](./docs/images/openai-embeddings-12k-issue-repo.png)

## Root Helpers

The root package exposes pass-through helpers so you do not need to remember the workspace filter syntax:

```bash
pnpm tui openclaw/openclaw
pnpm sync openclaw/openclaw --since 7d
pnpm refresh openclaw/openclaw
pnpm embed openclaw/openclaw
pnpm cluster openclaw/openclaw
pnpm clusters openclaw/openclaw --min-size 10 --limit 20
pnpm cluster-detail openclaw/openclaw --id 123
pnpm search openclaw/openclaw --query "download stalls"
pnpm health
pnpm serve
```

## Installed CLI

The CLI package exposes a real `gitcrawl` bin entrypoint for installed use:

```bash
gitcrawl tui openclaw/openclaw
gitcrawl sync openclaw/openclaw --since 7d
gitcrawl refresh openclaw/openclaw
```

## Agent Skill

This repo now ships an installable skill at [skills/gitcrawl/SKILL.md](./skills/gitcrawl/SKILL.md).

It is meant for Codex Desktop / Codex CLI style skill installs and follows the same `SKILL.md` + `agents/openai.yaml` layout used by Vercel-style skill repos.

For installation and usage conventions, point users at [vercel-labs/skills](https://github.com/vercel-labs/skills).

This repo provides the skill payload under `skills/gitcrawl/`; users should install it using the workflow/tooling described in the Vercel skills repo rather than manual copy instructions here.

The skill is built around the stable JSON CLI surface:

```bash
gitcrawl doctor --json
gitcrawl refresh owner/repo
gitcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent
gitcrawl cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280
```

The agent/build contract for this repo now lives in [SPEC.md](./SPEC.md).

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
pnpm --filter @gitcrawl/cli cli refresh openclaw/openclaw
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --limit 25
pnpm --filter @gitcrawl/cli cli sync openclaw/openclaw --include-comments --limit 25
pnpm --filter @gitcrawl/cli cli embed openclaw/openclaw
pnpm --filter @gitcrawl/cli cli cluster openclaw/openclaw
pnpm --filter @gitcrawl/cli cli clusters openclaw/openclaw --min-size 10 --limit 20
pnpm --filter @gitcrawl/cli cli cluster-detail openclaw/openclaw --id 123 --member-limit 20 --body-chars 280
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
pnpm health
```

`init` / `bootstrap` behavior:

- prompts you to choose one of two secret-storage modes:
  - `plaintext`: saves both keys to `~/.config/gitcrawl/config.json`
  - `1Password CLI`: stores only vault/item metadata and tells you how to run gitcrawl through `op`
- if you choose plaintext storage, init warns that anyone who can read that file can use your keys and that any resulting OpenAI bills are your responsibility
- if you choose 1Password CLI mode, init asks for:
  - Vault name
  - Item name
  - and tells you to create a Secure Note with concealed fields named `GITHUB_TOKEN` and `OPENAI_API_KEY`
- init also prints a ready-to-paste `~/.zshrc` wrapper function and an example `op read` command
- re-running `pnpm bootstrap` is idempotent once both keys are already stored
- use `pnpm bootstrap -- --reconfigure` or `pnpm --filter @gitcrawl/cli cli init --reconfigure` if you want to replace stored keys
- use `pnpm health` or `pnpm run doctor` from the repo root; plain `pnpm doctor` runs pnpm’s own doctor command instead

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
- if init is configured for 1Password CLI but you forgot to run through your `op` wrapper, doctor tells you that explicitly

If you use the `gitcrawl-op` shell wrapper from init, the lazy path becomes:

```bash
gitcrawl-op doctor
gitcrawl-op tui
```

If you do not want a shell function, the repo root also exposes:

```bash
pnpm op:doctor
pnpm op:tui
pnpm op:shell
```

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

For local development, repo-root `.env.local` is still accepted as a fallback, but it is no longer the primary setup path.

## Current caveats

- `serve` starts the local HTTP API only. The web UI is not built yet.
- `sync` only pulls open issues and PRs now.
- a no-arg `sync owner/repo` is now incremental-by-default after the first full completed open scan for that repo; gitcrawl derives an overlapping `since` window from the last qualifying scan instead of refetching the whole open set every time
- `sync` is metadata-only by default. It pulls titles, bodies, labels, assignees, state, and timestamps without fetching comment bodies.
- `sync --include-comments` enables issue comments, PR reviews, and review comments for deeper per-thread context.
- `embed` now defaults to `text-embedding-3-large`.
- `embed` generates separate vectors for `title` and `body`, and also uses stored summary text when present.
- `embed` stores an input hash per source kind and will not resubmit unchanged text for re-embedding.
- `embed` now truncates oversized source text before submission and splits requests on a conservative token budget to avoid OpenAI context-limit failures.
- semantic search, neighbors, and clustering aggregate across the stored embedding sources.
- `sync --since` accepts either an ISO timestamp or a relative duration like `15m`, `2h`, `7d`, or `1mo`.
- `sync --limit <count>` and `sync --since <iso|duration>` are filtered crawls. They do not run stale-open reconciliation for items outside the filtered window.
- `sync --limit <count>` is the best smoke-test path on a busy repository.
- `embed` and `cluster` print timestamped progress lines to stderr during long runs.
- `neighbors` shows exact local nearest neighbors for one embedded thread and is useful for inspecting vector quality before clustering.
- `tui` opens the local full-screen cluster browser with cluster list, member list, and thread detail panes.
- `tui` remembers sort order and min cluster size per repository in the persisted config file.
- `tui` defaults to showing clusters of size `10+`; use `f` inside the TUI to cycle `1`, `10`, `20`, `50`, and `all`.
- if you add a brand-new repo from the TUI with `p`, gitcrawl runs sync -> embed -> cluster and opens that repo with min cluster size `1+` so you can see everything immediately.
- sync now pauses between 100-thread batches and uses stronger rate-limit backoff, but a long crawl can still hit GitHub limits.
- For a first pass on a large repository, prefer `sync --since <iso-timestamp>` before doing a full backfill.
