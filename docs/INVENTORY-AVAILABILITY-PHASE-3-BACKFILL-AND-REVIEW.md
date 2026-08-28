# Inventory Availability Phase 3 Backfill And Review

## Purpose And Boundary

Phase 3 converts current catalog strategy and recipe evidence into deterministic,
inactive transformation-model drafts, gives operators a complete review queue, and
previews how canonical ATP would flow through the current channel-allocation rules.

This phase does not activate a transformation model, change runtime ATP authority,
create or release a reservation/claim, run a build, adjust physical inventory, edit
channel policy, invoke a provider adapter, or publish a quantity. Legacy
`inventory_strategy` remains the operational authority.

Implementation baseline: deployed `origin/main` merge commit
`54a09250512053379becbce958f63fea671a9614` (PR #1286).

## Deterministic Classification Contract

The algorithm identifier is `inventory_availability_backfill_v1`. Its source is one
repeatable-read capture of every active product, active variant, and current active
recipe/component snapshot. Source arrays are normalized before hashing.

Each active product is classified as follows:

| Legacy strategy | Candidate | Required review behavior |
| --- | --- | --- |
| `physical_only` | `exact_only` with no package paths | Physical inventory promises only its exact SKU |
| `physical_fungible` | `legacy_fungible_directed_pool` | Create two explicit directions between each adjacent package size; review every direction |
| `recipe_managed` | `recipe_managed_explicit_review` | Bind exact active recipe versions; infer no sibling-package direction |
| Malformed source evidence | `blocked` | Create no draft until source evidence is corrected |

For adjacent source and destination package sizes, Phase 3 conserves base units with:

```text
g = gcd(source.unitsPerVariant, destination.unitsPerVariant)
inputQty = destination.unitsPerVariant / g
outputQty = source.unitsPerVariant / g
```

The path consumes `inputQty` source packages and produces `outputQty` destination
packages. A reverse path is a separate authority record. The planner may traverse
multiple paths only when every directed step exists and is valid.

The classifier blocks, rather than guesses, when it finds no active variants, an
inactive or missing recipe member, stale recipe unit/product snapshots, invalid
conversion shape, conflicting or duplicate directed recipe authority, or more than
one network component-build authority for the same output.

## Hash And Replay Evidence

Every product candidate contains:

- `inputHash`: SHA-256 of the algorithm version and normalized source evidence.
- `definitionHash`: the existing canonical transformation-definition hash, or null
  for a blocked candidate.
- `resultHash`: SHA-256 of the algorithm version, input hash, classification,
  definition, and issues.

The full queue also contains catalog input and result hashes over product IDs in
stable order. Draft creation requires the caller's expected input and result hashes.
The repository captures and replans inside a serializable transaction before insert;
source drift rejects the write with a conflict.

Backfill provenance is immutable on the model version:

```text
origin = phase3_backfill
origin_input_hash = exact candidate inputHash
origin_result_hash = exact candidate resultHash
```

Operator-created drafts retain `origin = operator` and have neither backfill hash.

## Migration Queue And Review State

`GET /api/inventory-planning/admin/migration-queue` captures the complete active
catalog and returns these mutually exclusive queue states:

| State | Meaning |
| --- | --- |
| `blocked` | Source evidence cannot produce a safe draft |
| `not_backfilled` | A deterministic candidate exists and no draft exists |
| `conflicting_draft` | The current draft definition differs from the candidate |
| `awaiting_review` | The exact candidate draft exists without a decision |
| `changes_required` | Latest append-only decision on the exact draft requires changes |
| `approved` | Latest append-only decision approves the exact draft |

The Supply & Transformations page exposes the full queue with search, state filter,
classification/issues, candidate paths and recipe bindings, current shadow evidence,
and reason-required controls.

Writes require `inventory_planning:edit` and an authenticated actor:

- `POST /api/inventory-planning/admin/migration-queue/:productId/drafts`
- `POST /api/inventory-planning/admin/migration-queue/:productId/reviews`

Review commands bind product ID, model ID, model version, model definition hash,
model-head revision, decision, actor, reason, idempotency key, request hash, and time.
The database foreign key includes the definition hash, so evidence cannot be attached
to a different definition even if application validation is bypassed. Review rows are
append-only. A later decision creates a new row and preserves the earlier evidence.

Neither approval nor `changes_required` changes runtime authority.

## Channel Publication Preview

`GET /api/inventory-planning/admin/migration-queue/:productId/channel-preview` is
read-only and requires a current completed ATP shadow run.

The preview:

1. Verifies the currently selected draft/active model ID, version, and definition
   hash exactly match the sealed shadow run.
2. Builds legacy and proposed ATP adapters only from that same immutable shadow.
3. Runs both adapters through the same current allocation engine and channel-policy
   resolution in one `REPEATABLE READ READ ONLY` transaction.
4. Calls `previewProduct`, which performs allocation calculation without allocation
   audit writes or provider calls.
5. Compares per-channel, per-variant, and per-warehouse calculated publication
   quantities.

This is an allocation publication preview, not provider-state verification. Comparing
against actual provider quantities, durable activation/outbox evidence, provider
write acknowledgement, and readback remain Phase 4+ work.

The preview blocks readiness when the shadow model is stale, the ATP shadow already
contains blockers, legacy and proposed allocation shapes differ, quantities exceed
the legacy allocation engine's safe integer boundary, a channel uses the legacy
all-active-warehouse fallback, or current channel scope references a warehouse absent
from the sealed shadow.

## Command-Line Operation

Dry-run is the default and performs no write:

```powershell
npm run inventory:backfill-availability-models --
npm run inventory:backfill-availability-models -- --product-id 123
```

The apply mode creates inactive drafts only. It requires an actor and reason:

```powershell
npm run inventory:backfill-availability-models -- --apply `
  --actor "operator-id" `
  --reason "Phase 3 deterministic catalog backfill"
```

An optional `--product-id` limits draft creation to one active product. The command
skips blocked products and products that already have a matching or conflicting
draft, uses a deterministic per-product idempotency key, continues after individual
failures, and exits nonzero if any selected write fails.

No production backfill/apply command is part of deployment. Running it against
production requires a separate explicit operational approval and post-run read-only
verification.

## Database And Concurrency Invariants

- Catalog and single-product capture use repeatable-read, read-only transactions.
- Draft creation and review use serializable transactions and product-scoped
  advisory locks.
- Idempotency keys cannot be reused across transformation, promise-policy, or review
  command families.
- Backfill origin evidence is immutable.
- Review evidence is append-only and bound to the exact model definition hash.
- Serialization/deadlock conflicts return a reload-and-retry response; they do not
  silently retry with stale evidence.
- Phase 3 schema adds draft provenance and review evidence only.

## Gate 3 Completion Evidence

Code deployment alone does not complete Gate 3. Completion requires a separately
authorized, read-only-verified operational review showing:

1. Every active product appears in exactly one queue classification.
2. Repeated full-catalog dry runs produce identical catalog and product hashes from
   unchanged source evidence.
3. Every nonblocked candidate has an exact draft and an append-only review decision.
4. Quad Box explicitly binds `BASE + LID + DIV -> EA` and every approved package
   direction; no direction is inferred.
5. Every selected product has a current shadow and a nonblocked channel publication
   preview with explicit warehouse scope.

## Intentional Corrections To The Original Migration Draft

- Explicit directed paths replace reversible equivalence-group authority. Paired
  directions may reproduce reversible behavior, but each direction is independently
  stored, reviewed, and revocable.
- Phase 3 compares legacy-calculated and proposed-calculated allocation targets. It
  does not claim to compare actual provider state; that requires Phase 4 provider
  evidence.
- Full-catalog review replaces product canary cohorts. Later activation is one
  controlled catalog-wide authority switch.
- Conservative first-cutover publication uses
  `min(current provider observed, new desired)`, followed by provider readback. It
  does not use `min(legacy ATP, proposed ATP)` as a substitute for provider state.
- The first cutover cannot restore legacy ATP. Later rollback may select only a
  previously provider-verified version of the new model.
