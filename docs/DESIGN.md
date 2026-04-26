# ghcrawl Design

## Intent

`ghcrawl` is a local-first GitHub issue and pull request crawler for maintainers. It ingests repository discussion state into local storage, enriches it with LLM summaries and embeddings, and surfaces similarity clusters so maintainers can see which PRs and issues are really about the same problem area.

The target user is a maintainer running the tool locally. V1 does not need hosted deployment, multi-user auth, or cloud infrastructure.

## Reference Pattern

Use `discrawl` as the main product pattern:

- local-first
- deterministic CLI entry points
- explicit `doctor` / `sync` style commands
- SQLite as the canonical local store
- optional higher-level search on top of the local store

Use `jeerreview` for the JavaScript/TypeScript app pattern:

- `.env.local` loaded explicitly with `dotenv`
- `GITHUB_TOKEN` for GitHub API auth
- `OPENAI_API_KEY` for OpenAI auth
- small local HTTP API
- small React UI for browsing results

Use `dupcanon` selectively for:

- persisted run history
- auditable similarity edges
- deterministic connected-component clustering

Do not copy `dupcanon`'s Postgres-first runtime, close-planning workflow, or approval flow.

## Product Goals

1. Replicate the operational feel of `discrawl`: local setup, local data, clear subcommands, no hosted dependency.
2. Support GitHub API ingestion for issues, PRs, comments, reviews, review comments, labels, assignees, and timeline metadata.
3. Support OpenAI-backed summarization and embeddings.
4. Evaluate and support local vector search, with a clean path to Dockerized OpenSearch 3.3.
5. Produce useful clusters of similar issues and PRs, even when they are not exact duplicates.
6. Stay project-agnostic. OpenClaw is the first target, not the only target.

## Non-Goals

- No write-back to GitHub in V1.
- No SaaS deployment story in V1.
- No dependency on OpenSearch for first boot.
- No requirement that clusters be mathematically perfect. They need to be operationally useful.

## Proposed Stack

- Package manager: `pnpm`
- Monorepo layout:
  - `packages/api-core`
  - `packages/api-contract`
  - `apps/cli`
  - `apps/web` as a deferred placeholder
- Runtime: Node.js + TypeScript
- CLI: single `ghcrawl` command with subcommands, following the `discrawl` UX pattern
- Local DB: SQLite
- API server: local HTTP server mounted in-process by the CLI
- UI: future React + Vite app using `shadcn/ui` primitives with a custom visual system
- LLM provider: OpenAI
- Vector backends:
  - baseline: exact cosine search in-process over vectors stored in SQLite
  - optional: OpenSearch 3.3 in Docker for ANN / filtered kNN

## Current kNN Decision

For the current corpus size, `ghcrawl` should use exact local similarity only.

- store embeddings in SQLite
- load embeddings for the active repository into process memory
- compute cosine similarity directly in Node
- do not require Docker, OpenSearch, Lucene, or Faiss for normal local use

Reasoning:

- a few thousand summarized threads is small enough for exact search
- this avoids JVM or native vector-service operational overhead on modest machines
- the TypeScript/Node stack stays simpler and easier to debug
- we can defer service-backed ANN until there is real evidence that latency or filtering needs it

## Why TypeScript Instead Of Go

`discrawl` is the operational pattern, not the language mandate. For this project:

- `jeerreview` already provides working GitHub and OpenAI access patterns in TypeScript.
- OpenAI SDK support is straightforward in TypeScript.
- React UI integration is simpler in a single Node/TS workspace.
- The corpus size is small enough that Go is not required for performance in V1.

## Interface Shape

Primary interface should feel like `discrawl`:

```bash
export GITHUB_TOKEN=github_pat_...
ghcrawl doctor
ghcrawl sync --owner openclaw --repo openclaw
ghcrawl summarize --since 30d
ghcrawl embed --since 30d
ghcrawl cluster --open-only
ghcrawl search "download stalls on large files"
ghcrawl serve
```

Recommended initial commands:

- `doctor`: verify token presence, DB, and vector runtime readiness
- `sync`: fetch repository data into SQLite
- `summarize`: generate or refresh thread summaries
- `embed`: generate embeddings for summary documents
- `cluster`: build or refresh similarity clusters
- `search`: keyword + semantic search over local data
- `serve`: start the local HTTP API for inspection and future UI consumption

## Runtime Architecture

V1 does not run a permanent daemon.

