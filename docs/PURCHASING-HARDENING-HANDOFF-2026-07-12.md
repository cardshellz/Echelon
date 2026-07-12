# Purchasing Hardening Handoff - 2026-07-12

Audience: the owner and engineers continuing the purchasing, COGS, recommendation,
and forecast work from another machine.

This is the continuation document for the July 2026 purchasing hardening sequence.
It records verified merged work, the current architecture, a timestamped production
snapshot, confirmed remaining defects, and the recommended next implementation order.

## Start here on another machine

1. Fetch current Git state. Do not assume the commit recorded below is still current.

   ```powershell
   git fetch origin
   git switch main
   git pull --ff-only origin main
   ```

2. Read this file, then inspect the current versions of every referenced file before
   editing. The code and database constraints are authoritative if this document has
   become stale.
3. Use `gh pr view <number>` for the merged PR evidence listed below.
4. Do not use repository-root `status.txt` as a handoff. It is an old Git-status
   snapshot from April 2026 and describes unrelated work.
5. Recommended next code slice: harden the non-recommendation PO line mutation paths
   described in "Remaining work" below.

## Status authority

This document is authoritative for continuation status as of 2026-07-12. It does not
replace these background documents:

- `docs/PROCUREMENT-WMS-HARDENING-PLAN.md` is the target design and phase plan. Its
  own header correctly says it is not an implementation record.
- `docs/PROCUREMENT-WMS-HARDENING-LOG.md` is historical implementation context through
  May 2026. Later July findings and PRs supersede any closure claim in that log.
- `docs/COGS_TEST_PLAN.md` is the COGS validation plan. Its real-Postgres integration
  tier remains relevant.

Use this evidence order when facts conflict:

1. current code and migrations on `origin/main`
2. current production schema and read-only production queries
3. merged PR bodies and tests
4. this handoff
5. older planning and log documents

## Verified checkpoint

Verified on 2026-07-12 around 07:44 America/New_York:

