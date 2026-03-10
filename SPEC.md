# ghcrawl Spec

This file is the build contract for an AI agent working in this repo.

Goal:

- build a local-first GitHub issue and pull request crawler
- mirror open issues and PRs for one repo at a time into local SQLite
- support exact local semantic search, clustering, and maintainer triage
- support CLI, local HTTP API, and TUI entrypoints from the same in-process library
- expose stable JSON interfaces that installable agent skills can drive

This spec is intentionally concrete so an agent can keep shipping without re-asking settled questions.

## Product Summary

`ghcrawl` is a local-first maintainer tool for triaging duplicate or closely related GitHub issues and PRs.

V1 scope:

- one repo at a time in normal CLI usage
- open issues and open PRs only
- metadata-first sync
- optional comment hydration
- exact local vector search over SQLite-backed embeddings
- deterministic clustering
- full-screen TUI for browsing clusters
- JSON CLI and HTTP routes for agent use

Out of scope for V1:

- hosted multi-user deployment
- closed-item backfill as a primary view
- write-back GitHub actions beyond local analysis
- OpenSearch as the default runtime
- web UI implementation

## Requirements Already Chosen

These are settled unless the user explicitly changes them:

- runtime: local-only
- package manager: `pnpm`
- config format: JSON
- config location: `~/.config/ghcrawl/config.json`
- DB location: `~/.config/ghcrawl/ghcrawl.db`
- local API port default: `5179`
- GitHub client: Octokit-based wrapper
- embeddings model: `text-embedding-3-large`
- summary model default: `gpt-5-mini`
- sync policy: open issues/PRs only
- sync default: metadata-only
- comment hydration: opt-in
- kNN strategy: exact local cosine search first
- secret modes:
  - plaintext config storage
  - 1Password CLI metadata + env injection

## Local Environment Contract

An agent should assume:

- repo path: `~/github/ghcrawl`
- shell: `zsh`
- Node.js and `pnpm` are installed
- maintainers may run via:
  - `pnpm ...` from the repo root
  - installed `ghcrawl` bin
  - `op`-backed shell wrappers

### Key file paths

- `~/.config/ghcrawl/config.json`
- `~/.config/ghcrawl/ghcrawl.db`
- `~/github/ghcrawl/SPEC.md`
- `~/github/ghcrawl/skills/ghcrawl/SKILL.md`

## Data Model Notes

Important repo-analysis facts that drive the schema:

- issues and PRs share one canonical `threads` table
- only open items are first-class inputs in V1
- thread documents are built from title/body/labels, with comments optional
- embeddings are stored separately by source kind:
  - `title`
  - `body`
  - `dedupe_summary`
- clusters are materialized from similarity edges

### Entities to persist

- repositories
- threads
- comments
- document summaries
- document embeddings
- similarity edges
- clusters
- cluster members
- sync / summary / embedding / cluster runs
- repo sync cursor state

## Interface Contract

The product must keep these machine-facing surfaces working:

### CLI JSON surface

- `ghcrawl doctor --json`
- `ghcrawl sync owner/repo`
- `ghcrawl refresh owner/repo`
- `ghcrawl embed owner/repo`
- `ghcrawl cluster owner/repo`
- `ghcrawl clusters owner/repo`
- `ghcrawl cluster-detail owner/repo --id <cluster-id>`
- `ghcrawl search owner/repo --query <text>`
- `ghcrawl neighbors owner/repo --number <thread-number>`

### Local HTTP API

- `GET /health`
- `GET /repositories`
- `GET /threads`
- `GET /search`
- `GET /neighbors`
- `GET /clusters`
- `GET /cluster-summaries`
- `GET /cluster-detail`
- `POST /actions/rerun`
- `POST /actions/refresh`

### TUI

- browse local repos
- refresh in one staged pipeline
- inspect clusters and member details
- remain a human UI, not the primary automation surface

## Agent Skill Contract

`ghcrawl` should remain usable from installable agent skills.

That means:

- prefer JSON CLI commands over screen scraping
- expose one staged refresh command:
  - GitHub sync/reconcile
  - embeddings
  - clusters
- expose cluster summary listing with freshness stats
- expose cluster detail dumps with:
  - title
  - kind
  - URL
  - body snippet
  - stored summary fields when present

The installable skill lives in:

- `skills/ghcrawl/`

## Implementation Guidance

- keep DB-backed operational state in SQLite, not in config
- keep user preferences in config
- keep secret values out of repo files
- default to stable machine-readable interfaces before adding new UI affordances
- prefer exact local search until there is measured evidence that a separate vector service is required

## Testing Requirements

- `pnpm test`
- `pnpm typecheck`
- service tests for refresh sequencing and cluster dump payloads
- server tests for cluster summary/detail endpoints
- CLI help tests for the public agent-facing commands

## Release Requirements

- packaged CLI must expose a working `ghcrawl` bin
- skill files must be included in git
- README must document:
  - install
  - setup
  - refresh workflow
  - agent skill install/use
