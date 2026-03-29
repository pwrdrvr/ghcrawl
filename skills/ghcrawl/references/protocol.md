# ghcrawl Protocol

Use the JSON CLI surface. Do not parse the TUI.

Do not query the ghcrawl SQLite database directly with `sqlite3`, `pragma`, or ad hoc SQL. If the supported CLI cannot answer a read-only question, report the CLI problem to the user instead of bypassing the interface.

Do not start with `ghcrawl --help` or `<subcommand> --help`. Use the command surface documented here unless the user explicitly asked about CLI syntax or you are maintaining ghcrawl itself. If syntax is genuinely uncertain while maintaining `ghcrawl`, use `ghcrawl help <command>` or `ghcrawl <command> --help`.

## Commands

### `ghcrawl doctor --json`

Health and auth smoke check.

Use this only when needed. Treat the result as a gate:

- If GitHub/OpenAI auth is missing or unhealthy, stay read-only.
- If GitHub/OpenAI auth is healthy, API-backed commands are available, but still require explicit user direction.

Do not call this automatically on every skill invocation. Use it when:

- the user explicitly asked for API-backed work
- or a read-only request failed and local setup/auth may be the reason

If the user asked only for read-only analysis, missing auth is not itself a blocker. Work from the existing local dataset through the CLI.

### `ghcrawl threads owner/repo --numbers <n,n,...> --json`

Bulk read path for specific issue/PR numbers from the local DB.

Use this when you need several specific thread records in one invoke instead of running one CLI call per number.

For a single issue/PR number, this is also the direct JSON path to answer:

- "which cluster is #12345 in?"

The returned `thread` objects include:

- `clusterId`

If `clusterId` is non-null, follow with:

- `ghcrawl cluster-detail owner/repo --id <clusterId>`

Useful flags:

- `--numbers 42,43,44`
- `--kind issue|pull_request`
- `--include-closed`

### `ghcrawl author owner/repo --login <user> --json`

Bulk read path for all open issue/PR records from one author in the local DB.

Use this when you want to inspect a user's open items together and see the strongest stored same-author similarity match for each item.

Useful flags:

- `--include-closed`

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

### `ghcrawl clusters owner/repo --json`

Useful flags:

- `--min-size <count>`
- `--limit <count>`
- `--sort recent|size`
- `--search <text>`
- `--include-closed`

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

When reporting a cluster to the user, do not mention only the cluster id. Use:

- `Cluster <clusterId> (#<representativeNumber> representative <issue|pr>)`

Examples:

- `Cluster 23945 (#42035 representative issue)`
- `Cluster 104 (#38112 representative pr)`

This is the normal read-only exploration command for existing local data.

By default it hides locally closed clusters.

### `ghcrawl cluster-detail owner/repo --id <cluster-id> --json`

Useful flags:

- `--member-limit <count>`
- `--body-chars <count>`
- `--include-closed`

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

By default this hides locally closed clusters; use `--include-closed` when the user explicitly wants them.

### `ghcrawl close-thread owner/repo --number <thread-number> --json`

Marks one local issue/PR closed without waiting for the next GitHub sync.

Use this only when the user explicitly asked to mark that thread closed locally.

If that thread was the last open member of its cluster, ghcrawl also marks the cluster closed locally.

### `ghcrawl close-cluster owner/repo --id <cluster-id> --json`

Marks one cluster closed locally.

Use this only when the user explicitly asked to suppress that cluster from default JSON exploration.

### `ghcrawl search owner/repo --query <text> --json`

Useful for semantic or keyword follow-up.

### `ghcrawl neighbors owner/repo --number <thread-number> --json`

Useful for inspecting nearest semantic matches for one thread.

## Fallback invocation

If `ghcrawl` is not installed globally:

```bash
pnpm --filter ghcrawl cli doctor --json
pnpm --filter ghcrawl cli threads owner/repo --numbers 12345 --json
pnpm --filter ghcrawl cli threads owner/repo --numbers 42,43,44 --json
pnpm --filter ghcrawl cli threads owner/repo --numbers 42,43,44 --include-closed --json
pnpm --filter ghcrawl cli author owner/repo --login lqquan --json
pnpm --filter ghcrawl cli refresh owner/repo
pnpm --filter ghcrawl cli clusters owner/repo --min-size 10 --limit 20 --sort recent --json
pnpm --filter ghcrawl cli clusters owner/repo --min-size 10 --limit 20 --sort recent --include-closed --json
pnpm --filter ghcrawl cli cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280 --json
pnpm --filter ghcrawl cli cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280 --include-closed --json
pnpm --filter ghcrawl cli close-thread owner/repo --number 42 --json
pnpm --filter ghcrawl cli close-cluster owner/repo --id 123 --json
```

If the supported CLI path still fails, hangs, or returns unusable output, stop and tell the user there is a ghcrawl CLI problem. Do not fall back to direct SQLite inspection.

## Suggested analysis flow

1. Start read-only with `clusters`, `cluster-detail`, `threads`, `author`, `search`, or `neighbors`
2. Only if API-backed work is needed or a read-only request failed, run `ghcrawl doctor --json`
3. If auth is unavailable, stay read-only
4. Only if doctor is healthy and the user explicitly asked, run `ghcrawl refresh owner/repo`
5. `ghcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent --json`
6. `ghcrawl cluster-detail owner/repo --id <cluster-id> --json`
7. optionally `threads`, `author`, `search`, or `neighbors` with `--json`
