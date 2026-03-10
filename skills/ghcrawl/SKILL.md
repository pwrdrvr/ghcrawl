---
name: ghcrawl
description: "Use a local ghcrawl install to refresh GitHub repo data, inspect duplicate clusters, and dump issue/PR summaries from the local SQLite dataset. Use when a user wants to triage related issues or PRs, inspect semantic clusters, or refresh one repo through ghcrawl's staged pipeline."
allowed-tools: Bash(ghcrawl:*), Bash(pnpm:*), Read(*)
---

# ghcrawl

Use `ghcrawl` as the machine-facing interface for local GitHub duplicate-cluster analysis.

Do not scrape the TUI. Prefer JSON CLI output.

The skill has two modes:

- Default mode: assume there are no valid API keys and stay read-only.
- API-enabled mode: only after `ghcrawl doctor --json` proves GitHub and OpenAI auth are configured and healthy.

Even in API-enabled mode, never run `sync`, `embed`, `cluster`, or `refresh` unless the user explicitly asks for that work. Those commands can take a long time, consume paid API usage, and trigger rate limiting if used too often.

Also never run `close-thread` or `close-cluster` unless the user explicitly asks you to mark a local thread or cluster closed.

## When to use this skill

- The user wants related issue/PR clusters for one repo.
- The user wants to refresh local ghcrawl data before analysis.
- The user wants cluster summaries, cluster detail dumps, or nearest neighbors from a local ghcrawl database.

## Command preference

Prefer the installed `ghcrawl` bin.

If `ghcrawl` is not on `PATH`, use:

```bash
npx ghcrawl cli ...
```

## Core workflow

### 1. Default read-only flow

Do not run `doctor` on skill startup by default.

Start with local read-only commands:

Without explicit user direction to refresh data, prefer these local-only commands:

```bash
ghcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent
ghcrawl cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280
ghcrawl threads owner/repo --numbers 42,43,44
ghcrawl author owner/repo --login lqquan
ghcrawl search owner/repo --query "download stalls" --mode hybrid
ghcrawl neighbors owner/repo --number 42 --limit 10
```

These operate on the existing local SQLite dataset.

By default:

- `threads` and `author` hide locally closed issues/PRs
- `clusters` and `cluster-detail` hide locally closed clusters

If the user explicitly wants to inspect those records, add `--include-closed`.

Use `threads --numbers ...` when you need a batch of specific issue/PR records. Do not pay the CLI startup cost 10 times for 10 separate single-thread lookups.

Use `author --login ...` when you need one author's open threads and their strongest stored same-author similarity matches in one call.

If the user explicitly asks to mark a local issue/PR or cluster closed, use:

```bash
ghcrawl close-thread owner/repo --number 42
ghcrawl close-cluster owner/repo --id 123
```

If `close-thread` closes the last open item in a cluster, ghcrawl will automatically mark that cluster closed too.

### 2. Check local health only when needed

Run:

```bash
ghcrawl doctor --json
```

If the bin is unavailable, fall back to:

```bash
pnpm --filter ghcrawl cli doctor --json
```

Only do this when:

- the user explicitly wants an API-backed operation such as `refresh`, `sync`, `embed`, or `cluster`
- or a read-only request failed and you need to know whether the local install/config/auth state is broken

Interpret the result like this:

- If GitHub/OpenAI auth is missing or unhealthy, stay in read-only mode.
- If GitHub/OpenAI auth is healthy, API-backed operations are available, but still require explicit user direction.

### 3. Refresh local data only when explicitly requested

Only if the user explicitly asks to refresh or rebuild data, and doctor says auth is healthy, use:

```bash
ghcrawl refresh owner/repo
```

This runs, in fixed order:

1. GitHub sync/reconcile
2. embed refresh
3. cluster rebuild

You may skip steps only when the user explicitly wants that or the freshness state makes it unnecessary:

```bash
ghcrawl refresh owner/repo --no-sync
ghcrawl refresh owner/repo --no-cluster
```

Do not decide on your own to run `cluster` just because it is local-only. It is still long-running and should be treated as an explicit user-directed operation.

### 4. List clusters

Use:

```bash
ghcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent
```

This returns:

- repo stats
- freshness state
- cluster summaries

### 5. Inspect one cluster

Use:

```bash
ghcrawl cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280
```

This returns:

- the selected cluster summary
- each member thread
- a body snippet
- stored summary fields when present

### 6. Optional deeper inspection

Use search or neighbors as needed:

```bash
ghcrawl search owner/repo --query "download stalls" --mode hybrid
ghcrawl neighbors owner/repo --number 42 --limit 10
```

## Output rules

- Report the repo name and whether you refreshed data in this run.
- When listing clusters, include:
  - cluster id
  - representative number and kind
  - display title
  - total size
  - PR count
  - issue count
  - latest updated time
- When naming a cluster in prose, use this shape:
  - `Cluster <clusterId> (#<representativeNumber> representative <issue|pr>)`
  - example: `Cluster 23945 (#42035 representative issue)`
- When drilling into a cluster, include clickable GitHub links for each issue/PR if you mention them.
- Prefer concise summaries over dumping raw JSON.
- If freshness is stale, say that explicitly:
  - embeddings outdated
  - clusters outdated
- If you stayed read-only because doctor was not healthy or the user did not explicitly request a refresh, say that explicitly.

## References

For the exact JSON-oriented command surface and examples, read:

- [references/protocol.md](references/protocol.md)
