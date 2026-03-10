# ghcrawl Protocol

Use the JSON CLI surface. Do not parse the TUI.

## Commands

### `ghcrawl doctor --json`

Health and auth smoke check.

Use this first. Treat the result as a gate:

- If GitHub/OpenAI auth is missing or unhealthy, stay read-only.
- If GitHub/OpenAI auth is healthy, API-backed commands are available, but still require explicit user direction.

Do not call this automatically on every skill invocation. Use it when:

- the user explicitly asked for API-backed work
- or a read-only request failed and local setup/auth may be the reason

### `ghcrawl threads owner/repo --numbers <n,n,...>`

Bulk read path for specific issue/PR numbers from the local DB.

Use this when you need several specific thread records in one invoke instead of running one CLI call per number.

Useful flags:

- `--numbers 42,43,44`
- `--kind issue|pull_request`

### `ghcrawl refresh owner/repo`

Runs the staged pipeline in fixed order:

1. GitHub sync/reconcile
2. embeddings
3. clusters

Optional skips:

- `--no-sync`
- `--no-embed`
- `--no-cluster`

Do not run this unless the user explicitly asked for a refresh/rebuild.

### `ghcrawl clusters owner/repo`

Useful flags:

- `--min-size <count>`
- `--limit <count>`
- `--sort recent|size`
- `--search <text>`

Returns:

- `repository`
- `stats`
- `clusters[]`

Each cluster includes:

- `clusterId`
- `displayTitle`
- `totalCount`
- `issueCount`
- `pullRequestCount`
- `latestUpdatedAt`
- `representativeThreadId`
- `representativeNumber`
- `representativeKind`

This is the normal read-only exploration command for existing local data.

### `ghcrawl cluster-detail owner/repo --id <cluster-id>`

Useful flags:

- `--member-limit <count>`
- `--body-chars <count>`

Returns:

- `repository`
- `stats`
- `cluster`
- `members[]`

Each member includes:

- `thread`
- `bodySnippet`
- `summaries`

`summaries` may contain:

- `problem_summary`
- `solution_summary`
- `maintainer_signal_summary`
- `dedupe_summary`

### `ghcrawl search owner/repo --query <text>`

Useful for semantic or keyword follow-up.

### `ghcrawl neighbors owner/repo --number <thread-number>`

Useful for inspecting nearest semantic matches for one thread.

## Fallback invocation

If `ghcrawl` is not installed globally:

```bash
pnpm --filter ghcrawl cli doctor --json
pnpm --filter ghcrawl cli threads owner/repo --numbers 42,43,44
pnpm --filter ghcrawl cli refresh owner/repo
pnpm --filter ghcrawl cli clusters owner/repo --min-size 10 --limit 20 --sort recent
pnpm --filter ghcrawl cli cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280
```

## Suggested analysis flow

1. Start read-only with `clusters`, `cluster-detail`, `threads`, `search`, or `neighbors`
2. Only if API-backed work is needed or a read-only request failed, run `ghcrawl doctor --json`
3. If auth is unavailable, stay read-only
4. Only if doctor is healthy and the user explicitly asked, run `ghcrawl refresh owner/repo`
5. `ghcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent`
6. `ghcrawl cluster-detail owner/repo --id <cluster-id>`
7. optionally `threads`, `search`, or `neighbors`
