# ghcrawl Protocol

Use the JSON CLI surface. Do not parse the TUI.

## Commands

### `ghcrawl doctor --json`

Health and auth smoke check.

### `ghcrawl refresh owner/repo`

Runs the staged pipeline in fixed order:

1. GitHub sync/reconcile
2. embeddings
3. clusters

Optional skips:

- `--no-sync`
- `--no-embed`
- `--no-cluster`

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
2. `ghcrawl refresh owner/repo`
3. `ghcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent`
4. `ghcrawl cluster-detail owner/repo --id <cluster-id>`
5. optionally `search` or `neighbors`
