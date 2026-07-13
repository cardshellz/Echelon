# Purchasing Hardening Handoff - 2026-07-13

This is the continuation record for
`docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md`. Read the July 12 document for
the earlier COGS, forecast, recommendation, and auto-draft history. This document
records the quote-aware PO implementation completed locally on July 13.

## Working state

- Worktree: `Echelon-purchasing-hardening`
- Branch: `codex/purchasing-hardening-2026-07-13`
- Base commit: `58722786` (current `origin/main` after PR #909)
- Deployment status: not deployed
- Migration status: not applied
- Commit status: local working-tree changes; not committed or pushed

Do not deploy or run migration 134 without explicit owner approval. Rebase or merge
the latest `origin/main` first if this branch is resumed after other changes land.

## What was implemented

### Vendor-facing quote capture

PO product lines now record the quote as the supplier issued it:

- price per piece, with up to four decimal places
- price per supplier purchase UOM, including the UOM name and pieces per UOM
- an extended line total for a fixed piece quantity

The original quote is retained separately from the normalized per-piece cost and
rounded line total. Normalization uses integer/BigInt arithmetic with deterministic
half-up rounding and a signed remainder, not floating-point money.

Reusable vendor catalog quotes support per-piece and per-purchase-UOM economics.
Extended totals remain PO-specific because changing their quantity requires a new
supplier total.

### PO and supplier UX

The quote editor is integrated into:

- quick PO creation
- the full PO editor
- PO detail add/edit line flows
- Suppliers vendor-product maintenance
- Product Detail supplier maintenance

Quote reference, quote date, and valid-until date are retained. Reusable catalog
automation requires a real quote date. Invalid date ordering and references longer
than 255 characters are blocked in the client and server.

Legacy normalized costs are display-only until an operator identifies and confirms
the supplier's actual quote basis. Selecting or preloading a legacy row never copies
that normalized cost into a new per-piece quote. Editing only quote metadata cannot
confirm or reclassify legacy economics.

### Purchase UOM and receiving configuration

Supplier purchase UOM is independent of warehouse receiving configuration.

- Quote calculations use the supplier's pieces-per-purchase-UOM.
- MOQ is a floor in base pieces.
- Vendor ordering increments round the recommendation in base pieces.
- Expected receiving units come from the selected product variant, never the vendor
  operational pack field.
- Partial receiving-configuration summaries identify full configurations plus loose
  pieces instead of implying every configuration is full.

### Transaction and lifecycle hardening

The July 12 P0 unsafe ordinary-line path was replaced with strict add, bulk-add,
update, and cancel commands. These commands:

- allowlist input fields
- lock PO and line state
- enforce draft/open/unreceived mutability
- use optimistic concurrency
- calculate exact quote economics server-side
- update line/header economics transactionally
- write immutable before/after audit events
- retain recommendation-line immutability
- reject downstream conflict instead of swallowing a partial failure

Draft header mutations, lifecycle transitions, duplicate-PO behavior, and
recommendation handoff were also aligned with the quote model. Product lines with
legacy or untrusted pricing cannot be submitted/sent until reviewed. Expired, stale,
future-dated, or incomplete catalog quotes are excluded from automatic purchasing.
Zero-dollar quotes remain valid when they are explicitly recorded.

Recommendation handoff now uses deterministic lock ordering and includes MOQ in its
accepted-economics freshness comparison. Vendor, product, variant, and vendor-product
locks use a stable order to reduce deadlock risk.

### Schema and migration

`migrations/134_po_line_quote_pricing.sql` and the Drizzle schema add the quote basis,
provenance, original quote, normalized economics, metadata, and constraints.

Important invariants include:

- product PO lines are explicit quotes or `legacy_unknown`, never `not_applicable`
- non-product lines are `not_applicable` and contain no quote-specific fields
- legacy PO/catalog rows contain no fabricated quote details
- reusable explicit catalog pricing requires a genuine quote date
- MOQ is positive when present
- active PO line numbers are unique within a PO
- vendor catalog business keys treat a null variant as a real key
- only one active preferred vendor mapping exists per product/configuration

Historical explicit rows missing a quote date are downgraded to legacy review; the
migration does not invent dates.

## Live Heroku preflight

A read-only production preflight was run on July 13. No migration or data mutation
was performed.

| Check | Result |
| --- | ---: |
| Null PO line statuses | 0 |
| Duplicate active PO line keys | 0 |
| Invalid nonpositive vendor MOQs | 0 |
| Duplicate vendor catalog business keys | 0 |
| Duplicate active preferred mappings | 0 |
| Estimated PO line rows | 98 |
| Estimated vendor-product rows | 56 |

The current tables are small, but migration 134 performs constraint validation and
non-concurrent index work in one migration transaction. Apply it during a scheduled
deployment window and monitor locks; do not treat the clean preflight as permission
to deploy.

## Validation evidence

Final local results:

- `npm.cmd run check`: passed
- focused purchasing/client gate: 80 test files, 729 passed, 14 skipped
- `npm.cmd run build`: passed; 3,593 client modules transformed and server bundle built
- `git diff --check`: passed; only Windows line-ending notices
- full `npm.cmd test`: 389 files and 4,004 tests passed

The repository-wide command is not fully green for reasons outside this slice:

- three integration suites require missing `ECHELON_TEST_DATABASE_URL`
- one unchanged fulfillment-reconciliation test expects `on_hold` but the unchanged
  implementation returns `partially_shipped`

The focused procurement/client gate is green. Real-Postgres migration, constraint,
rollback, and concurrency coverage was not available locally and remains required
before describing this as production-proven.

## Remaining enterprise blockers

### 1. Transactional command idempotency

The generic financial idempotency middleware still does not provide a durable,
transaction-scoped replay contract. Before enabling unattended external side effects,
add a command-results table keyed by actor, method, route/resource, and request hash;
claim the command, domain mutation, audit, and durable result identity in one
transaction with lease/recovery semantics.

Client-generated request keys are useful duplicate protection but are not a substitute
for that server contract.

### 2. Durable email/outbox delivery

Keep automatic PO email disabled until sending is driven by a transactional outbox
with deduplication, retry/backoff, terminal failure visibility, and an operator replay
path. A committed PO transition and SMTP call must not form an unrecoverable split
brain.

### 3. Atomic PO-plus-catalog commands

Some UI flows still persist the PO command and vendor-catalog update as separate API
commands. Validation prevents the known missing-date partial failure, but a network or
server failure can still leave only one command applied. Consolidate these into a
single domain command or a durable recoverable workflow before treating combined
"save PO and catalog" actions as atomic.

### 4. Real PostgreSQL CI and deployment rehearsal

Provision `ECHELON_TEST_DATABASE_URL`, apply the full migration set in CI, and cover
migration 134, concurrent line commands, lifecycle locks, recommendation handoff,
rollback, and duplicate-key races against PostgreSQL. Rehearse migration 134 on a
production-like copy before release.

### 5. Controlled automation pilot

The July 12 production snapshot had no live automatic PO handoffs. After migration and
application deployment, run one controlled low-risk SKU through recommendation,
draft creation, operator review, lifecycle transition, receipt, invoice/landed-cost,
and audit verification before broadening automation policy.

## Recommended next sequence

1. Review this working tree and split/commit it intentionally.
2. Add the real-Postgres test database and run the financial integration gate.
3. Rehearse migration 134 and prepare a monitored deployment/rollback window.
4. Deploy schema and application with automatic email still disabled.
5. Smoke-test manual per-piece, purchase-UOM, extended-total, zero-dollar, and legacy
   review flows.
6. Run the controlled automatic-purchasing pilot.
7. Implement transactional command results and the durable email outbox before
   unattended sending.

## Resume prompt

> Read `docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md` and
> `docs/PURCHASING-HARDENING-HANDOFF-2026-07-13.md`. Pull the latest repository,
> verify the working branch and read-only production state, then continue from the
> highest-priority remaining enterprise blocker. Do not deploy or mutate production
> without explicit owner approval.
