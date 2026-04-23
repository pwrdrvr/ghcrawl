# Changelog

## v0.8.0-beta.2 - 2026-04-11

### Fixes

- Kept the TUI running when adding a new repository instead of exiting the session unexpectedly. Thanks @huntharo (#48)
- Bootstrapped `pnpm` during Codex environment setup so local automation can start more reliably.

### Internal

- Updated `dotenv` from `17.3.1` to `17.4.1`. Thanks @dependabot[bot] (#45)
- Updated `@clack/prompts` from `1.1.0` to `1.2.0`. Thanks @dependabot[bot] (#46)
- Updated `@types/node` from `24.12.0` to `24.12.2`. Thanks @dependabot[bot] (#47)

## v0.8.0-beta.1 - 2026-04-03

### Highlights

- Migrated ghcrawl to persistent Vectorlite-backed search and clustering so similarity data survives across runs and local analysis scales better. Thanks @huntharo (#7)
- Added more agent-friendly CLI help and a clearer JSON command contract for automation-oriented workflows. Thanks @huntharo (#37)

### Fixes

- Refreshed the cluster performance baseline so perf checks track the current search and clustering path. Thanks @huntharo (#39)

### Docs

- Added a `CLAUDE.md` link from `AGENTS.md` to make maintainer guidance easier to discover.

### Internal

- Updated `openai` from `6.32.0` to `6.33.0`. Thanks @dependabot[bot] (#40)

## v0.7.1 - 2026-03-28

### Fixes

- Stream neighbor embeddings during clustering work so memory usage stays bounded on larger runs. Thanks @obviyus (#36)

## v0.7.0 - 2026-03-24

### Highlights

- Reduced in-process cluster memory usage to prevent OOM crashes during larger refresh and clustering runs. Thanks @huntharo (#33)
- Added heap diagnostics for cluster runs so memory pressure is easier to inspect when a run gets large. Thanks @huntharo (#33)
- Added a configurable project-manager skill and repo-local tracker sync workflow. Thanks @huntharo (#22)
- Added prerelease publish support so beta tags map to GitHub prereleases and npm beta dist-tags. Thanks @huntharo (#34)

### Fixes

- Recover from oversized embedding inputs instead of failing the embed pass. Thanks @huntharo (#32)
- Fall back to in-process clustering when running from source without a built worker entrypoint. Thanks @huntharo (#28)
- Honor `--kind` filters passed through the CLI repo flags. Thanks @huntharo (#13)
- Restore CI dependency cache handling so exact cache hits skip redundant installs. Thanks @huntharo (#15)

### Internal

- Updated `openai` from `6.27.0` to `6.29.0`. Thanks @dependabot[bot] (#17)
- Updated `actions/upload-artifact` from `v4` to `v7`. Thanks @dependabot[bot] (#18)
- Updated `better-sqlite3` from `12.6.2` to `12.8.0`. Thanks @dependabot[bot] (#16)
- Updated `yaml` from `2.8.2` to `2.8.3`. Thanks @dependabot[bot] (#31)
- Updated `openai` from `6.29.0` to `6.32.0`. Thanks @dependabot[bot] (#30)
- Ignore local release planning artifacts in the working tree.

## v0.7.0-beta.1 - 2026-03-24

### Highlights

- Reduced in-process cluster memory usage to prevent OOM crashes during larger refresh and clustering runs. Thanks @huntharo (#33)
- Added heap diagnostics for cluster runs so memory pressure is easier to inspect when a run gets large. Thanks @huntharo (#33)
- Added a configurable project-manager skill and repo-local tracker sync workflow. Thanks @huntharo (#22)
- Added prerelease publish support so beta tags map to GitHub prereleases and npm beta dist-tags. Thanks @huntharo (#34)

### Fixes

- Recover from oversized embedding inputs instead of failing the embed pass. Thanks @huntharo (#32)
- Fall back to in-process clustering when running from source without a built worker entrypoint. Thanks @huntharo (#28)
- Honor `--kind` filters passed through the CLI repo flags. Thanks @huntharo (#13)
- Restore CI dependency cache handling so exact cache hits skip redundant installs. Thanks @huntharo (#15)

### Internal

- Updated `openai` from `6.27.0` to `6.29.0`. Thanks @dependabot[bot] (#17)
- Updated `actions/upload-artifact` from `v4` to `v7`. Thanks @dependabot[bot] (#18)
- Updated `better-sqlite3` from `12.6.2` to `12.8.0`. Thanks @dependabot[bot] (#16)
- Updated `yaml` from `2.8.2` to `2.8.3`. Thanks @dependabot[bot] (#31)
- Updated `openai` from `6.29.0` to `6.32.0`. Thanks @dependabot[bot] (#30)
- Ignore local release planning artifacts in the working tree.

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
