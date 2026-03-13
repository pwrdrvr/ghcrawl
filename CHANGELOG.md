# Changelog

## v0.6.0 - 2026-03-12

### Highlights

- Added a jump-to-thread prompt in the TUI so maintainers can move directly to a specific thread.
- Moved TUI refresh work into background jobs so the interface stays responsive during updates.
- Added a bundled release skill to make tag-driven GitHub releases easier to plan and publish. Thanks @huntharo (#12)

### Performance

- Reduced the amount of work needed to build exact cluster edges for larger datasets.
- Parallelized exact cluster edge building so local analysis finishes faster.

### Fixes

- Fixed the PR comment workflow permissions so automated PR comments can post reliably. Thanks @huntharo (#9)

### Docs

- Linked the docs directly to embeddings pricing details for quicker operator lookup.
- Documented how to trace a thread back to its cluster JSON output.
- Clarified the ghcrawl skill CLI guidance for local workflows. Thanks @huntharo (#6)

### Internal

- Added a benchmark for cluster performance coverage. Thanks @huntharo (#8)
- Refreshed environment-related repository setup.
