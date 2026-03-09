# gitcrawl Protocol

Use the JSON CLI surface. Do not parse the TUI.

## Commands

### `gitcrawl doctor --json`

Health and auth smoke check.

### `gitcrawl refresh owner/repo`

Runs the staged pipeline in fixed order:

1. GitHub sync/reconcile
2. embeddings
3. clusters

Optional skips:

- `--no-sync`
- `--no-embed`
- `--no-cluster`

### `gitcrawl clusters owner/repo`

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

### `gitcrawl cluster-detail owner/repo --id <cluster-id>`

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

### `gitcrawl search owner/repo --query <text>`

Useful for semantic or keyword follow-up.

### `gitcrawl neighbors owner/repo --number <thread-number>`

Useful for inspecting nearest semantic matches for one thread.

## Fallback invocation

If `gitcrawl` is not installed globally:

```bash
pnpm --filter @gitcrawl/cli cli doctor --json
pnpm --filter @gitcrawl/cli cli refresh owner/repo
pnpm --filter @gitcrawl/cli cli clusters owner/repo --min-size 10 --limit 20 --sort recent
pnpm --filter @gitcrawl/cli cli cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280
```

## Suggested analysis flow

1. `doctor --json`
2. `refresh owner/repo`
3. `clusters owner/repo --min-size 10 --limit 20 --sort recent`
4. `cluster-detail owner/repo --id <cluster-id>`
5. optionally `search` or `neighbors`