- `apps/cli` is the only supported runtime entrypoint
- the CLI calls `packages/api-core` directly for command execution
- `ghcrawl serve` mounts the same core services behind a local HTTP API
- future web code must talk to that HTTP API through `packages/api-contract`
- browser code must never access SQLite, GitHub, or OpenAI directly

## Local Configuration

Use explicit local config plus env vars.

Environment variables:

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- `GHCRAWL_DB_PATH` with default `data/ghcrawl.db`
- `GHCRAWL_API_PORT` with default `5179`
- `GHCRAWL_SUMMARY_MODEL` with default `gpt-5.4`
- `GHCRAWL_EMBED_MODEL` with default `text-embedding-3-small`
- `GHCRAWL_OPENSEARCH_URL` optional
- `GHCRAWL_OPENSEARCH_INDEX` optional

Local config file:

- repo-local `.env.local` for secrets and dev defaults
- optional user config later if we want a `discrawl`-style persisted runtime config

## Package Boundaries

### `packages/api-core`

Owns:

- SQLite access
- GitHub API access
- OpenAI access
- crawl / summarize / embed / search / cluster services
- HTTP route handlers

### `packages/api-contract`

Owns:

- request/response schemas
- shared DTOs
- typed HTTP client

### `apps/cli`

Owns:

- CLI command parsing
- local process lifecycle
- optional in-process HTTP hosting

### `apps/web`

Owns later:

- Vite frontend
- `shadcn/ui`-based component layer
- HTTP-only integration through `api-contract`

## Repository Model

The system must support multiple target repositories over time, even if V1 is usually run against one.

Core entities:

- `repositories`
- `issues`
- `pull_requests`
- `issue_comments`
- `reviews`
- `review_comments`
- `timeline_events`
- `documents`
- `document_summaries`
- `document_embeddings`
- `similarity_edges`
- `clusters`
- `cluster_members`
- `sync_runs`
- `embedding_runs`
- `clustering_runs`

## Canonical Search Document

Do not embed raw GitHub payloads directly. Build one canonical search document per issue or PR thread.

Document inputs:

- title
- body
- non-bot issue comments
- non-bot review summaries
- non-bot review comments
- selected timeline facts like closed / reopened / merged if useful
- selected metadata like labels and affected paths for PRs

Normalization rules:

- skip bot-authored review comments and routine automation chatter
- preserve author, timestamps, labels, state, and links in structured columns
- keep raw JSON separately for traceability

## Summarization Strategy

The user’s proposed flow is correct: summarize first, embed second.

Recommended summary artifacts per thread:

- `problem_summary`: what the author says is wrong or needed
- `solution_summary`: what the PR changes, if applicable
- `maintainer_signal_summary`: what reviewers or commenters are worried about
- `dedupe_summary`: a compact, embedding-oriented summary optimized for semantic similarity

Why this split helps:

- cluster quality improves when embeddings are fed stable, compressed language
- token cost stays bounded
- later search and UI can still show a human-readable explanation

## GitHub Ingestion Design

Use the GitHub REST API first, reusing the `jeerreview` auth/header pattern:

