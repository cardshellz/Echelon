# OMS/WMS Control Tower Handoff - 2026-07-11

## Purpose

This is the current-state handoff for continuing the OMS/WMS/shipping and
Operations Control Tower work from another machine. It records the production
facts verified on 2026-07-11, the unresolved operational cases, the code paths
that produce them, and the next implementation sequence.

Read this file first, then use the durable design documents listed below. Do
not use this handoff as a substitute for rechecking production state before a
repair or migration.

## Repository And Production Baseline

- Repository: `cardshellz/Echelon`
- Production app: `cardshellz-echelon`
- Production release inspected: `v2359`
- Deployed commit inspected: `2fc301a9`
- `origin/main` at handoff creation: `2fc301a9`
- Production release time: `2026-07-11 22:23:39 -0400`

Related durable documents:

- `docs/SHIPMENT-FULFILLMENT-HARDENING-PLAN.md`
- `docs/OPERATIONS-CONTROL-TOWER-DESIGN.md`
- `docs/OPERATIONS-CONTROL-TOWER-RUNBOOK.md`
- `docs/OMS-WMS-AUTHORITY-REMEDIATION-DESIGN.md`
- `docs/OMS-WMS-AUTHORITY-OPERATIONS-RUNBOOK.md`
- `docs/OMS-PROVIDER-FULFILLMENT-TEST-PLAN.md`

## Current Objective

Make Control Tower report durable operational root causes instead of raw retry
attempts, then repair the remaining split-shipment channel-writeback cases from
authoritative physical-shipment item membership.

The immediate production symptom is the `Channel accepted exceptions` stage
showing `41` records under `UNCLASSIFIED`.

## Verified Meaning Of The 41 Records

The `41` value is a count of dead rows in `oms.webhook_retry_queue`, not 41
distinct failures or orders.

| Retry rows | Verified shape |
| ---: | --- |
| 18 | Shopify: no fulfillment-order line item available |
| 7 | Shopify: shipment has no items with positive quantity |
| 15 | The same eBay order-level push returned `false` |
| 1 | A cancelled shipment was submitted to a non-pushable workflow |

The 41 rows collapse into:

- 20 stale or terminal records that should no longer be actionable.
- 6 proven-active Shopify split-shipment writeback cases.
- 1 eBay cross-system inconsistency requiring physical/operator verification.

There are no new error signatures in this bucket. The `UNCLASSIFIED` label is
caused by incomplete taxonomy and retry-row counting.

## Code Evidence For Misclassification And Overcounting

`server/modules/oms/flow-waterfall.service.ts`:

- `DEAD_LETTER_REASON_CODE` at lines 112-126 recognizes the two Shopify error
  messages only when `topic = 'shopify_fulfillment_push'`.
- The legacy rows use `topic = 'delayed_tracking_push'`, so identical known
  errors fall through to `UNCLASSIFIED`.
- The dead-letter aggregation at lines 510-529 uses `COUNT(*)` for every dead
  retry row.
- That aggregation does not apply the waterfall's displayed time window and
  does not group by order, shipment, or durable issue identity.

`server/modules/oms/webhook-retry.worker.ts`:

- `enqueueShopifyFulfillmentRetry` checks for an existing pending retry and a
  `requires_review` shipment flag.
- Pending-only uniqueness does not make a dead retry scope permanently closed.
- `enqueueDelayedTrackingPush` similarly deduplicates only pending scope.

`server/modules/oms/channel-writeback.service.ts`:

- Current production code detects pending and dead retry state per shipment.
- `findChannelWritebackCandidates(..., { excludeRetryStates: true })` now
  excludes both states.

The dead-retry exclusion first reached production in release `v2327`
(`9110b925`) at `2026-07-10 09:12:23 -0400`. The newest amplified retry row was
created at `2026-07-10 08:58:12 -0400`, before that deployment. No matching row
was created after deployment. The retry storm is therefore historical as of
this handoff, but durable database-level retry-episode idempotency is still
missing.

## Six Active Shopify Cases

| Order | Legacy aggregate shipment | Current Shopify fact |
| --- | ---: | --- |
| `#59582` | `4861` | Partially fulfilled; one line remains open |
| `#59792` | `6542` | Partially fulfilled; five units remain open |
| `#59796` | `6546` | Partially fulfilled; five units remain open |
| `#59841` | `6591` | Partially fulfilled; six units remain open |
| `#59845` | `6595` | Partially fulfilled; one unit remains open |
| `#59852` | `6602` | Partially fulfilled; seven units remain open |

Direct Shopify GraphQL reads on 2026-07-11 confirmed that the target aggregate
tracking number is absent for these six orders and Shopify still has remaining
fulfillable quantity.

### Structural Failure Shape

1. A legacy aggregate `wms.outbound_shipments` row contains all order items.
2. Later physical child shipment rows fulfilled subsets of those items.
3. Some aggregate lines now have Shopify remaining quantity `0`, while other
   lines remain open.
4. `resolveFulfillmentOrderLinesFromCandidates` in
   `server/modules/oms/fulfillment-push.service.ts:2275-2375` requires
   `candidate.remaining >= item.qty` for every local shipment item.
5. A single already-fulfilled or partially fulfilled line throws and aborts the
   whole push, preventing writeback for the still-open lines.

The same six shipment scopes also have 603 dead rows under the correctly
classified `shopify_fulfillment_push` topic:

- Shipment `4861`: 231
- Shipment `6542`: 60
- Shipment `6546`: 90
- Shipment `6591`: 112
- Shipment `6595`: 57
- Shipment `6602`: 53

