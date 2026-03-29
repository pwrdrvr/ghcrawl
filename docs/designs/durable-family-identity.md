# Durable Family Identity

## Purpose

This document defines the storage and identity model needed to make cluster identity durable across reruns.

The core problem is simple:

- cluster rebuilds are currently valid as local grouping runs
- but a run-local `clusters.id` is not a durable maintainer-facing identity
- unchanged families must retain identity across reruns

This document proposes a stable `family_id` layer above run-local cluster rows.

## Problem Statement

A local cluster rebuild produces a fresh set of `clusters` rows on every run.

That is acceptable for:

- run-local storage
- transient similarity edges
- rebuild internals

It is not acceptable for:

- visible maintainer-facing cluster identity
- durable links between reruns
- explanations such as "this is the same family as before"

The visible identity contract must not depend on a newly inserted row id.

## Design Goal

The durable identity contract should satisfy all of the following:

- unchanged families keep the same visible identity across reruns
- changed families retain lineage to the previous visible identity
- unrelated families do not churn when a local change affects only part of the repo
- family identity remains separate from maintainer decision scoring

## Layer Model

The architecture should be split into four layers:

1. retrieval layer
2. family identity layer
3. snapshot and lineage layer
4. maintainer decision layer

### Retrieval Layer

Purpose:

- collect nearby candidates with high recall

Examples:

- semantic neighbors
- linked issue overlap
- path overlap
- exact family members from prior state

This layer should not own durable identity.

### Family Identity Layer

Purpose:

- define the visible maintainer-facing identity for a family

The visible identity should be `family_id`, not `clusters.id`.

This is the layer that must remain stable across reruns.

### Snapshot And Lineage Layer

Purpose:

- store per-run snapshots of family membership
- connect current families back to previous families

This layer answers:

- unchanged
- updated
- new
- dissolved
- later: split
- later: merged

### Maintainer Decision Layer

Purpose:

- rank and classify family members for maintainer action

Examples:

- `best_base`
- `same_family_candidate`
- `superseded_candidate`
- `excluded_neighbor`

This layer should consume family identity and retrieval evidence. It should not be coupled into the storage identity contract.

## Identity Contract

### Run-local ids

`clusters.id` may remain a run-local row id.

That id is allowed to change every rebuild.

It must not be the visible maintainer-facing family identity.

### Durable visible id

Introduce `family_id` as the canonical visible identity.

Rules:

- `family_id` is created once for a new family
- `family_id` is inherited by unchanged or updated families on later reruns
- UI, API, and reports should prefer `family_id`

## Initial Family Identity Strategy

### Linked-issue families

Linked-issue families can start with a deterministic canonical identity.

For example:

- sorted linked issue set
- repository-scoped canonical family key

This gives a strong and cheap first source of stable identity.

### Semantic-only families

Semantic-only families should not use a fresh row id and should not rely only on the current member set as their long-term identity contract.

Instead:

- compare current family snapshots against previous family snapshots
- inherit previous `family_id` when the family is judged to be the same continuation
- allocate a new `family_id` only when no suitable previous family matches

## Storage Proposal

The exact schema can vary, but the minimum durable model needs:

### `families`

One row per durable family identity.

Suggested fields:

- `id`
- `repo_id`
- `basis`
- `created_at`
- `retired_at`

### `family_snapshots`

One row per family per snapshot run.

Suggested fields:

- `id`
- `family_id`
- `repo_id`
- `snapshot_run_id`
- `representative_thread_id`
- `member_thread_ids`
- `member_count`
- `basis`
- `created_at`

### `family_transitions`

Lineage and transition classification between reruns.

Suggested fields:

- `id`
- `repo_id`
- `snapshot_run_id`
- `family_id`
- `previous_family_id`
- `transition_type`
- `similarity_score`
- `created_at`

## Transition Semantics

The first iteration needs only a small set of transitions:

- `unchanged`
- `updated`
- `new`
- `dissolved`

Later, if needed:

- `split`
- `merged`

The key point is not naming richness. The key point is that every changed family must have an explicit lineage explanation instead of silently changing visible identity.

## Matching Rule

The initial matching rule can remain simple:

- compare current and previous member sets
- compute Jaccard similarity
- greedily match highest score first above threshold

That is enough for a first durable family implementation.

The important requirement is what happens after matching:

- matched current family inherits previous `family_id`
- unmatched current family gets a new `family_id`
- unmatched previous family is marked `dissolved`

Without the inheritance step, the merge result is informational only and does not produce durable visible identity.

## Maintainer Decision Integration

Once family identity is durable, the maintainer decision layer should sit on top of it.

Recommended responsibilities:

- retrieval determines candidate recall
- family identity determines continuity across reruns
- maintainer scoring determines what action to take

This prevents three different concepts from being collapsed into one number or one row id.

## Acceptance Tests

### 1. No-op rerun

Test:

- run clustering
- rerun clustering on the same DB with the same data

Expected result:

- unchanged family membership: `100%`
- unchanged visible `family_id` retention: `100%`

### 2. Incremental rerun

Test:

- run clustering on snapshot A
- sync to snapshot B in the same DB
- rerun clustering

Expected result:

- unchanged families keep `family_id`
- unrelated family churn is near zero
- changed families receive explicit lineage transitions

### 3. Synthetic fixture coverage

Fixture scenarios:

- unchanged family
- add one member to family
- split one family into two
- merge two families into one

Expected result:

- transition types are correct
- `family_id` inheritance is correct

## Success Criteria

The durable identity implementation is ready only if all of the following are true:

- no-op rerun keeps visible family identity stable
- incremental rerun preserves identity for unchanged families
- transition lineage is explicit and machine-readable
- maintainer-facing outputs no longer depend on run-local `clusters.id`

## Non-Goals

- not a replacement for the retrieval pipeline
- not a replacement for cluster scoring or maintainer ranking
- not a requirement to finalize split and merge semantics in v1
- not a requirement to redesign embeddings or storage wholesale

## Recommended Delivery Order

1. introduce `family_id`
2. stop exposing raw `clusters.id` as the visible family identity
3. persist snapshot lineage
4. pass the no-op rerun test
5. pass the incremental rerun test
6. layer maintainer decision outputs on top

## Bottom Line

The durable identity problem is not solved by storing snapshots alone.

It is solved only when:

- current families are matched to previous families
- matched families inherit the same visible identity
- unchanged families no longer churn on rerun

That is the minimum contract required for a durable family implementation.
