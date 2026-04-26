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
- Persistent `vectorlite` sidecar search is the active kNN plan.
- OpenSearch is explicitly deferred; it is not on the supported runtime path.
- Sync is metadata-first and open-focused, with stale-open closure reconciliation on full unfiltered crawls.
- Sync is metadata-only by default.
- `sync --include-comments` is optional deeper hydration, not the default path.
- Filtered crawls like `--limit` and `--since` do not perform stale-open reconciliation.
- Durable cluster identities are canonical. Maintainer overrides are sticky and must survive reclustering.
- Portable git-sync exports are the supported way to share compact state. The live DB is a cache and is intentionally not sync-friendly.

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
- [x] Add a persisted runtime config file for model, embedding, vector, and per-repo TUI preferences.
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
- [x] Persist durable sync checkpoints for full scans and overlapping closure sweeps.
- [ ] Decide whether to persist GitHub ETags or GraphQL cursors for cheaper refreshes.
- [ ] Add a dedicated `refresh-closed` or equivalent command only if overlap/direct reconciliation becomes too slow on large repos.
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

- [x] Implement embedding generation with OpenAI embeddings.
- [x] Move active vectors to one vector per open thread.
- [x] Persist active vectors in a repository-scoped `vectorlite` sidecar instead of the main SQLite DB.
- [x] Keep legacy SQLite embedding rows as migration input only, then purge rebuildable vector payloads.
- [x] Implement vector search and neighbor lookup through `vectorlite`.
- [x] Add `embed` and `search` CLI commands.
- [x] Add retry/batching recovery around oversized embedding inputs.
- [x] Add tests for batching, unchanged-row skips, closed-vector pruning, corrupted sidecar rebuild, and retry shrink behavior.
- [ ] Capture current large-repo timing numbers in docs from the latest `openclaw/openclaw` run.
- [ ] Keep the vector store interface narrow enough that a future backend can be swapped without leaking raw SQL into service code.

Decision note:

- `vectorlite` sidecar search is the primary kNN path for the foreseeable future
- do not block normal operation on Docker, OpenSearch, Lucene, or Faiss

## Phase 5: OpenSearch Evaluation And Optional Backend

- [ ] Add a local recipe for OpenSearch 3.3 only if `vectorlite` search is proven inadequate.
- [ ] Implement OpenSearch index creation using `knn_vector`.
- [ ] Start with Lucene/HNSW as the default OpenSearch backend.
- [ ] Support metadata filters in vector search.
- [ ] Add a smoke test for indexing and kNN query execution.
- [ ] Evaluate whether Faiss adds real value for this corpus before implementing it.
- [ ] Testing goal: one integration test suite can run against an ephemeral local OpenSearch instance.

Decision note:

- this phase is explicitly deferred
- only start it after the supported `vectorlite` sidecar path is measured and shown to be insufficient

## Phase 6: Clustering

- [x] Implement a first clustering pass based on nearest-neighbor edges plus connected components.
- [x] Persist similarity edges, clusters, and cluster members.
- [x] Add `cluster` CLI command.
- [x] Add deterministic fingerprints based on normalized text, MinHash/SimHash-style signals, linked refs, files, module buckets, and hunk signatures.
- [x] Make clustering work without embeddings or LLM summaries; model output only enriches the evidence.
- [x] Add durable cluster governance: stable slugs, aliases, manual include/exclude/canonical overrides, merge, split, and close.
- [x] Tune thresholds and metadata/file/LLM weights against real `openclaw/openclaw` output.
- [x] Preserve closed and manually closed clusters in operator views by default.
- [ ] Keep refining representative-thread selection and cluster explanation quality.
- [ ] Add a small golden fixture suite for known true-positive and false-positive clusters.

## Phase 7: API, TUI, And Future Web UI

- [x] Implement local API endpoints for health, repositories, threads, search, clusters, and rerun actions.
- [x] Keep the HTTP API hosted in-process by the CLI rather than as a separate daemon.
- [x] Preserve package boundaries so future web code stays HTTP-only and does not import `api-core`.
- [x] Add read endpoints and service methods for neighbors, run history, thread detail, cluster detail, durable clusters, and cluster evidence.
- [x] Build the local TUI as the primary V1 browsing UI.
- [x] Add TUI support for stable cluster names, closed-member display, markdown-ish detail previews, right-click menus, copy/open actions, pane focus, mouse selection, and per-repo preferences.
- [ ] Build the deferred Vite web app only after the API shape settles.
- [ ] Use `shadcn/ui` primitives with a custom visual system rather than stock styling.
- [ ] Add filters for repo, item type, state, label, and cluster size.
- [x] Add TUI detail panels that show thread metadata, LLM key summaries, top files, main preview, links, and cluster membership.
- [ ] Add a search view with keyword, semantic, and hybrid modes.
- [ ] Add status indicators for sync freshness and model/index freshness.
- [ ] Testing goal: UI smoke tests prove the main list, detail, and search views render from seeded local data.

## Phase 8: Hardening

- [x] Persist run-history tables for sync, summarize, embed, and cluster.
- [x] Add structured progress summaries for sync, embed, cluster, refresh, and storage optimization.
- [x] Add recovery behavior for partial enrichment runs through content hashes, current vector metadata, and sidecar rebuild.
- [x] Add export/report helpers for maintainers to share cluster results and compact portable state.
- [ ] Revisit model defaults and prompt budget after real data review.
- [x] Add per-repo persisted TUI preferences.
- [x] Add database maintenance helpers:
  - vacuum/cleanup
  - WAL checkpoints
  - planner stats refresh
  - vector sidecar maintenance
- [x] Add portable git-sync commands:
  - `export-sync`
  - `validate-sync`
  - `portable-size`
  - `sync-status`
  - `import-sync`
- [ ] Testing goal: end-to-end local workflow test covers `doctor`, `sync`, `summarize`, `embed`, `cluster`, and `serve`.

## Immediate Next Focus

- [x] Run real large `openclaw/openclaw` crawls, embeddings, summaries, clustering, closure refreshes, and storage optimization.
- [x] Tune cluster quality on real output and validate in the TUI.
- [x] Capture operator docs for refresh, manual pipeline control, closed clusters, durable overrides, portable git-sync export, and optimize.
- [ ] Finish service decomposition so `service.ts`, `apps/cli/src/main.ts`, and `apps/cli/src/tui/app.ts` stay small enough to maintain.
- [x] Add focused tests around portable import conflict handling and sync drift reporting.
- [ ] Add a release-readiness pass for packaged `vectorlite` installs across supported Node versions.

## Recommended Execution Order

- [x] Finish bootstrap and config first.
- [x] Prove GitHub sync into SQLite before any UI work.
- [x] Prove document building before embeddings.
- [x] Prove exact local similarity before OpenSearch.
- [x] Tune clustering quality before polishing the TUI.
- [ ] Keep refactoring service/TUI/CLI command surfaces in small commits until the core files stop carrying unrelated responsibilities.