No `wms.reconciliation_exceptions` row exists for these six orders. The target
legacy rows also have no canonical `shipment_requests`, `physical_shipments`,
or `channel_fulfillment_pushes` coverage. Replaying the aggregate shipment as-is
will fail again and must not be used as the repair.

## Twenty Stale Or Terminal Records

Direct Shopify reads confirmed:

- 12 orders are already `FULFILLED` and contain the expected tracking number:
  `#59413`, `#59415`, `#59457`, `#59480`, `#59496`, `#59552`, `#59568`,
  `#59601`, `#59639`, `#59642`, `#59687`, and `#59697`.
- 7 no-positive-quantity cases are already `FULFILLED` with no remaining
  fulfillable quantity: `#57906`, `#58664`, `#58833`, `#58857`, `#59030`
  (two legacy shipment rows), and `#59195`.
- Shipment `3908` for order `#59156` is cancelled and is not pushable.

These records need an explicit resolved/ignored disposition. They must not stay
in the operator work queue and must not be replayed.

## One Active eBay Inconsistency

Identifiers:

- eBay order: `18-14849-28556`
- OMS order id: `241216`
- WMS order id: `205089`
- WMS shipment id: `7140`
- ShipStation order id: `759079577`

Verified state:

- Stored eBay payload reports `orderFulfillmentStatus = NOT_STARTED`.
- Both eBay line items report `lineItemFulfillmentStatus = NOT_STARTED`.
- OMS reports `status = shipped`, `fulfillment_status = unfulfilled`, and no
  tracking number.
- WMS reports `warehouse_status = shipped`.
- Both WMS items have `picked_quantity = 1`, `fulfilled_quantity = 0`, and
  `status = completed`.
- The only WMS shipment is `cancelled`, with no tracking number.
- The OMS event `ship_notify_unresolved` records
  `reason = no_active_wms_shipment` and `parentStatus = cancelled`.
- Fifteen dead `delayed_tracking_push` rows all point to this same OMS order.
- No `wms.reconciliation_exceptions` row exists for this order or shipment.

This order cannot safely be treated as shipped. Before changing operational
state, verify whether the picked package still physically exists and whether a
label was ever purchased outside the recorded shipment. Then use an explicit
domain repair to either restore warehouse work or record the actual shipment.

## Required Remediation Sequence

### 1. Fix Monitor Semantics

- Classify known failure signatures independently of legacy topic names.
- Project one work item per durable operational scope, not per retry row.
- Preserve retry attempts as observations/evidence under that work item.
- Apply a real time-window predicate where the UI claims a 30-day window.
- Do not resolve a work item merely because it is absent from a failed scan.

### 2. Add Durable Retry Episodes

- Define a stable retry scope key for provider, operation, and shipment/order.
- Prevent a terminal retry episode from reopening without an explicit source
  state version change or operator-approved reopen action.
- Keep pending-attempt uniqueness, but do not rely on it for terminal
  idempotency.

### 3. Repair The Six Shopify Cases

- Reconstruct exact physical shipment identity and item membership from the
  provider evidence and existing child rows.
- Backfill canonical shipment request, physical shipment, physical shipment
  items, and channel-push state as appropriate.
- Push tracking only for the exact still-open Shopify quantities associated
  with each physical shipment.
- Verify Shopify line-level remaining quantities and tracking afterward.
- Write/resolve durable reconciliation exceptions so Control Tower reflects the
  repair lifecycle.

### 4. Resolve The eBay Order

- Verify physical package disposition.
- Verify current eBay order state before any write.
- Repair OMS/WMS/shipment state through the owning domain workflow.
- Do not retry tracking without an authoritative shipped package and tracking
  identity.

### 5. Close Historical Noise

- Mark the 20 terminal/recovered records resolved or ignored with an auditable
  reason.
- Collapse duplicate dead attempts under their durable work item.
- Re-run Control Tower projection and verify the `UNCLASSIFIED` count is zero.

## Safety Rules For Continuation

- Do not replay shipments `4861`, `6542`, `6546`, `6591`, `6595`, or `6602`
  until their item membership is repaired.
- Do not mark eBay order `18-14849-28556` shipped without physical and provider
  evidence.
- Do not update fulfillment quantities manually to make aggregates agree.
- Every repair script must support dry-run, stable scope filtering, idempotent
  execution, explicit unsafe skips, and post-run verification.
- Recheck the deployed release and production rows before relying on this dated
  snapshot.

## Resume On Another Machine

```powershell
git clone https://github.com/cardshellz/Echelon.git
cd Echelon
git fetch origin
git checkout codex/oms-wms-handoff-2026-07-11
git pull --ff-only origin codex/oms-wms-handoff-2026-07-11
Get-Content docs/OMS-WMS-CONTROL-TOWER-HANDOFF-2026-07-11.md
```

After this handoff branch is merged, use `main` instead.

Suggested first prompt in the new Codex task:

> Read `docs/OMS-WMS-CONTROL-TOWER-HANDOFF-2026-07-11.md` and the linked
> hardening/control-tower documents. Re-verify the production release and the
> seven unresolved operational scopes before coding. Start with remediation
> sequence step 1 and prove the current code path and production counts.

## Not Proven

- The current live eBay API state has not been re-read after the stored payload
  timestamp; recheck it before repairing order `18-14849-28556`.
- The physical location/disposition of that picked eBay package is unknown.
- The exact historical provider event that first set its OMS/WMS aggregate to
  `shipped` has not been identified from an immutable transition ledger.
- The canonical historical backfill path for the six Shopify cases has not yet
  been implemented or validated.
