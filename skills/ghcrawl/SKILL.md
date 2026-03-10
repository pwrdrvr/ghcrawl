---
name: ghcrawl
description: "Use a local ghcrawl install to refresh GitHub repo data, inspect duplicate clusters, and dump issue/PR summaries from the local SQLite dataset. Use when a user wants to triage related issues or PRs, inspect semantic clusters, or refresh one repo through ghcrawl's staged pipeline."
allowed-tools: Bash(ghcrawl:*), Bash(gitcrawl:*), Bash(pnpm:*), Read(*)
---

# ghcrawl

Use `ghcrawl` as the machine-facing interface for local GitHub duplicate-cluster analysis.

Do not scrape the TUI. Prefer JSON CLI output.

## When to use this skill

- The user wants related issue/PR clusters for one repo.
- The user wants to refresh local ghcrawl data before analysis.
- The user wants cluster summaries, cluster detail dumps, or nearest neighbors from a local ghcrawl database.

## Command preference

Prefer the installed `ghcrawl` bin.

If `ghcrawl` is not on `PATH`, try `gitcrawl`. If neither is on `PATH`, use:

```bash
pnpm --filter ghcrawl cli ...
```

## Core workflow

### 1. Check local health

Run:

```bash
ghcrawl doctor --json
```

If the bin is unavailable, fall back to:

```bash
pnpm --filter ghcrawl cli doctor --json
```

### 2. Refresh local data when needed

Use the staged pipeline command:

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

### 3. List clusters

Use:

```bash
ghcrawl clusters owner/repo --min-size 10 --limit 20 --sort recent
```

This returns:

- repo stats
- freshness state
- cluster summaries

### 4. Inspect one cluster

Use:

```bash
ghcrawl cluster-detail owner/repo --id 123 --member-limit 20 --body-chars 280
```

This returns:

- the selected cluster summary
- each member thread
- a body snippet
- stored summary fields when present

### 5. Optional deeper inspection

Use search or neighbors as needed:

```bash
ghcrawl search owner/repo --query "download stalls" --mode hybrid
ghcrawl neighbors owner/repo --number 42 --limit 10
```

## Output rules

- Report the repo name and whether you refreshed data in this run.
- When listing clusters, include:
  - cluster id
  - display title
  - total size
  - PR count
  - issue count
  - latest updated time
- When drilling into a cluster, include clickable GitHub links for each issue/PR if you mention them.
- Prefer concise summaries over dumping raw JSON.
- If freshness is stale, say that explicitly:
  - embeddings outdated
  - clusters outdated

## References

For the exact JSON-oriented command surface and examples, read:

- [references/protocol.md](references/protocol.md)
