# ghcrawl Plan

## Summary Of Goals And Facts

- Build a local-first GitHub issue and PR crawler inspired by `discrawl`.
- Reuse `jeerreview` patterns for env loading, local API shape, and future local UI shape.
- Reuse `dupcanon` selectively for auditable runs, similarity edges, and deterministic clustering.
- Keep the tool project-agnostic and runnable locally by maintainers.
- Use a `pnpm` monorepo with:
  - `packages/api-core`
  - `packages/api-contract`
  - `apps/cli`
  - `apps/web` as a deferred placeholder
- CLI is the only supported runtime host in V1.
- Web is deferred and must stay HTTP-only against the local API boundary.
- SQLite is the canonical store.
- Exact local cosine similarity is the active kNN plan.
- OpenSearch is explicitly deferred until local exact search proves insufficient.
- Sync is open-only.
- Sync is metadata-only by default.
- `sync --include-comments` is optional deeper hydration, not the default path.
- Filtered crawls like `--limit` and `--since` do not perform stale-open reconciliation.

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
- [x] Define `GHCRAWL_DB_PATH`, `GHCRAWL_API_PORT`, `GHCRAWL_SUMMARY_MODEL`, and `GHCRAWL_EMBED_MODEL`.
- [ ] Decide whether to add a persisted runtime config file now or after first sync works.
- [x] Implement `doctor` checks for env vars, SQLite path creation, and optional OpenSearch reachability.
- [x] Testing goal: config unit tests cover defaults, missing env vars, and override behavior.

## Phase 2: SQLite Schema And GitHub Sync

- [x] Define the SQLite schema for repositories, threads, comments, documents, summaries, embeddings, edges, clusters, and runs.
- [x] Add migrations and migration tests.
- [x] Switch GitHub access to Octokit with retry, pagination, and throttling hooks.
- [x] Implement repository sync for open issues and PRs.
- [x] Track `first_pulled_at` and `last_pulled_at` for local thread state.
- [x] Preserve thread kind correctly as `issue` or `pull_request`.
- [x] Reconcile stale locally-open threads on full unfiltered crawls and mark them closed when GitHub confirms closure.
- [x] Add rate-limit backoff logging that tells the operator how long GitHub told us to wait.
- [x] Add positional `owner/repo` CLI syntax.
- [x] Add filtered crawls with `--since` and `--limit`.
- [x] Make comment, review, and review-comment hydration opt-in with `--include-comments`.
- [ ] Implement durable incremental checkpoints/cursors instead of relying only on `--since`.
- [ ] Decide whether to persist GitHub ETags or GraphQL cursors for cheaper refreshes.
- [ ] Add a dedicated `refresh-closed` or equivalent command if full open reconciliation becomes too slow on large repos.
- [ ] Testing goal: add fixture-backed sync tests for idempotency, repeated refreshes, and partial-failure resume behavior.

## Phase 3: Document Building And Summaries

- [x] Define the canonical thread document shape for issues and PRs.
- [x] Implement bot-author filtering and routine automation filtering for dedupe text.
- [x] Build normalized dedupe documents from title, body, selected metadata, and any hydrated human comments.
- [x] Implement summary generation jobs with OpenAI.
- [x] Persist multiple summary facets, including `dedupe_summary`.
- [x] Add rerun logic for stale or missing summaries based on content hash.
- [ ] Refine the canonical document now that sync is metadata-first by default.
- [ ] Decide which optional comment sources are worth hydrating for similarity quality:
  - maintainer comments only
  - non-bot comments only
  - top-N recent human comments only
- [ ] Add better bot/noise filtering for repo-specific automation accounts beyond generic `[bot]` detection.
- [ ] Testing goal: add golden document-builder fixtures that prove important human context is kept while bot noise is dropped.

## Phase 4: Embeddings And Similarity Search

- [x] Implement embedding generation with `text-embedding-3-small` by default.
- [x] Persist embeddings in SQLite first.
- [x] Implement exact cosine similarity search in process.
- [x] Add `embed` and `search` CLI commands.
- [ ] Measure local performance on a realistic fixture corpus and capture the numbers in docs.
- [ ] Add retry/batching observability around embeddings and summaries so long runs are easier to operate.
- [ ] Design a clean backend abstraction if we later want to swap exact local search with OpenSearch-backed ANN.
- [ ] Testing goal: expand embedding job tests to cover retries, batching behavior, and unchanged-row skips more explicitly.

Decision note:

- this phase is the primary kNN path for the foreseeable future
- do not block on Docker, OpenSearch, Lucene, or Faiss

