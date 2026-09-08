# Shipping-critical completion

## Scope and preserved work

User priority: defer the separate Dropship acceptance issue and continue the
shipping-critical work. The combined checkpoint remains intact on
`codex/fulfillment-program-completion` at `152fc8284`; its deferred issue is
recorded in `docs/FULFILLMENT-PROGRAM-COMPLETION-2026-09-07.md` there.

This shipping-only branch starts at fresh main
`df1b8652b90123d3d877f904c0a2ba0627b527b1`. It does not carry the Dropship
acceptance upgrade, receipt migration, inventory cutover, publication overhaul
or combining policy. Existing main functionality and tests remain intact.
Main `0a81cdc38a63d7ee6bc81af9b5767fe1ed904ffa` (PR 1409, the separate
inventory-shipment runtime work) was subsequently merged into this branch. Its
runtime composition and CI coverage are preserved; they are not this branch's
new inventory implementation or proof of production activation.

## Shipping finish line

1. A valid outbound label promptly creates exact originating-channel fulfillment
   without waiting for a carrier scan. Carrier possession remains a separate fact.
2. Later observations, voids/replacements and split packages preserve exact item
   history, update tracking as appropriate and never fulfill the same quantity
   or consume physical inventory twice.
3. Provider failures remain durably retryable; ambiguous item/account identity
   goes to existing Operations Tower review, not guessed authority or a new page.
4. Actual provider readback and deployment are verified separately from local
   code/tests. This task does not authorize production writes or activation.

## First isolated shipping slice: versioned package continuity

Current main composes `PackageAllocationLabelCommercialFulfillmentService` in
`server/services/index.ts`. `createShipStationService` observes an outbound
label and invokes it before carrier possession. OMS activates durable commercial
commands; `startChannelFulfillmentCommandWorker` polls every 15 seconds by
default in batches of 25. These are source-code facts, not verified live timing.

The main bootstrap nevertheless rejects already-versioned package groups with
`EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY`. The saved shipping slice removes
that dead end by using the registered group's full source closure and validated
immutable history. For later plans with no new commercial quantity, OMS proves
and reuses the exact original activated commands rather than creating another
fulfillment or physical projection. Missing/conflicting authority still requires
review.

The carryover is limited to four shipping production files, three matching
unit-test files, the existing shipping PostgreSQL integration file, the OMS
fulfillment authority repository, and one pure inherited-effect validator with
its unit tests. No schema or CI/writer-baseline changes are required by this slice.
Main's shipment-quantity evidence fixture and historical correction changes must
be preserved when integrating the tests; both were retained.

The public-label regression also exposed three replay defects that are covered
by this slice:

- A first fulfillment can create a canonical request link that did not exist in
  the original legacy source. Replay recognizes only the exact owner-created
  request, proved through the original immutable allocation/physical-item and
  OMS lineage. It does not change the original source fingerprint or accept a
  lookalike replacement request.
- The new owner link can add corroborating discovery relationships to an
  otherwise unchanged plan. Replay retains the original authority snapshot only
  when all other snapshot fields and the resolved state are identical and every
  original relationship remains present. Changed scope or removed support fails
  the existing checks.
- Materialization and activation acquire the allocation group before the plan.
  This removes the lock-order inversion reproduced by concurrent public-label
  observations; no retry was added to hide that deadlock.

### Isolated slice validation

- 352 tests passed across 13 focused shipping/OMS unit suites.
- All 34 tests passed in the existing shipping-ledger PostgreSQL suite, using
  only the explicitly disposable loopback database at port 55439, with production
  database URLs cleared. This includes public-label replay, tracking-revision
  inheritance, rejection of shadow/unmaterialized authority, exact source closure,
  cancellation history, rollback and concurrent source ownership.
  The added cases cover immediate immutable replay, both legacy/new request
  modes, wrong request/quantity/SKU, lost relationships and concurrent public
  observations. Concurrency is exercised with simultaneous calls, not a
  deterministic lock-barrier scheduler.
- All four ownership/migration guard tests passed with the main baseline and CI
  files unchanged. No migration or new table was introduced.
- The PostgreSQL run emitted the existing concurrent-client-query deprecation
  warning; this slice does not claim to resolve that separate warning.

