# ghcrawl Agent Notes

## Purpose

This repository is a local-first GitHub issue and PR crawler for maintainers.

Current priorities:

- reliable local sync from GitHub
- OpenAI-backed summarization and embeddings
- exact local vector similarity and clustering
- a future local web UI, but not yet

## Stack And Tools

- package manager: `pnpm`
- language/runtime: Node.js + TypeScript
- workspace layout:
  - `packages/api-core`
  - `packages/api-contract`
  - `apps/cli`
  - `apps/web` placeholder only
- database: SQLite
- GitHub API: Octokit
- OpenAI API: official `openai` Node SDK
- vector search: exact cosine similarity in-process

## Important Current Behavior

- CLI is the main runtime host in V1.
- The local HTTP API is hosted in-process by the CLI.
- `sync` is open-only.
- `sync` is metadata-only by default.
- `sync --include-comments` is opt-in deeper hydration.
- filtered crawls like `--limit` and `--since` do not reconcile stale open items
- `--since` accepts ISO timestamps and relative durations like `15m`, `2h`, `7d`, and `1mo`

## Where To Read First

- product/design: [docs/DESIGN.md](./docs/DESIGN.md)
- implementation status and next phases: [docs/PLAN.md](./docs/PLAN.md)
- operator overview: [README.md](./README.md)
- maintainer workflow and release notes: [CONTRIBUTING.md](./CONTRIBUTING.md)

## Project Management

Use the repo-local [`project-manager`](./.agents/skills/project-manager/SKILL.md) skill for GitHub issue and project-board work in this repository.

- Repo/project config: `.agents/project-manager.config.json`
- Project board: <https://github.com/orgs/pwrdrvr/projects/9>
- Canonical local tracker: `.local/work-items.yaml` (derived; refresh with `pnpm project:sync`)
- Canonical local issue drafts: `.local/issue-drafts/`
- Do not create parallel scratch trackers or alternate temp directories for issue workups.

## Code Areas

- CLI entrypoint: [apps/cli/src/main.ts](./apps/cli/src/main.ts)
- core service orchestration: [packages/api-core/src/service.ts](./packages/api-core/src/service.ts)
- local HTTP API: [packages/api-core/src/api/server.ts](./packages/api-core/src/api/server.ts)
- shared schemas/contracts: [packages/api-contract/src/contracts.ts](./packages/api-contract/src/contracts.ts)
- GitHub client: [packages/api-core/src/github/client.ts](./packages/api-core/src/github/client.ts)
- OpenAI provider: [packages/api-core/src/openai/provider.ts](./packages/api-core/src/openai/provider.ts)
- SQLite migration/schema: [packages/api-core/src/db/migrate.ts](./packages/api-core/src/db/migrate.ts)

## Working Rules

- Keep changes aligned with the current plan unless the user explicitly changes direction.
- Prefer small, logically isolated changes.
- If you make a logical change, commit it before starting the next logical change.
- Do not leave multiple unrelated or semi-related logical changes uncommitted in the working tree.
- Use conventional commit messages so changes are easy to revert later.

Examples:

- `feat: add neighbors endpoint`
- `fix: respect GitHub rate-limit reset time`
- `docs: update getting started sync examples`
- `refactor: split comment hydration from default sync`
- `test: cover filtered sync reconciliation rules`
- `docs: rewrite README for installed CLI users`

## Verification Expectations

Run the smallest relevant verification before committing.

Common commands:

- `pnpm typecheck`
- `pnpm test`
- targeted CLI smoke tests via:
  - `pnpm --filter ghcrawl cli doctor`
  - `pnpm --filter ghcrawl cli sync openclaw/openclaw --limit 1`

If a change affects OpenAI-backed paths, avoid unnecessary live spend unless the user wants a real run.

When you create or update a PR, follow through on GitHub Actions with `gh`:

- monitor the PR checks after pushing
- inspect failed job logs directly with `gh` instead of asking the user to paste errors back
- keep fixing and pushing until the PR checks pass, unless the user explicitly wants to stop earlier

## Editing Guidance

- Keep package boundaries intact:
  - `apps/web` must not depend on `api-core`
  - browser code must not access SQLite, GitHub, or OpenAI directly
- Prefer metadata-first sync unless there is a strong reason to hydrate comments.
- Do not add a heavyweight external search service as a default dependency path.
- Preserve operator-facing progress output for long-running commands.
