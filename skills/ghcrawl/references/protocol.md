# ghcrawl Protocol

Use the JSON CLI surface. Do not parse the TUI.

## Commands

### `ghcrawl doctor --json`

Health and auth smoke check.

Use this first. Treat the result as a gate:

- If GitHub/OpenAI auth is missing or unhealthy, stay read-only.
- If GitHub/OpenAI auth is healthy, API-backed commands are available, but still require explicit user direction.

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
pnpm --filter ghcrawl cli refresh owner/repo
pnpm --filter ghcrawl cli clusters owner/repo --min-size 10 --limit 20 --sort recent
pnpm --filter ghcrawl cli cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280
```

## Suggested analysis flow

1. `ghcrawl doctor --json`
2. If auth is unavailable or the user did not ask for refresh work, stay read-only and use `clusters`
3. Only if doctor is healthy and the user explicitly asked, run `ghcrawl refresh owner/repo`
4. `ghcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent`
5. `ghcrawl cluster-detail owner/repo --id <cluster-id>`
6. optionally `search` or `neighbors`