## Phase 5: OpenSearch Evaluation And Optional Backend

- [ ] Add a local recipe for OpenSearch 3.3 only if local exact search is proven inadequate.
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

- [x] Implement a first clustering pass based on nearest-neighbor edges plus connected components.
- [x] Persist similarity edges, clusters, and cluster members.
- [x] Add `cluster` CLI command.
- [ ] Tune similarity thresholds and metadata boosts using real repo output.
- [ ] Improve representative-thread selection and cluster explanation quality.
- [ ] Decide whether issue-to-PR clustering needs different thresholds than issue-to-issue and PR-to-PR.
- [ ] Test on a real or sanitized fixture corpus to inspect false positives and false negatives.
- [ ] Testing goal: add golden cluster fixtures proving known related threads end up together.

## Phase 6.5: Maintainer Decision Analysis

- [ ] Add a reusable decision-analysis layer above clusters and semantic neighbors.
- [ ] Introduce a seed-centric `analyze-pr` style workflow for explicit maintainer decisions.
- [ ] Reuse a shared score/explanation model instead of duplicating logic across CLI, report, and API surfaces.
- [ ] Split retrieval provenance from decision role so candidates can say how they were found separately from what decision they received.
- [ ] Define explicit first-pass roles such as `best_base`, `same_cluster_candidate`, `superseded_candidate`, and `excluded_neighbor`, with role eligibility depending on thread kind.
- [ ] Keep the first iteration read-only against the latest local snapshot, with freshness coming from the existing explicit `refresh` or `sync -> embed -> cluster` pipeline rather than hidden live fetches during scoring.
- [ ] Add small golden fixtures early so score tuning and role classification have regression protection from the first implementation.
- [ ] Keep the first iteration additive: no cluster-model replacement and no storage redesign required.
- [ ] If persisted later, store decision artifacts in adjacent decision tables rather than cluster snapshots.
- [ ] Track the target shape in `docs/designs/maintainer-decision-layer.md`.

## Phase 7: API And Future UI

- [x] Implement local API endpoints for health, repositories, threads, search, clusters, and rerun actions.
- [x] Keep the HTTP API hosted in-process by the CLI rather than as a separate daemon.
- [x] Preserve package boundaries so future web code stays HTTP-only and does not import `api-core`.
- [ ] Add any missing read endpoints we want before UI work:
  - neighbors
  - run history
  - thread detail with summaries and optional hydrated comments
- [ ] Build the deferred Vite web app only after the API shape settles.
- [ ] Use `shadcn/ui` primitives with a custom visual system rather than stock styling.
- [ ] Add filters for repo, item type, state, label, and cluster size.
- [ ] Add detail panels that show raw text, summaries, nearest neighbors, and cluster membership.
- [ ] Add a search view with keyword, semantic, and hybrid modes.
- [ ] Add status indicators for sync freshness and model/index freshness.
- [ ] Testing goal: UI smoke tests prove the main list, detail, and search views render from seeded local data.

## Phase 8: Hardening

- [x] Persist run-history tables for sync, summarize, embed, and cluster.
- [ ] Add more structured logs and progress summaries for summarize, embed, and cluster.
- [ ] Add failure recovery for partial enrichment runs.
- [ ] Add export/report helpers for maintainers to share cluster results.
- [ ] Revisit model defaults and prompt budget after real data review.
- [ ] Decide whether per-repo config files are needed.
- [ ] Add database maintenance helpers:
  - vacuum/cleanup
  - prune stale summaries/embeddings
  - optional reset commands scoped by repo
- [ ] Testing goal: end-to-end local workflow test covers `doctor`, `sync`, `summarize`, `embed`, `cluster`, and `serve`.

## Immediate Next Focus

- [ ] Run a real full open-only crawl against `openclaw/openclaw` and inspect what the current metadata-first corpus looks like.
- [ ] Review search quality on real examples before spending more tokens on broad summarization/embedding runs.
- [ ] Decide whether default dedupe quality is good enough from title/body/labels alone, or whether we need selective comment hydration.
- [ ] Add progress output for summarize, embed, and cluster similar to sync.
- [ ] Capture a short operator guide for “full crawl vs filtered crawl vs include-comments crawl”.

## Recommended Execution Order

- [x] Finish bootstrap and config first.
- [x] Prove GitHub sync into SQLite before any UI work.
- [x] Prove document building before embeddings.
- [x] Prove exact local similarity before OpenSearch.
- [ ] Tune clustering quality before polishing the UI.