- `origin/main`: `2120dc36` (PR #903 merge; includes PR #902)
- production app: Heroku release v2360 at `2120dc36`
- PR #902, `Make auto-draft runs leased and crash-safe`, merged and deployed in
  release v2359 at `2fc301a9`
- production `public.auto_draft_runs` contains `heartbeat_at` and
  `lease_expires_at`
- production contains `auto_draft_runs_status_chk`,
  `auto_draft_runs_lifecycle_chk`, and `auto_draft_runs_single_running_uidx`
- production had zero auto-draft run rows at the snapshot time
- production had zero POs with source `auto_draft` or `reorder`, zero automatic
  recommendation decisions, and zero recommendation PO handoff rows at the snapshot
  time

The last point matters: the automatic path is structurally hardened but has not yet
been exercised by production data. Do not describe it as production-proven until a
controlled live run is observed end to end.

### Forecast input snapshot

The read-only `npm run procurement:forecast-input-gaps` audit at
`2026-07-12T11:44:19Z` reported:

| Field | Value |
| --- | ---: |
| Lookback | 90 days |
| Auto-draft mode | `draft_po` |
| Approval policy | `high_confidence_only` |
| Recommendations | 278 |
| Trusted | 101 |
| Thin-sample watch | 24 |
| Demand review | 153 |
| Total issue items | 177 |
| Source repair required | 0 |
| Recommended action | `work_forecast_review_queue` |

There were 141 `missing_latest_demand_at` input gaps, but the current classifier put
them under no-recent-demand review rather than source repair. The audit explicitly
reported `requiresBackfillInvestigation: false`; do not build a mutation backfill from
that snapshot.

Re-run the audit before relying on these counts:

```powershell
npm run procurement:forecast-input-gaps
```

Use a production `DATABASE_URL` only through an authenticated environment and keep the
operation read-only. Never print or commit the URL.

## Current architecture and invariants

### 1. COGS and landed cost

Authoritative files:

- `server/modules/inventory/cogs.service.ts`
- `server/modules/procurement/shipment-tracking.service.ts`
- `server/modules/procurement/receiving.routes.ts`
- `server/modules/procurement/purchasing.service.ts`

Current invariants established by PRs #867, #868, #869, and #872:

- lot revaluation is centralized in `COGSService`
- mills are authoritative for lot and COGS recosting; cents are compatibility mirrors
- shipment landed-cost finalization delegates recosting to the COGS authority
- `cost_provisional`, not a zero landed-cost amount, determines whether shipment cost
  is pending
- receiving can reconstruct and preserve finalized landed unit cost in mills
- recosting cascades to existing `oms.order_item_costs` through the centralized path

Do not add another lot or order-COGS mutation path. Extend the COGS service or add a
domain command that calls it.

### 2. Purchase order lifecycle and editing

Authoritative files:

- `server/modules/procurement/purchase-order.routes.ts`
- `server/modules/procurement/purchasing.service.ts`
- `client/src/pages/PurchaseOrderEdit.tsx`
- `client/src/pages/PurchaseOrderDetail.tsx`

Current invariants established by PRs #884, #885, #888, and #889:

- delivery schedules are validated against PO lifecycle dates and corrected through
  an audited command
- the generic PO header patch is allowlisted, draft-only, row-locked, transactional,
  idempotent for no-op repeats, and audited
- editing an existing draft updates that PO instead of posting a duplicate PO
- draft header and line replacement is atomic, preserves retained line IDs, cancels
  removed lines, uses `updated_at` optimistic concurrency, and writes before/after
  audit state
- sent POs age from submission while waiting for acknowledgement; acknowledged and
  in-transit POs age against valid delivery schedules; receiving-stage aging uses
  latest receiving activity

### 3. Recommendation and forecast boundary

Authoritative files:

- `server/modules/procurement/purchasing-recommendation-context.service.ts`
- `server/modules/procurement/purchasing-demand-forecast.engine.ts`
- `server/modules/procurement/purchasing-recommendation.engine.ts`
- `server/modules/procurement/forecast-input-gap-diagnostics.service.ts`
- `server/modules/procurement/demand-events.service.ts`
- `server/modules/procurement/demand-events.routes.ts`

Current recommendation authority:

- the forecast basis is `recent_order_velocity_v1`
- standard, short, long, and seasonal windows produce diagnostics for acceleration,
  baseline, and seasonality; they do not create a second PO writer
- paid, coupon-discounted, and zero-revenue demand composition is retained in
  forecast provenance
- trust and input-gap diagnostics can hold a recommendation out of automatic mutation
- lead time plus safety-stock demand forms the base reorder point
- weighted forward demand events are added to that reorder point
- available plus on-order pieces form effective supply
- recommendations round the shortage to the configured order UOM but persist the
  result as base pieces

Forward demand overlays already exist as explicit piece commitments:

- event types: drop, preorder, promotion, wholesale, seasonal, manual forecast
- confidence: high, medium, low
- planned and active events feed weighted pieces into the recommendation engine

This is not yet an advanced growth-scenario forecasting system. It does not provide
versioned percentage-growth overlays, scenario comparison, forecast backtesting, or
model accuracy tracking.

### 4. Recommendation-to-PO economics

Current invariants established by PRs #890 and #892:

- `purchase_order_lines.order_qty` is base pieces
- expected receive variant and units per receive variant preserve the receiving
  configuration separately
- `suggestedOrderQty * orderUomUnits = suggestedOrderPieces` is validated before PO
  mutation
- the exact active preferred `vendor_product_id` selected by the recommendation is
  retained and revalidated
- per-piece supplier cost stays in mills
- line totals are rounded once after multiplying complete mill cost by base pieces
- `unit_cost_mills`, the cents mirror, product total, and line total are persisted
  together

### 5. Handoff and automatic mutation

Authoritative files:

- `server/modules/procurement/recommendation-po-handoff.service.ts`
- `server/modules/procurement/recommendation-po-handoff.repository.ts`
- `server/modules/procurement/auto-draft-run-lifecycle.service.ts`
- `server/modules/procurement/auto-draft-run-lifecycle.repository.ts`
- `server/jobs/auto-draft.job.ts`

Current invariants established by PRs #895, #899, and #902:

- accepted recommendations bind exact supplier, quantity, receive configuration, and
  mill cost before mutation
- accepted decision, PO header, PO lines, history, PO event, handoff decision, and
  immutable decision-to-line provenance commit in one transaction
- scheduled and manual automatic runs use the same canonical job and automatic
  handoff transaction
- automatic runs create vendor-grouped run-owned drafts; they do not append to an
  unrelated manual draft
- recommendation-wide locks serialize operator and automatic decisions
- decisions made after a run starts invalidate that run's snapshot and are skipped
- one running auto-draft row is enforced by a partial unique index
- run ownership uses a database-timed 30-minute lease and heartbeat
- expired runs become `interrupted`; active duplicate claims return a structured 409
- PO mutation and successful run completion commit atomically
- late error handling cannot downgrade an already successful run

## Merged July hardening ledger

| PR | Merged result |
| --- | --- |
| [#867](https://github.com/cardshellz/Echelon/pull/867) | Centralize mills-first COGS recosting |
| [#868](https://github.com/cardshellz/Echelon/pull/868) | Route shipment landed recost through COGS |
| [#869](https://github.com/cardshellz/Echelon/pull/869) | Use provisional state for landed-cost pending |
| [#872](https://github.com/cardshellz/Echelon/pull/872) | Preserve landed-cost mills on receiving |
| [#875](https://github.com/cardshellz/Echelon/pull/875) | Correct forecast input-gap action classification |
| [#878](https://github.com/cardshellz/Echelon/pull/878) | Count only supplier gaps blocking current recommendations |
| [#880](https://github.com/cardshellz/Echelon/pull/880) | Guard every landed-cost finalization path against missing dimensions |
| [#883](https://github.com/cardshellz/Echelon/pull/883) | Age receiving POs from latest receipt activity |
| [#884](https://github.com/cardshellz/Echelon/pull/884) | Validate and audit PO delivery schedules |
| [#885](https://github.com/cardshellz/Echelon/pull/885) | Guard purchase-order draft header edits |
| [#888](https://github.com/cardshellz/Echelon/pull/888) | Update existing drafts atomically without duplicate POs |
| [#889](https://github.com/cardshellz/Echelon/pull/889) | Stop aging acknowledged POs before valid future ETAs |
| [#890](https://github.com/cardshellz/Echelon/pull/890) | Write recommendation POs in base pieces |
| [#892](https://github.com/cardshellz/Echelon/pull/892) | Preserve mill costs and supplier provenance in recommendation POs |
| [#895](https://github.com/cardshellz/Echelon/pull/895) | Make accepted recommendation handoff atomic and immutable |
| [#899](https://github.com/cardshellz/Echelon/pull/899) | Unify scheduled and manual automatic recommendation PO writes |
| [#902](https://github.com/cardshellz/Echelon/pull/902) | Add leased, crash-safe, single-flight auto-draft run lifecycle |

## Remaining work

The priorities below are based on current code inspected on `2120dc36`. Re-inspect
after pulling newer main.

### P0: Harden non-recommendation PO line mutations

Verified current path:

- `purchase-order.routes.ts` passes raw `req.body` into `purchasing.addLine`,
  `addBulkLines`, and `updateLine`
- `purchasing.service.ts:updateLine` accepts `Record<string, any>`
- the service passes a generic update object to storage
- line update, downstream shipment/snapshot/invoice cascades, and PO total
  recalculation are not one transaction
- this path writes no immutable before/after line amendment event
- downstream cascade failures are caught, logged as warnings, and then ignored
- direct database writes and `new Date()` calls remain in the orchestration path
- recommendation-created lines are correctly blocked from amendment, but ordinary
  lines still use this unsafe path

Recommended scope for one focused PR:

1. Define strict add, update, and delete command DTOs with explicit allowed fields.
2. Make mills authoritative and derive cents and totals with integer arithmetic.
3. Lock the PO and line, validate both lifecycle tracks, and use optimistic
   concurrency where the UI can hold stale state.
4. Execute line mutation, required linked-record handling, PO recalculation, and an
   immutable before/after PO event in one transaction.
5. Do not swallow linked-record failures. Either reject amendments after downstream
   financial/receiving linkage or make the supported cascade atomic.
6. Preserve the recommendation-handoff immutability guards.
7. Add route, service, rollback, overflow, stale-write, and retry tests.

### P1: Replace the generic financial idempotency middleware

Verified current file: `server/middleware/idempotency.ts`.

Current failure modes:

- keys are global rather than scoped to actor, method, route, and resource
- the request hash covers only the body, not path parameters or command identity
- every replay returns HTTP 200 instead of the original status
- the key claim is separate from the financial transaction
- response persistence is asynchronous and errors are only logged
- a crash can leave a key permanently `in progress` or commit a mutation without a
  replayable result
- the middleware does not provide command ownership, lease/recovery, or a domain
  result reference

Replace it with a migration-backed command idempotency contract. The command claim,
domain mutation, audit, and durable result identity must share one transaction where
possible. Do not retrofit recommendation handoff back onto the generic middleware;
its domain uniqueness and transaction are already the authority.

### P1: Add real-Postgres financial integration coverage to CI

`.github/workflows/ci.yml` explicitly excludes integration tests. Unit tests prove
orchestration but not PostgreSQL constraints, locking, rollback, or migration behavior.

Use `docs/COGS_TEST_PLAN.md` as the initial acceptance matrix, especially:

- receipt to lot to pick to COGS
- multi-lot FIFO
- landed-cost recost cascade
- invoice variance cascade
- transfer and break/assembly layer preservation
- return cost resolution
- concurrent pick
- valuation reconciliation
- recommendation handoff concurrency and rollback
- auto-draft claim, lease recovery, and transaction completion

The test environment must apply the full migration set and expose
`ECHELON_TEST_DATABASE_URL`. Do not point destructive integration tests at production.

### P2: Run a controlled automatic-purchasing pilot

Production had no automatic POs or handoffs at this snapshot. Before expanding policy:

1. select one fully configured, low-risk SKU with trusted demand and an exact preferred
   supplier row
2. record the recommendation economics before running
3. run one manual auto-draft claim
4. verify run lease and terminal state
5. verify exact pieces, receive configuration, vendor product, mills, cents mirror,
   line total, PO event, recommendation decisions, and immutable mapping
6. cancel or process the draft through the normal lifecycle
7. capture database IDs and operator evidence in this document or a dedicated runbook

Do not broaden approval policy until this succeeds.

### P2: Build forecast growth scenarios on the existing boundary

The current engine has explainable velocity windows and explicit forward piece events.
The next forecasting product phase should add overlays without adding another PO writer.

Recommended contract:

- versioned forecast scenario with owner, effective range, status, and audit history
- overlay dimensions for product/variant, channel, promotion, and growth assumption
- support explicit pieces and percentage/multiplier growth without floating-point money
- baseline reference and generated-at timestamp
- confidence and rationale
- stockout-censoring signal so constrained sales are not treated as demand ceilings
- scenario comparison against actuals and backtest error metrics
- approval and activation workflow
- one normalized forecast output consumed by the existing recommendation engine
- full provenance copied into recommendation decisions and PO handoff snapshots

### P2: Work the existing forecast review queue

The current audit found no mutation backfill requirement. Operational work remains:

- review 153 no-recent-demand recommendations
- monitor 24 thin-sample recommendations
- exclude non-purchasable artifacts such as gift cards, donations, and duplicate catalog
  placeholders from purchasing authority where appropriate
- confirm trusted products have accurate supplier lead time, safety stock, preferred
  vendor, order UOM, and mill cost before enabling automatic drafts

### Not proven enterprise-complete

Do not claim these areas are complete without a fresh trace and live evidence:

- AP invoice, three-way match, payment, dispute, and void behavior under concurrency
- supplier master-data governance and supplier-performance analytics
- complete COGS reconciliation against the general ledger
- production auto-draft behavior, because no automatic run has occurred yet
- statistical forecast accuracy, backtesting, and growth-scenario governance
- every migration and financial invariant under real PostgreSQL integration tests

## Validation commands for purchasing PRs

Minimum local gate:

```powershell
npx tsc --noEmit --pretty false
npx vitest run server/modules/procurement server/jobs/__tests__/unit/auto-draft.job.test.ts server/__tests__/unit/migration-prefix-collision.test.ts server/__tests__/unit/writer-ratchet.test.ts
npm run build
git diff --check
```

For COGS changes, add the focused inventory suite. For schema, concurrency, or financial
transaction changes, run the real-Postgres integration suite as well.

Known test note: `partial-unique-409.test.ts` currently emits Vitest mock-hoisting
warnings. Do not misreport those warnings as a failure, but do not hide new warnings.

## Working agreement for the next agent

- Trace UI to route to service to repository to schema to downstream side effects.
- Separate facts, hypotheses, and unknowns.
- Use integer cents or mills; never floating point for persisted money.
- Use database time for financial lifecycle state.
- Keep financial multi-write operations transactional and auditable.
- Make retries deterministic through domain uniqueness or transactional idempotency.
- Never swallow a partial financial or inventory failure.
- Re-run production evidence read-only before making a production-state claim.
- Do not modify production data without explicit owner approval.
- Keep each PR focused on one invariant and wait for CI before calling it ready.
- Update this handoff only with evidence that can be reproduced.

## Resume prompt

Use this prompt in a new Codex task after pulling current main:

> Read `docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md`, verify it against
> current `origin/main`, current merged PRs, and read-only production state. Continue
> from the highest-priority remaining item. Investigate and propose first; do not edit
> until the current path and acceptance criteria are proven.
