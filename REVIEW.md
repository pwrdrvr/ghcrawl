# Gitcrawl Review

## Findings

### P1: The TUI is not a true primary workflow yet

The main product surface is still CLI-first, not TUI-first. `tui` requires `owner/repo` on the command line in [apps/cli/src/main.ts](/Users/huntharo/github/gitcrawl/apps/cli/src/main.ts), so a maintainer cannot simply open the app and pick from locally-known repos. Inside the TUI, the in-app jobs only cover sync and embedding in [apps/cli/src/tui/app.ts](/Users/huntharo/github/gitcrawl/apps/cli/src/tui/app.ts), but not clustering, which means the user still has to leave the TUI to finish the normal workflow after fresh data arrives. This is the biggest “would I want to use this” gap.

### P1: Unescaped GitHub content can corrupt the detail pane

The detail pane enables Blessed tags in [apps/cli/src/tui/app.ts](/Users/huntharo/github/gitcrawl/apps/cli/src/tui/app.ts), and then interpolates raw issue/PR titles, bodies, summaries, and neighbor titles in `renderDetailPane()`. GitHub text is untrusted display input; sequences like `{bold}` or `{red-fg}` can be interpreted as Blessed markup and break rendering. This is a real correctness bug on user content, not just polish.

### P2: The HTTP API collapses user errors into 500s

The API server catches everything and returns `500` in [packages/api-core/src/api/server.ts](/Users/huntharo/github/gitcrawl/packages/api-core/src/api/server.ts). Missing params, malformed JSON, and schema validation problems should not come back as server faults. This will make any future web UI or external local client harder to build and debug.

### P2: The exposed CLI surface is larger than the documented product

The public docs now focus on sync/embed/cluster/search/TUI, but the CLI still exposes `summarize` and `purge-comments` in [apps/cli/src/main.ts](/Users/huntharo/github/gitcrawl/apps/cli/src/main.ts) and the root package still has a `summarize` script in [package.json](/Users/huntharo/github/gitcrawl/package.json). That may be fine if they are intentionally advanced commands, but right now it reads as an unresolved product-boundary decision.

### P3: Secrets are stored in plaintext config

The config file is at `~/.config/gitcrawl/config.json` and is written with restrictive file permissions, which is better than a repo-local `.env.local`. It is still plaintext storage. For a local-first maintainer tool this is acceptable for now, but it should be called out explicitly as a security tradeoff and eventually upgraded to OS keychain-backed storage if this becomes a broadly distributed tool.

## Strengths

- The local-first architecture is coherent: SQLite as the canonical store, direct CLI/TUI access, and clear package boundaries.
- The GitHub sync path now has useful backoff and operator-facing progress.
- The exact local vector path is a good pragmatic choice for the current scale.
- The TUI is already valuable for browsing clusters once data exists.

## Recommended Work List

- [x] Make `gitcrawl tui` work without a repo argument by adding a repo picker from locally-known repositories.
- [x] Add an in-TUI cluster refresh action so the app can complete sync -> embed -> cluster without dropping back to the shell.
- [x] Escape Blessed tags in all user-provided text rendered into the detail pane.
- [x] Return 4xx for malformed request bodies and validation failures in the local HTTP API.
- [x] Decide whether `summarize` and `purge-comments` are advanced supported commands or internal maintenance commands, then align help/scripts/docs accordingly.
- [x] Add a cold-start onboarding flow in the TUI for repos with no local data yet.
- [ ] Consider keychain-backed secret storage for macOS/Linux/Windows as a future security upgrade.