- bearer token from `GITHUB_TOKEN`
- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2022-11-28`
- explicit user agent

Fetch in pages and store cursors/checkpoints locally.

Initial sync scope:

- repository metadata
- open issues
- open PRs
- recent closed issues and PRs
- comments, reviews, review comments
- timeline metadata where available

Recommended sync behavior:

- `sync --full`: backfill everything practical
- `sync --since`: incremental refresh
- idempotent upserts
- per-endpoint rate limit handling and retry with backoff

## OpenAI Access Design

Use OpenAI for two distinct jobs:

1. summarization
2. embeddings

Default models:

- summarization: `gpt-5.4`
- embeddings: `text-embedding-3-small`

Relevant official constraints to design around:

- OpenAI embeddings support batching and a dimensions parameter, with `text-embedding-3-small` defaulting to 1536 dimensions.
- The embeddings API enforces per-input and per-request token limits, so batching should be token-aware rather than count-only.

## Vector Search Options

### Option A: Exact Search In Process

Implementation:

- store vectors in SQLite
- load vectors for the working repo into memory
- compute cosine similarity directly in process

Pros:

- simplest
- no extra service
- exact results
- enough for a few thousand documents

Cons:

- slower if corpus grows substantially
- fewer advanced filtering / ranking options

Recommendation:

- start here first
- keep this as the default until measured performance proves otherwise

### Option B: OpenSearch 3.3 With Lucene HNSW

Implementation:

- run local Docker OpenSearch
- index one document per issue/PR thread with metadata filters
- use `knn_vector`
- use Lucene HNSW as the first ANN backend

Pros:

- good fit for smaller deployments
- filtering during search is strong
- easier operational story than Faiss for this scale

Cons:

- adds Docker dependency
- approximate rather than exact unless configured otherwise

Recommendation:

- first optional vector backend

### Option C: OpenSearch 3.3 With Faiss

Implementation:

- same indexing model, but use Faiss-backed HNSW or IVF

Pros:

- better indexing throughput
- better scale path if the corpus or chunk count grows sharply

Cons:

- more tuning surface
- IVF requires training
- benefits are unlikely to matter at current scale

Recommendation:

- defer until Lucene is proven insufficient

## Recommended Vector Plan

Phase recommendation:

1. exact cosine similarity over SQLite-backed vectors
2. optional OpenSearch 3.3 Lucene/HNSW backend
3. evaluate Faiss only if query latency, filtering, or scale justify it

This is the right trade for the expected corpus size. A few thousand summarized threads is small enough that exact local similarity is cheap and easier to debug.

Current execution decision:

- exact local kNN is the only planned default path right now
- OpenSearch is explicitly deferred
- Lucene and Faiss are not implementation targets unless the local exact path proves insufficient

## Clustering Design

The clustering problem is operational, not academic. We need clusters that help a maintainer say, "these all belong to the same problem area."

Recommended first-pass algorithm:

1. Build one dedupe summary and one embedding per issue/PR thread.
2. For each active thread, fetch top `k` nearest neighbors.
3. Keep edges above a similarity threshold.
4. Add metadata boosts:
   - same labels
   - overlapping touched paths for PRs
   - shared title keywords
   - same error strings or stack fragments
5. Build connected components or union-find groups from accepted edges.
6. Compute cluster centroid and representative thread.

Recommended defaults:

- compare within the same repository first
- support issue-to-PR and PR-to-PR edges
- use stricter thresholds for cross-type matches if needed
- keep edge explanations so users can see why two items matched

## Search Design

Search should be hybrid:

- keyword search over SQLite FTS
- semantic search over embeddings
- cluster-aware result grouping

This lets maintainers find either:

- exact phrases and stack traces
- semantically similar discussions
- broader groups of related work

## API And UI Design

Use a small local API plus React UI, following the `jeerreview` pattern.

Primary UI views:

- repository overview
- sync / health status
- issue/PR list with filters
- document detail
- cluster list
- cluster detail with issues and PRs mixed together
- search results with keyword and semantic tabs

The first UI can be intentionally plain, but it is explicitly deferred until the last phase. The important part of the current design is inspectability and future compatibility:

- show raw source excerpts
- show summaries
- show nearest neighbors with scores
- show cluster membership and rationale

## Project Layout

Recommended initial layout:

```text
ghcrawl/
  packages/
    api-core/
      src/
        api/
        cluster/
        db/
        documents/
        github/
        openai/
        search/
    api-contract/
      src/
  apps/
    cli/
      src/
    web/
      src/
```

## Testing Strategy

Testing must prove the local pipeline works end to end.

Unit tests:

- GitHub payload normalization
- bot-comment filtering
- summary prompt output parsing
- cosine similarity scoring
- cluster graph construction

Integration tests:

- SQLite migrations
- GitHub pagination and checkpoint resume
- summarization and embedding job orchestration with mocked providers
- OpenSearch indexing and query behavior behind an interface

Smoke tests:

- GitHub auth with real token
- OpenAI auth with real key
- optional OpenSearch local connectivity

Golden tests:

- clustering on a fixed fixture corpus
- hybrid search ranking on known examples

## Risks And Mitigations

- GitHub timeline data can be uneven. Mitigation: treat raw issue/PR bodies and comments as the primary truth.
- Bot noise can drown similarity. Mitigation: aggressive author filtering and normalization.
- Summaries can over-compress. Mitigation: keep raw source excerpts and allow re-embedding from adjusted prompts.
- OpenSearch can add unnecessary complexity. Mitigation: make it optional and keep SQLite exact search as the baseline.
- JVM or native vector backends can overcomplicate local setup on low-memory machines. Mitigation: keep exact local search as the primary path and postpone service-backed ANN.
- Cluster thresholds will need tuning. Mitigation: persist neighbor edges and inspect false positives directly in the UI.

## Immediate Recommendation

Build V1 in this order:

1. TypeScript workspace scaffold
2. GitHub sync into SQLite
3. summary generation
4. exact vector search in process
5. clustering
6. API + UI
7. optional OpenSearch backend

That gets to useful maintainer value fastest while keeping the architecture clean enough to scale later.
