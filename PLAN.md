# GitCrawl Plan

## Goals

- Build a local-first GitHub issue and PR crawler inspired by `discrawl`.
- Reuse `jeerreview` patterns for GitHub auth, OpenAI auth, local API, and React UI.
- Support local summarization, embeddings, semantic search, and clustering.
- Keep the tool project-agnostic and runnable locally by maintainers.

## Facts And Constraints

- `discrawl` is the main reference for product shape and CLI ergonomics.
- `jeerreview` is the main reference for TypeScript app structure and `.env.local` usage.
- `dupcanon` is an architectural reference for persisted run history, auditable similarity edges, and deterministic clustering.
- `jeerreview` already uses the env names we want:
  - `GITHUB_TOKEN`
  - `OPENAI_API_KEY`
  - `JEERREVIEW_LLM_MODEL`
- Current expected local corpus is only a few thousand issues/PRs, so exact similarity is viable at first.
- We should summarize first, then embed the summaries.
- Bot review comments should be skipped from the dedupe-oriented document text.
- OpenSearch 3.3 is optional for V1 and should not block initial usefulness.
- Exact local cosine similarity is the active kNN plan for now; OpenSearch is deferred until we have real performance evidence that we need it.
- This repo uses a `pnpm` monorepo with `packages/api-core`, `packages/api-contract`, `apps/cli`, and a deferred `apps/web`.
- CLI is the only supported execution host in V1. Web is deferred and must stay HTTP-only against the local API boundary.

## Phase 0: Bootstrap

- [x] Add Node.js + TypeScript workspace scaffolding.
- [x] Add root `package.json`, `tsconfig`, and basic scripts.
- [x] Add `.gitignore` entries for `.env.local`, build output, SQLite data, and temp files.
- [x] Copy `.env.local` from `jeerreview` for local development.
- [x] Add a minimal README with local setup commands.
- [x] Add `doctor` command stub so the app always has a quick sanity check path.
- [x] Testing goal: `pnpm typecheck` and `pnpm test` run cleanly on the scaffold.

## Phase 1: Config And Environment

- [x] Implement explicit `.env.local` loading via `dotenv`.
- [x] Read `GITHUB_TOKEN` and fail clearly when missing.
- [x] Read `OPENAI_API_KEY` and fail clearly when missing for OpenAI-dependent commands.
- [x] Define `GITCRAWL_DB_PATH`, `GITCRAWL_API_PORT`, `GITCRAWL_SUMMARY_MODEL`, and `GITCRAWL_EMBED_MODEL`.
- [ ] Decide whether to add a persisted runtime config file now or after first sync works.
- [x] Implement `doctor` checks for env vars, SQLite path creation, and optional OpenSearch reachability.
- [x] Testing goal: config unit tests cover defaults, missing env vars, and override behavior.

## Phase 2: SQLite Schema And GitHub Sync

- [x] Define the SQLite schema for repositories, issues, PRs, comments, reviews, review comments, documents, summaries, embeddings, edges, clusters, and runs.
- [x] Add migrations and migration tests.
- [x] Implement GitHub client using the `jeerreview` header/auth pattern.
- [x] Implement repository sync for issues and PRs.
- [x] Implement comment, review, and review-comment ingestion.
- [ ] Implement checkpointed incremental sync.
- [ ] Implement retry and rate limit handling.
- [ ] Add CLI commands for `sync --full` and `sync --since`.
- [ ] Testing goal: fixture-backed integration tests prove idempotent sync and resume behavior.

## Phase 3: Document Building And Summaries

- [ ] Define the canonical thread document shape for issues and PRs.
- [ ] Implement bot-author filtering and routine automation filtering.
- [ ] Build normalized dedupe documents from title, body, comments, reviews, and selected metadata.
- [ ] Implement summary generation jobs with OpenAI.
- [ ] Persist multiple summary facets, including `dedupe_summary`.
- [ ] Add rerun logic for stale or missing summaries.
- [ ] Testing goal: golden tests prove the document builder excludes bot review noise and preserves important human context.

## Phase 4: Embeddings And Similarity Search

- [ ] Implement embedding generation with `text-embedding-3-small` by default.
- [ ] Persist embeddings in SQLite first.
- [ ] Implement exact cosine similarity search in process.
- [ ] Add `embed` and `search` CLI commands.
- [ ] Measure local performance on a realistic fixture corpus.
- [ ] Design a backend interface for optional OpenSearch support.
- [ ] Testing goal: embedding job tests cover batching, retry, and skipped unchanged rows.

Decision note:

- this phase is the primary kNN path for the foreseeable future
- do not block on Docker, OpenSearch, Lucene, or Faiss

## Phase 5: OpenSearch Evaluation And Optional Backend

- [ ] Add a Docker Compose or equivalent local recipe for OpenSearch 3.3.
- [ ] Implement OpenSearch index creation using `knn_vector`.
- [ ] Start with Lucene/HNSW as the default OpenSearch backend.
- [ ] Support metadata filters in vector search.
- [ ] Add a smoke test for indexing and kNN query execution.
- [ ] Evaluate whether Faiss adds real value for this corpus before implementing it.
- [ ] Testing goal: one integration test suite can run against an ephemeral local OpenSearch instance.

Decision note:

- this phase is explicitly deferred
- only start it after exact local similarity is measured and shown to be insufficient

## Phase 6: Clustering

- [ ] Define similarity thresholds and metadata boosts.
- [ ] Build a kNN edge pipeline for issue-to-issue, PR-to-PR, and issue-to-PR comparisons.
- [ ] Implement connected-component or union-find clustering.
- [ ] Persist clusters, members, representative thread, and explanation edges.
- [ ] Add `cluster` CLI command and rerun controls.
- [ ] Test on a real or sanitized fixture corpus to inspect false positives and false negatives.
- [ ] Testing goal: golden cluster fixtures prove known related threads end up together.

## Phase 7: API And UI

- [ ] Implement local API endpoints for health, repositories, threads, search, neighbors, and clusters.
- [ ] Build a React UI with list/detail browsing similar in spirit to `jeerreview`.
- [ ] Add filters for repo, item type, state, label, and cluster size.
- [ ] Add detail panels that show raw text, summaries, nearest neighbors, and cluster membership.
- [ ] Add a search view with keyword, semantic, and hybrid modes.
- [ ] Add status indicators for sync freshness and model/index freshness.
- [ ] Testing goal: UI smoke tests prove the main list, detail, and search views render from seeded local data.

## Phase 8: Hardening

- [ ] Benchmark sync, summarize, embed, and cluster times on the target corpus size.
- [ ] Add structured logs and run-history tables.
- [ ] Add failure recovery for partial runs.
- [ ] Add export/report helpers for maintainers to share cluster results.
- [ ] Revisit model defaults and prompt budget after real data review.
- [ ] Decide whether per-repo config files are needed.
- [ ] Testing goal: end-to-end local workflow test covers `doctor`, `sync`, `summarize`, `embed`, `cluster`, and `serve`.

## Recommended Execution Order

- [ ] Finish bootstrap and config first.
- [ ] Prove GitHub sync into SQLite before any UI work.
- [ ] Prove document building before embeddings.
- [ ] Prove exact local similarity before OpenSearch.
- [ ] Prove clustering quality before polishing the UI.