These tests prove retained original commercial quantity, not execution of every
tracking-amendment or physical inventory correction intent. The generic planner
effects remain separately controlled. Canonical physical-dispatch composition
and its inventory-cutover dependencies are not prerequisites of this label-only
slice and are not being silently activated here. No live provider behavior or
production deployment was verified.

## Second isolated shipping slice: originating provider account

The canonical Shopify and eBay command handlers previously used shared provider
clients. They now resolve the originating OMS order's channel through the channel
owner and pin the connection credentials for the entire attempt. Exact provider
readback and the fulfillment write use the same selected account. Legacy handlers
are not globally redirected by this change.

The Shopify path retains the shipment warehouse's explicit location mapping and
checks it through the selected store. A connection's primary inventory location
is not a substitute for a shipment warehouse. Missing or conflicting identity
must go to existing review; there is no fallback to another store or warehouse.
The eBay path compares verified identity before and after token acquisition with
identity observed from that exact token. Provider/account changes are not guessed.

Deterministic connection, identity and permission failures require review;
temporary transport, throttling and server failures retain the durable retry
path. Provider response bodies and credentials are not copied into the new
boundary errors. All 313 tests passed across nine focused provider/OMS and
unchanged legacy-client suites.

Canonical eBay readback is explicitly strict: failed/aborted JSON or an invalid
collection cannot be interpreted as an empty collection permitting another POST.
Both requests and response-body reads have a bounded abort signal. A POST whose
response is lost is followed by exact readback on the next attempt, not a blind
second POST. The constructor option is enabled only for canonical fulfillment;
legacy three-argument client construction retains its existing behavior.

eBay's [official fulfillment guide](https://developer.ebay.com/api-docs/sell/static/orders/managing-fulfillments.html)
states that this endpoint returns all fulfillments for the order. A valid explicit
collection is therefore accepted without the optional `total`; a supplied total
must agree with the collection, and pagination evidence is rejected. Tests cover
both the documented total-optional success and malformed/aborted GET-only cases.

This reads the current OMS channel binding; it does not create a historical
account-binding migration or prove that all old orders were never rebound.
Likewise, this slice does not replace the legacy cancellation/tracking-update
clients. Those limits must remain explicit when assessing the full finish line.

## Deployment handoff

Final code checkpoint: `e1d7bad0b916d0ffedba6e7eaaf9d22f5b14c157`.
Validation completed against this code after the main integration:

- Full non-integration sweep: 1,107 suites / 11,871 tests passed; one suite and
  23 tests skipped. Command: `npx vitest run --exclude '**/integration/**' --maxWorkers 4`.
- Actual shipping-ledger PostgreSQL suite: all 34 tests passed against the
  explicitly disposable local database; no production database URL was used.
- `npx tsc --noEmit --incremental false` and `npm run build`: both passed.
- Writer-ratchet and migration-prefix guards: all four tests passed.
- `git diff origin/main --check`: passed. No migration/schema, Dropship, baseline
  or CI diff exists relative to integrated main.

Logs are retained under `C:/Users/owner/Echelon/.codex-audits/` as
`shipping-critical-final-unit-sweep-verified-20260907.log`,
`shipping-critical-final-pg-20260907.log`,
`shipping-critical-final-typecheck-verified-20260907.log`,
`shipping-critical-final-build-verified-20260907.log`, and
`shipping-critical-final-guards-20260907.log`. The build's chunk-size warning
and the PostgreSQL concurrent-client-query deprecation warning remain visible;
neither caused a validation failure. Remote CI has not run for this local branch.

This branch is shipping-only. The separate clean worktree preserves deferred
Dropship changes without bringing them into this diff. No migration, new table,
writer-baseline adjustment, new page or CI change is introduced relative to
integrated main. No provider mutation, production-setting change, deployment or
PR publication was performed in this local implementation turn.

After review/merge/deployment, the remaining acceptance check is an authorized
controlled shipment: verify that label observation produces the correct store's
fulfillment and tracking before carrier possession, then repeat observation and
prove no additional quantity was fulfilled. Confirm the configured store and
warehouse mapping and inspect the durable command/review state rather than
assuming local mocks prove live credentials or provider timing.
