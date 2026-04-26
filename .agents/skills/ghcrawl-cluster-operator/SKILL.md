---
name: ghcrawl-cluster-operator
description: "Use when inspecting a ghcrawl SQLite store, pulling GitHub issue/PR data, refreshing summaries, embeddings, and clusters, or extracting one cluster and its evidence through the ghcrawl CLI."
---

# ghcrawl Cluster Operator

Use this skill when operating this repo's local-first GitHub crawler and cluster browser.

## Ground Rules

- Prefer read-only inspection commands first: `doctor`, `runs`, `clusters`, `cluster-explain`, `threads`.
- Treat `refresh`, `sync`, `summarize`, `key-summaries`, and `embed` as remote/API-spend commands.
- `cluster` is local-only but can be CPU-heavy on huge repos.
- `optimize` is local-only SQLite maintenance; run it after heavy sync, embedding, clustering, or close/archive sessions.
- Always pass `--json` for agent-readable output.
- Use `--include-code` only when file overlap matters; it hydrates PR file metadata and can increase DB size.

## Setup Check

```bash
ghcrawl doctor --json
ghcrawl configure --json
ghcrawl runs owner/repo --limit 10 --json
ghcrawl optimize owner/repo --json
```

If the local store is empty or stale, pull current open GitHub data:

```bash
ghcrawl sync owner/repo --limit 200 --json
ghcrawl sync owner/repo --include-code --limit 200 --json
```

For a normal end-to-end update:

```bash
ghcrawl refresh owner/repo --json
```

Use code hydration when file evidence should affect clustering:

```bash
ghcrawl refresh owner/repo --include-code --json
```

## LLM And Embedding Pipeline

Default clustering can run without LLM summaries. LLM summaries and embeddings enrich the cluster graph.

Useful configurations:

```bash
ghcrawl configure --summary-model gpt-5.4 --embedding-basis title_original --json
ghcrawl configure --summary-model gpt-5.4 --embedding-basis llm_key_summary --json
```

For structured key summaries:

```bash
ghcrawl key-summaries owner/repo --limit 200 --json
ghcrawl key-summaries owner/repo --number 12345 --json
```

Then refresh vectors and clusters:

```bash
ghcrawl embed owner/repo --json
ghcrawl cluster owner/repo --json
```

## Pull A Cluster And Its Info

List clusters:

```bash
ghcrawl clusters owner/repo --min-size 2 --limit 20 --sort size --json
ghcrawl clusters owner/repo --search "cron timeout" --limit 10 --json
```

Explain one durable cluster:

```bash
ghcrawl cluster-explain owner/repo --id 123 --member-limit 50 --event-limit 50 --json
```

Inspect current durable clusters with members:

```bash
ghcrawl durable-clusters owner/repo --member-limit 25 --json
ghcrawl durable-clusters owner/repo --include-inactive --member-limit 25 --json
```

Pull specific issues/PRs from the local store:

```bash
ghcrawl threads owner/repo --numbers 123,456,789 --json
```

Open the TUI:

```bash
ghcrawl tui owner/repo
```

## Local Maintainer Actions

Use these only when the operator asks for durable cluster edits:

```bash
ghcrawl exclude-cluster-member owner/repo --id 123 --number 456 --reason "not same root cause" --json
ghcrawl include-cluster-member owner/repo --id 123 --number 456 --reason "same root cause" --json
ghcrawl set-cluster-canonical owner/repo --id 123 --number 456 --reason "clearest report" --json
ghcrawl merge-clusters owner/repo --source 123 --target 456 --reason "same issue family" --json
```

After edits, re-run:

```bash
ghcrawl cluster owner/repo --json
ghcrawl cluster-explain owner/repo --id 123 --member-limit 50 --event-limit 50 --json
```

## Local Store Maintenance

Run maintenance after large data changes:

```bash
ghcrawl optimize owner/repo --json
```

Without `owner/repo`, `optimize` only checkpoints, analyzes, optimizes, and vacuums the main ghcrawl SQLite database. With `owner/repo`, it also optimizes that repo's vector SQLite store and reports the vector `.hnsw` sidecar size without rebuilding it.
