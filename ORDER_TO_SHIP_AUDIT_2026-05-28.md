# Order-to-Ship Flow Audit — Echelon (2026-05-28)

**Scope:** End-to-end order lifecycle across Shopify, eBay, dropship → OMS → WMS →
ShipStation → channel write-back.
**Method:** Whole-file trace of the core pipeline files, grounded against `BOUNDARIES.md`
and the financial-audit rubric in `CLAUDE.md`. Every finding cites `file:line`. Inferences
are labeled **HYPOTHESIS**; gaps are labeled **INSUFFICIENT EVIDENCE / ABSENT**.
**Relation to prior review:** Supersedes/updates `ORDER_FULFILLMENT_REVIEW.md` (2026-05-22).
Findings that confirm a prior item are noted; **NEW** marks items not in the prior review.

> **Reviewer confidence note.** Four of the highest-severity findings were re-read and
> verified line-by-line by the lead reviewer (not just sub-agents): **S1-F2** (cancel
> replay), **S1-F3** (refund restock hook), **S3-W1** (reservation no-op signature),
> **S4-F2** (resolveException wrong column). The remaining findings are grounded in cited
> code but were not all independently re-read; spot-check the citation before acting.

---

## Severity key

| Level | Meaning |
|-------|---------|
| **P0** | Order loss, double-ship, wrong quantity, inventory/financial loss, or a durably stuck order. Fix immediately. |
| **P1** | Significant operational risk, silent data drift, or frequent manual intervention. |
| **P2** | Occasional issues, scaling blocker, or audit/observability gap. |
| **P3** | Future-proofing, determinism, cleanliness. |

---

## Executive summary

The pipeline's **inner cores are sound**: WMS pick-item inventory mutation is correctly
transactional and idempotent (`picking.use-cases.ts:949-1020`, `FOR UPDATE` + single tx),
order claiming is atomic via a conditional UPDATE (`orders.storage.ts:678-700`), and the
ShipStation V2 SHIP_NOTIFY mark/rollup/recordShipment layer is individually idempotent and
self-healing on replay.

The **failures are at the seams**. Five structural themes account for nearly every P0/P1:

1. **No transactional unit-of-work across system boundaries.** Webhook and sync handlers
   perform long sequences of independent `await` writes spanning `oms.*`, `wms.*`, and
   `inventory_levels` with no enclosing `db.transaction`. A throw or crash mid-sequence
   leaves OMS/WMS/inventory split-brain. (`oms-webhooks.ts` cancel path, `wms-sync.service.ts:315+`,
   `shipstation.service.ts:1898-2031`.)

2. **Boundary erosion — multiple writers per table.** OMS webhook handlers and the eBay/dropship
   paths write directly into WMS-owned tables and `inventory_levels` with raw SQL, bypassing
   the WMS/reservation interfaces that `BOUNDARIES.md` designates as the single entry points.
   This creates two writers that can disagree.

3. **Inventory is not financially reconciled on the unhappy paths.** Refunds and cancels
   release *reservations* but never return *picked/shipped* units to on-hand; shortfalls
   don't hold orders; there is no standalone job to recover orphaned `picked_qty`.

4. **eBay non-happy-path handling is materially weaker than Shopify** — cancels don't release
   inventory, refunds have no WMS cascade, and the webhook path doesn't run the reconciliation
   the poll path does.

5. **Two concrete defects silently break core transitions** — the WMS-sync reservation call
   has the wrong signature (always a no-op), and exception-resolution writes a non-existent
   column (orders never leave `exception`).

**Count:** 6 P0 · 16 P1 · 17 P2 · 8 P3.

---

## Cross-cutting root cause

`BOUNDARIES.md` defines OMS and WMS as separate systems that call into each other's
interfaces. In practice, **OMS↔WMS are two writers against overlapping tables with no
owning interface and no shared transaction.** Every "order changed after sync" and "status
didn't propagate" symptom traces back to this. Until OMS→WMS mutations go through one
transactional WMS interface, point-fixes will keep regressing.

---

## STAGE 1 — Shopify intake + cancel/refund cascades

Files: `shopify-bridge.ts` (275), `oms-webhooks.ts` (2118), `oms.service.ts` (915),
`webhook-inbox.service.ts` (339).

### S1-F2 · **P0** · Cancel cascade is non-transactional AND a failed shipment cascade is never retried · *VERIFIED* · (confirms prior F07)
`oms-webhooks.ts:1690-1798`. The orders/cancelled handler runs, in sequence with no
`db.transaction`: `UPDATE oms.oms_orders → cancelled` (`:1708`) → `releaseOrderReservation`
(`:1732`) → `cascadeShopifyCancelToShipments` (`:1761`) → fallback `UPDATE wms.orders` (`:1778`)
→ `INSERT oms_order_events` (`:1790`). If the cascade throws after `:1708`, the catch queues a
retry — but on replay `ingestOrder` returns the now-cancelled row and the guard
`if (existing.status === "cancelled")` (`:1698`) short-circuits at `:1700` (marks inbox
succeeded). **The failed shipment cascade is never re-attempted.** Durable partial cancel.
**Fix:** wrap the handler body in one transaction; do not let the cancelled-guard short-circuit
before the shipment cascade is confirmed applied.

### S1-F3 · **P0** · Refund "restock" only releases reservations — never physically restocks picked/shipped units · *VERIFIED* · (confirms prior F10)
`oms-webhooks.ts:2044-2053`. The `restock` hook calls
`wmsServices.reservation.releaseOrderReservation(...)`. `releaseOrderReservation`
(`reservation.service.ts:347-373`) only zeroes `reserved_qty`; it never increments on-hand.
For a picked/shipped order `reserved_qty` is already consumed, so restock is a **no-op for
physical stock**, yet `wms.returns.restocked` is written `true` (`:747`). Sellable inventory is
permanently understated after a post-pick refund.
**Fix:** the restock hook must call a WMS receive/restock path for picked/shipped units;
`restocked` must reflect what physically happened.

### S1-F1 · **P1** · OMS handlers write directly into WMS-owned tables · (NEW emphasis)
`oms-webhooks.ts:482-518` (`UPDATE wms.outbound_shipment_items`, `UPDATE wms.order_items`),
`:1438-1461`, `:1778-1784`, `:1894-1902` (`UPDATE wms.orders`), `:740-750` (`INSERT wms.returns`).
Violates `BOUNDARIES.md` ("never reach into another system's tables directly"). Two writers
for WMS state. **Fix:** route through a WMS interface method.

### S1-F4 · **P1** · Cancel never reverses already-picked inventory
`oms-webhooks.ts:1729-1736` + `shipment-rollup.ts:533-543`. Pre-label shipments cancel; post-label
flagged `on_hold`/`requires_review`; **picked-but-unshipped units are never returned to on-hand.**
Relies entirely on manual operator review.

### S1-F5 · **P1** · Refund WMS mutations + ShipStation `cancelOrder` run BEFORE the idempotency check
`oms-webhooks.ts:669-702`. `applyRefundLineAdjustmentsToWms` (`:482-568`) re-`UPDATE`s shipment
qty and re-calls `shipstation.cancelOrder` on every replay; the `wms.returns` idempotency check
runs only afterward (`:685`). Un-deduped external side effect on retries.
**Fix:** move the idempotency/inbox check to the very top of the cascade.

### S1-F6 · **P1** · Refund OMS financial-status is per-webhook, not cumulative
`oms-webhooks.ts:2017-2027`. `financialStatus` is derived from the single payload's refunded qty
vs order total. Two partial refunds each yield `partially_refunded`; the order never reaches
`refunded`. **Fix:** compute from cumulative `order_line_adjustments`.

### S1-F7 · **P1** · Pre-shipment refunds cannot persist a return record (audit gap)
`oms-webhooks.ts:704-729`. `wms.returns.shipment_id` is NOT NULL, so a refund before any shipment
returns `no_shipment_to_associate` — after `applyRefundLineAdjustmentsToWms` already mutated WMS
items. No return record, no reservation release. **Fix:** allow NULL shipment_id; release
reservation on pre-ship refund.

### S1-F9 · **P1** · Bridge vs webhook use different `externalOrderId` → duplicate OMS rows · (NEW)
Webhook normalizes GID→numeric via `getExternalOrderId` (`oms-webhooks.ts:923-934`, comment cites
"~470 historical dupes"). Bridge ingests with `shopify_orders.id` (`shopify-bridge.ts:179,196`).
Dedup is `onConflictDoNothing((channelId, externalOrderId))` (`oms.service.ts:163`) — only protects
within one format. **INSUFFICIENT EVIDENCE:** whether `shopify_orders.id` equals the Shopify numeric
id or a local PK — **this is the #1 thing to verify** (open question 1). If a local PK, the two paths
create duplicate orders.

### S1-F8 · **P1** · Bridge swallows all errors, miscounts successes
`shopify-bridge.ts:180-184` (`catch { console.error }`), `:207-210` (`bridged++` regardless).
Failed bridges are silently dropped and counted as success; no durable failure record.

### S1-F14 · **P2** · Empty/unparseable webhook body returns 200 → Shopify won't retry
`oms-webhooks.ts:1038-1042`, `:1062-1066`. A malformed-but-real payload is ACKed 200 and dropped.
**Fix:** return 4xx/5xx for unparseable bodies, or persist to inbox first.

### S1-F15 · **P2** · `x-internal-retry` bypasses HMAC using `SESSION_SECRET` (security)
`oms-webhooks.ts:1034-1036`. Conflates the session-cookie secret with webhook-retry auth; widens
blast radius if `SESSION_SECRET` leaks. **Fix:** dedicated retry secret.

### S1-F10 · **P2** · orders/updated unconditionally re-stamps WMS address/financial; defaults `country='US'`, `financial_status='paid'`
`oms-webhooks.ts:1437-1462`. Overwrites `wms.orders` on every update even when unchanged; missing
financial status silently becomes `paid`; missing country becomes `US`.

### S1-F11 · **P2** · Removed/picked line qty drifts OMS(0) vs WMS(picked); flag only logged
`oms-webhooks.ts:1575-1578` + `wms-sync.service.ts:930-942,1012-1016`. `flaggedForReview` is only
`console.warn`'d (`oms-webhooks.ts:1610-1615`) — no durable task. **INSUFFICIENT EVIDENCE** it's
persisted anywhere.

### S1-F12 · **P2** · `ingestOrder` order+lines+event loop is not transactional
`oms.service.ts:242-289`. Order row, then per-line inserts in a loop, then `created` event — no
transaction. A recovery branch (`:185-236`) mitigates on a later re-ingest. **HYPOTHESIS:** mitigated
in practice because the webhook re-ingests every time.

### S1-F13 · **P3** · Fire-and-forget member enrichment / `pushToMissionControl`
`oms-webhooks.ts:1252-1254`, `:1324`, `:1657`, `:1801`. MC pushes have no `.catch` at call sites.

---

## STAGE 2 — eBay + dropship intake

Files: `ebay-order-ingestion.ts` (491), `ebay-types.ts` (340), dropship intake/acceptance
(`dropship-order-intake-service.ts` 356, `dropship-order-acceptance.repository.ts` 1341+, providers/mappers).

### S2-E1 · **P0** · Dropship acceptance writes `inventory_levels.reserved_qty` directly and reimplements reservation · (NEW)
`dropship-order-acceptance.repository.ts:865` (`UPDATE inventory.inventory_levels SET reserved_qty
= reserved_qty + $1`), bin self-selected/locked at `:618-629`, own availability math at `:862/1276`,
plus raw `INSERT oms.oms_orders/lines/events` (`:728/816/903`). Violates `BOUNDARIES.md` ("reservation
service is the single entry point... never reimplemented" and "nothing outside WMS may touch
inventory_levels"). Two reservation implementations that can disagree on ATP.
**Fix:** route through `reservationService.reserveForOrder()`.

### S2-E2 · **P1** · OMS eBay cancel path raw-UPDATEs `wms.orders`
`ebay-order-ingestion.ts:266-279`. SELECT + `UPDATE wms.orders SET warehouse_status='cancelled'`
from OMS code. Boundary violation; bypasses WMS cancel side effects.

### S2-E3 · **P1** · eBay cancel releases no reservation/inventory; post-label silently no-ops · (confirms prior F08)
`ebay-order-ingestion.ts:258-281`. Only gate is `warehouse_status NOT IN
('in_progress','ready_to_ship','shipped','cancelled')`. Reserved inventory committed at ingest
(`:303`) is never released → `reserved_qty` stranded, ATP suppressed. Post-label orders match 0 rows
with no review record.

### S2-E4 · **P1** · eBay refund updates only OMS financial status; no WMS cascade · (confirms prior F09)
`ebay-order-ingestion.ts:282-289`. On FULLY/PARTIALLY_REFUNDED, only `oms_orders.financial_status`
+ `refunded_at`. No reservation release, no shipment/return handling, no line-level partial accounting.
A refunded order can still be picked and shipped.

### S2-E5 · **P1** · Dropship silently drops post-acceptance cancels/refunds · (NEW)
Provider filter `orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}` (`...provider.ts:133`) + drop rules
(`...mapper.ts:42-52`). Once accepted, a later eBay cancel/refund is counted `ignored` and never
reverses the OMS order, the direct `reserved_qty` (S2-E1), or the wallet debit (`...repository.ts:274`).
The cancellation provider is OUTBOUND only.

### S2-E6 · **P2** · eBay post-ingest sequence non-atomic; inbox marked succeeded on partial failure
`ebay-order-ingestion.ts:297-312`, `:451-465`. reserve/assign/sync are separate awaits; a thrown
`assignWarehouse` is caught+logged, 200 returned, inbox `succeeded` — invisible to replay tooling.

### S2-E8 · **P2** · Webhook path doesn't run cancel/refund reconciliation; only the poll does
`ebay-order-ingestion.ts:439`. `topic includes "order"` → re-ingest only; the cancel/refund branch
(`:258-289`) runs solely in the poll path. Webhook-delivered cancellations wait up to 5 min for poll.

### S2-E9 · **P2** · eBay money uses `parseFloat` float math; inconsistent with dropship parser
`ebay-order-ingestion.ts:70-73` (`Math.round(parseFloat(value)*100)`), `:91` (`lineItemCostCents/qty`
rounding). Dropship uses an integer parser (`...mapper.ts:55-80`). Violates "never float for money";
per-unit rounding can make `unit*qty != lineTotal`. **Fix:** reuse the integer parser in the OMS path.

### S2-E7 · **P2** · `isNew` = 5-second wall-clock heuristic
`ebay-order-ingestion.ts:253`. `ingestOrder` should return an explicit `inserted` flag (it detects the
conflict at `oms.service.ts:167`) instead of inferring newness from a timestamp.

### S2-E10 · **P3** · `shipByDate` reads only `fulfillmentStartInstructions[0]`, no validation, no recompute
`ebay-order-ingestion.ts:81-83`; SLA at `sla-monitor.service.ts:80-110` no-ops if already set. Take
`min(shipByDate)` across instructions; validate the parsed date.

---

## STAGE 3 — OMS→WMS sync + reservation

Files: `wms-sync.service.ts` (1421), `reservation.service.ts` (787), `atp.service.ts` (571),
`shopify.routes.ts` sync-from-oms (746-858).

### S3-W1 · **P0** · `reserveForOrder` called with the WRONG signature → reservation from sync path is a silent no-op · *VERIFIED* · (NEW)
`wms-sync.service.ts:479` calls `reservation.reserveForOrder(newWmsOrder.id)` — but the signature is
`reserveForOrder(productId, variantId, orderQty, orderId, orderItemId, userId?)`
(`reservation.service.ts:89-96`). `orderQty` is `undefined`, so the `orderQty <= 0` guard (`:97`) is
false; `getAtpPerVariant(orderId)` finds nothing; returns `{ reserved: 0, shortfall }` — which has no
`.success` field, so `!reserveResult.success` is **always true** → always logs a false "reservation
failed … undefined" warning and **reserves nothing**. Real reservation happens only because the OMS
layer separately calls `reserveInventory` (`oms-webhooks.ts:1277`, `ebay-order-ingestion.ts:303`). Any
caller of `syncOmsOrderToWms` without that compensating call gets a pickable order with zero reservation.
**Fix:** call the order-level `reserveOrder(newWmsOrder.id)` (`reservation.service.ts:219`) and consume
its `{ reserved, failed }` result; add a regression test asserting `reserved_qty` after sync.

### S3-W8 · **P1** · Inventory shortfall does not hold/backorder the order · (confirms prior F04)
`reservation.service.ts:110-119,201` returns partial `{reserved, shortfall}` and never throws/holds;
`determineWarehouseStatus` (`wms-sync.service.ts:545`) sets `ready` purely from `financialStatus==='paid'`
before any reservation. Shortfall is only `console.warn` (`:124`). Pickers get routed to orders with no
stock. **Fix:** on `shortfall > 0`, set a queryable backorder/hold sub-state.

### S3-W2 · **P1** · Order creation atomic, but shipment + reservation + SS push run outside the tx
Transaction is only `createOrderWithItems` (`orders.storage.ts:649-650`). Shipment (`wms-sync.service.ts:466-472`),
reservation (`:483-485`), routing, SS push (`:504-523`) are best-effort after commit. An order can sit
`ready` in the pick queue with no shipment row and no reservation.

### S3-W5 · **P2** · `propagateOmsEditsToWms` release-then-reserve is not atomic
`wms-sync.service.ts:1115-1124`. Releases ALL reservations, then re-reserves; on failure only
`console.warn`, leaving the order under-reserved. A qty +1 edit momentarily frees the entire
reservation. **Fix:** adjust the delta, or wrap in one transaction.

### S3-W7 · **P2** · `/api/orders/sync-from-oms` is a parallel path that bypasses `WmsSyncService`
`shopify.routes.ts:746-858`. Writes WMS orders via `createOrderWithItems` directly with hardcoded
`priority:100` (`:841`), no SLA/sort_rank, no reservation, no shipment. Different dedup key
(`getOrderByExternalId`, `:762`) than the canonical advisory-lock path → duplicate-creation race.
**HYPOTHESIS:** legacy. **Fix:** delegate to `syncOmsOrderToWms`.

### S3-W4 · **P2** · `determinePriority` raw-joins `membership.*` and `channels.partner_profiles`
`wms-sync.service.ts:1217-1237`, `:217-221`. Cross-boundary inner joins. **Fix:** call membership/channels
service interfaces.

### S3-W3 · **P3** · SLA due date + sort_rank computed from un-injected `new Date()`
`wms-sync.service.ts:228-236`; `computeSortRank` supports a `now` param (`sort-rank.ts:45`) that the caller
never passes. Resync yields a different rank/SLA. **Fix:** thread one captured timestamp; persist `slaDueAt`
once.

### S3-W6 · **P3 (positive w/ caveat)** · Edit re-push correctly scoped to `planned` only
`wms-sync.service.ts:1126-1137` deliberately skips `queued`/`labeled` to avoid clobbering operator splits.
Caveat: an edit to an order whose shipments are all non-`planned` updates `wms.order_items` but never
re-pushes to SS and raises no flag → silent SS/WMS divergence.

---

## STAGE 4 — WMS picking + order state machine

Files: `picking.use-cases.ts` (2327), `orders.storage.ts` (1416), `picking.routes.ts` (1141).

### S4-F1 · **P0** · `pickItem` never re-checks parent order status/hold before deducting inventory · (confirms prior F12)
`picking.use-cases.ts:925` loads `orderForPick` but the completed-pick branch (`:948-1020`) only reads
`warehouseId`; no `warehouseStatus`/`onHold`/`cancelled` check anywhere. A pick arriving while the order
is being cancelled/held still moves physical inventory. **Fix:** inside the pick tx,
`SELECT warehouse_status,on_hold ... FOR UPDATE` and abort on cancelled/held/shipped.

### S4-F2 · **P0** · `resolveException` writes a non-existent `status` column → orders never leave `exception` · *VERIFIED* · (NEW; refines prior F27)
`orders.storage.ts:1075-1077` sets `updates.status = newStatus`, but the `orders` table column is
`warehouseStatus` (`orders.schema.ts:113`); there is no `status` column. So
`POST /api/orders/:id/resolve-exception` updates the exception_* fields but leaves `warehouse_status =
'exception'`, and a `cancelled` resolution never triggers the cancel cascades in `updateOrderStatus`
(`:819-847`). Orders resolved by a lead stay stuck. **Fix:** set `updates.warehouseStatus`; route
`cancelled` through `updateOrderStatus`.

### S4-F6 · **P1** · Inventory-deduct failure leaves item `completed` with no inventory movement
`picking.use-cases.ts:986` (deduct in tx), `:1009-1013` (item set completed first), `:1256-1288`
(deduct `success:false` does NOT roll back the item; forces order `exception`). Item shows
`completed`+`pickedQuantity` with no `inventory_transactions` pick row → ledger/status divergence;
ship-time `recordShipment` may then hit the negative guard. **Fix:** roll back item completion on
deduct failure, or write a compensating ledger entry in the same tx.

### S4-F5 · **P1** · Short-pick replen is fire-and-forget; failure creates no blocker
`picking.use-cases.ts:1079-1128`. On replen-queue throw, only UI flags + a swallowed log (`:1114-1127`);
no `allocation_exceptions` blocker (contrast `:1274`). `queueShortPickReplen` also returns null silently
when location missing (`:1389-1409`). Reservation for the un-picked qty is never released. Order sits in
`exception` with no actionable replen.

### S4-F3 · **P1** · `getPickQueueOrders` (a GET) performs data-mutating self-heal UPDATEs · (NEW emphasis)
`orders.storage.ts:520-526`, `:545-547`, `:576/584`. Every pick-queue load can transition order/item
status, re-stamp `completed_at=NOW()`, and cancel stale shipments. Violates "no side effects in read
paths"; concurrent loads race; `completed_at` becomes load-time-dependent, corrupting SLA/cycle metrics.
**Fix:** move self-heal to a background reconciler; keep the query read-only.

### S4-F10 · **P2** · Ad-hoc state machine — no enforced transition table
`orders.storage.ts:781-817` ops-owned statuses are direct writes with no from-state validation; additional
direct writes bypass `updateOrderStatus` entirely (`:522`, `:546`, `:1368`, resolveException). `cancelled →
ready` etc. are not prevented; only `updateOrderStatus` closes allocation exceptions on cancel. **Fix:**
centralize all `warehouse_status` writes through one guarded transition function.

### S4-F8 · **P2** · Business logic embedded in routes
`picking.routes.ts:66-96` (`fix-stuck-orders` re-implements the `hasShort?exception:completed` rule that
also lives in `orders.storage.ts:519,939`), `:425-477` (priority rules), `:675-729` (resolve-exception
orchestration), `:800-816` (metric math), `:841-960` (backfill uses `Math.random()` at `:887`). **Fix:**
move into `PickingUseCases`.

### S4-F4 · **P2** · Non-deterministic `completed_at=NOW()`/`new Date()` across many paths
`orders.storage.ts:522,546,810,942,945`; `picking.use-cases.ts:1004`. The done-queue 24h window
(`:329`) and cycle-time metrics derive from a re-stampable `completed_at`. **Fix:** stamp once via
`COALESCE(completed_at, NOW())`.

### S4-F7 · **P2** · `updateOrderItemStatus` drops the CAS guard for `completed` transitions
`orders.storage.ts:894-899`. Safe for the picking flow (which uses its own `FOR UPDATE` path) but the
method is not self-protecting for other callers. **Fix:** guard on `status <> 'completed'`.

### S4-F11 · **P2** · Swallowed/fire-and-forget around audit + secondary financial side effects
`picking.use-cases.ts:1225-1251` (replen), `:1771-1774` (channel sync); `orders.storage.ts:531-533,
553-555,596-598` (self-heal failures hidden); `picking.routes.ts:358,414,470,515,721` (picking-log writes).
Core inventory ledger is safe; audit/replen/channel-sync can silently desync.

### S4-F9 · **P3 (positive)** · `claimOrder` is atomic
`orders.storage.ts:678-700` conditional UPDATE; losing racer gets `IntegrityError`
(`picking.use-cases.ts:1823`). Correct.

> **Positives verified:** pick-item inventory mutation is fully transactional with `FOR UPDATE`
> and a `variantQty < qty` pre-guard (`picking.use-cases.ts:949-1020`, `inventory.use-cases.ts:147`);
> no `allowNegative:true` in the pick path.

---

## STAGE 5 — ShipStation + shipment rollup + write-back

Files: `shipstation.service.ts` (3244), `shipment-rollup.ts` (919), `fulfillment-push.service.ts` (2351).

### S5-S1 · **P1** · SHIP_NOTIFY cascade is non-atomic (partial-failure windows) — mitigated by re-runnable repair
`shipstation.service.ts:1898-2031`. No enclosing tx across shipment-status / order-rollup / OMS-derive /
inventory-record / fulfilled-qty / channel-push. `recordShipment` runs in its own tx
(`inventory.use-cases.ts:278`) and is idempotent (`:288`); shipped-replays re-run the repair cascade
(`:1932-1936`). **INSUFFICIENT EVIDENCE:** that the retry worker re-delivers a *partially-applied* shipment
that then threw. **Fix:** wrap WMS-side writes in one tx; channel pushes post-commit best-effort.

### S5-S2 · **P1** · Voided label has no automatic re-push path · (NEW)
`markShipmentVoided` (`shipment-rollup.ts:583-664`) sets `voided` (still "open" for rollup,
`order-status.ts:97`). Every automated push selector excludes it: `sync-recovery.service.ts:181-184`
(`status='planned' AND shipstation_order_id IS NULL`), `wms-sync.service.ts:1132` (`planned`), Reconcile V2
`index.ts:924` (`IN ('queued','labeled','shipped')`). A voided label silently strands the shipment.
**INSUFFICIENT EVIDENCE:** operator UI re-push route (open question 2).

### S5-S6 · **P2** · Rollup mis-derives a fully-shipped order as `partially_shipped` from stale shipments · (NEW)
`order-status.ts:185` (`anyShipped && anyOpen → partially_shipped`), with `voided/planned/queued` all
"open" (`:92-98`). `cancelStaleShipmentsIfFullyCovered` (`shipment-rollup.ts:875`) is invoked ONLY in
SHIP_NOTIFY (`shipstation.service.ts:1945-1950`), never in Reconcile V2 (`index.ts:1069`), and never cleans
`voided`. A reconcile-path transition or a leftover voided row pins the order/OMS at `partially_shipped`
forever. **Fix:** call the cleanup in Reconcile V2; include `voided` when items are fully covered.

### S5-S7 · **P2** · Combined-order Shopify fan-out: no cross-child atomicity + duplicate-fulfillment risk · (NEW; refines prior F21/F30)
`fulfillment-push.service.ts:1368-1477` loops siblings, continues on error (`:1456-1473`); each sibling
commits `shopify_fulfillment_id` independently. `fulfillmentCreateV2` has no idempotency key
(`:1287-1293`); a crash after Shopify create but before the `:1327` write-back creates a DUPLICATE
fulfillment on retry (local D1 check `:848-865` reads null). eBay (`:691-704`) and dropship (`:409`) do key
idempotency; Shopify does not. **Fix:** persist a `pending:<uuid>` intent before the mutation, or query
Shopify before create.

### S5-S9 · **P2** · No standalone job reconciles `picked_qty` against ShipStation if SHIP_NOTIFY is lost · (confirms prior F15) · **ABSENT**
`recordShipment` correctly moves picked→shipped (`inventory.use-cases.ts:303-313`) but only on a shipped
event. Grep for a picked_qty reconcile job: **no matches (ABSENT)**. The hourly Reconcile V2 only inspects
shipments with a `shipstation_order_id` in `('queued','labeled','shipped')` (`index.ts:923-924`), so a
push-failed-but-shipped shipment, or picked-without-ship, is never recovered. **Fix:** sweep for elevated
`picked_quantity` with no shipped shipment older than N hours.

### S5-S5 · **P2** · `validateShipmentForPush` total-mismatch is warn-only; hard failures aren't operator-visible
`shipstation.service.ts:478-482` (total mismatch → `console.warn`, proceeds and ships). Hard failures throw
`ShipStationPushError` but `pushShipment` doesn't catch (`:3099`), leaving the shipment in its prior status
WITHOUT `requires_review`. **Fix:** stamp `requires_review` with the structured code on persistent failure;
make total-mismatch blocking for non-partial shipments.

### S5-S4 · **P2** · Hold is synchronous+throws (good), but WMS hold-state ordering not co-located
`shipstation.service.ts:2700-2711` awaits and throws on failure (uses sentinel `holdUntilDate:"2099-12-31"`).
**INSUFFICIENT EVIDENCE:** whether the caller writes WMS `on_hold` before the SS call — if so, a failed SS
hold leaves a WMS-held order still shippable in the SS UI (open question 3).

### S5-S3 · **P2** · No `ShippingEngine` interface — ShipStation logic embedded throughout · (confirms prior F17)
`shipstation.service.ts:628-3225` hardcodes base URL, SS endpoints, orderKey scheme, carrier map, rate-limit
header, split/combined semantics. `shared/enums/order-status.ts:222-223` aspires to engine-neutral
`shipping_config` but no interface exists. **Fix:** extract a `ShippingEngine` port; ShipStation becomes one
adapter.

### S5-S8 · **P3** · Unknown/mismatched order key is silently skipped (no alert)
`shipstation.service.ts:2593-2602`, `:2180-2188`. A SHIP_NOTIFY matching neither V2 (`shipstation_order_id`)
nor a parseable legacy key returns `{processed:false}` with only a log. **Fix:** emit a metric/alert.

### S5-S10 · **P3** · Legacy SHIP_NOTIFY tail unconditionally re-writes OMS → duplicate audit events
`shipstation.service.ts:2512-2531`. **Fix:** guard with the same `changed` flag as V2.

### S5-S11 · **P3** · Legacy `shippedAt = new Date()` (receipt time, not ship date) + swallowed audit writes
`shipstation.service.ts:2210,2519` (legacy uses receipt time; V2 correctly uses `event.shipDate` at `:2099`).
Swallowed best-effort writes: tracking-history (`shipment-rollup.ts:243-247,624-628`), Shopify cancel hook
(`:656-660`). **Fix:** use SS shipDate for legacy; emit metrics on swallow branches.

---

## Prioritized action plan

### Phase 0 — Two one-line correctness bugs (do first; hours, not days)
| # | Finding | Action |
|---|---------|--------|
| 0.1 | **S3-W1** | Fix the `reserveForOrder` call to `reserveOrder(wmsOrderId)`; add a test asserting `reserved_qty` after sync. |
| 0.2 | **S4-F2** | Change `updates.status` → `updates.warehouseStatus` in `resolveException`; route `cancelled` through `updateOrderStatus`; add a test asserting status leaves `exception`. |

### Phase 1 — Stop the bleeding (P0s)
| # | Finding | Action |
|---|---------|--------|
| 1.1 | **S1-F2** | Wrap orders/cancelled in one tx; don't let the cancelled-guard skip an unconfirmed shipment cascade. |
| 1.2 | **S1-F3** | Refund restock must physically return picked/shipped units via a WMS receive path; fix `restocked` truthiness. |
| 1.3 | **S4-F1** | Re-check `warehouse_status`/`on_hold` under `FOR UPDATE` inside `pickItem`; reject picks on cancelled/held/shipped. |
| 1.4 | **S2-E1** | Route dropship acceptance reservation through `reserveForOrder()`; stop writing `inventory_levels` directly. |
| 1.5 | **S1-F9** | Resolve the bridge/webhook `externalOrderId` format question; unify normalization to prevent duplicate OMS rows. *(verify open Q1 first)* |

### Phase 2 — Harden the seams (P1s)
| # | Finding | Action |
|---|---------|--------|
| 2.1 | **S3-W2 / S5-S1** | Introduce a transactional unit-of-work for sync (order+items+reservation+shipment) and the SHIP_NOTIFY WMS writes. |
| 2.2 | **S1-F1 / S2-E2 / S3-W4** | Define a WMS interface for order-status/items/shipment mutations; remove raw `wms.*` writes from OMS/eBay. |
| 2.3 | **S2-E3 / S2-E4 / S2-E5** | Build eBay + dropship cancel/refund cascades mirroring Shopify (release reservation, return goods, line-level partial). |
| 2.4 | **S3-W8** | On reservation shortfall, set a queryable backorder/hold sub-state; surface in ops dashboard. |
| 2.5 | **S1-F4 / S4-F6 / S4-F5** | Reverse picked inventory on cancel; reconcile item-status vs ledger on deduct failure; make short-pick replen durable. |
| 2.6 | **S1-F5 / S1-F6 / S1-F7** | Move refund idempotency check to the top; compute financial status cumulatively; allow NULL `wms.returns.shipment_id`. |
| 2.7 | **S5-S2 / S5-S6** | Auto re-push voided labels; run `cancelStaleShipmentsIfFullyCovered` in Reconcile V2; clean `voided` leftovers. |
| 2.8 | **S5-S7** | Add Shopify fulfillment idempotency (pending-intent or pre-create query); group-level retry for combined orders. |
| 2.9 | **S4-F3** | Move pick-queue self-heal out of the GET into a background reconciler. |
| 2.10 | **S1-F8** | Make the bridge record failures durably; stop counting failed bridges as success. |

### Phase 3 — Architecture, determinism, observability (P2/P3)
| # | Finding | Action |
|---|---------|--------|
| 3.1 | **S4-F10** | One guarded `warehouse_status` transition function with an allowed-from-state matrix. |
| 3.2 | **S5-S3** | Extract a `ShippingEngine` port; ShipStation as the first adapter. |
| 3.3 | **S5-S9** | Add a `picked_qty`-vs-ShipStation reconciliation sweep. |
| 3.4 | **S3-W7** | Make `/api/orders/sync-from-oms` delegate to `syncOmsOrderToWms`. |
| 3.5 | **S4-F8** | Move route business logic into use-cases; remove `Math.random()` in the log backfill. |
| 3.6 | **S2-E9 / S2-E7** | Use the integer money parser in the OMS eBay path; return an explicit `inserted` flag from `ingestOrder`. |
| 3.7 | **S3-W3 / S4-F4 / S5-S11** | Inject one timestamp through SLA/sort-rank/rollup; stamp `completed_at`/`shippedAt` once from the true source. |
| 3.8 | **S5-S5 / S5-S8 / S1-F14 / S2-E6** | Surface failed validations/unknown keys/dropped webhooks as `requires_review` or metrics/alerts. |
| 3.9 | **S1-F15** | Use a dedicated webhook-retry secret, not `SESSION_SECRET`. |

---

## Open questions — cross-stage verification required before some fixes

1. **(Blocks S1-F9 severity)** Is `shopify_orders.id` the Shopify numeric order id or a local surrogate PK?
   If surrogate, the bridge and webhook create duplicate `oms_orders`.
2. **(S5-S2)** Is there an operator UI/route that calls `pushShipment` on `voided` shipments?
   (`oms-webhooks.ts:1132` calls `pushShipment` — verify its selector.)
3. **(S5-S4)** Does the hold caller write WMS `on_hold` before `putOrderOnHold`, so a failed SS hold
   can't leave a held order shippable in the SS UI?
4. **(S5-S1 / S2-E6)** Does `webhook-retry.worker.ts` re-deliver and re-run a *partially-applied* event,
   or can it drop it?
5. **(S2-E1)** Does `atpService` read `inventory_levels.reserved_qty`? If yes, dropship's direct writes and
   the reservation service can diverge on ATP.
6. **(S1-F11)** Is `flaggedForReview` persisted to any durable queue, or only logged?
7. **(General)** Does `inventoryCore.reserveForOrder` ever pass `allowNegative:true`? (Out of scope here;
   the whole ATP gate depends on it. No `allowNegative` found in the in-scope files.)

---

*Grounded in code as of branch `claude/fix-order-release-error-sHWUf`, HEAD 2026-05-28. Citations are
`file:line`; verify the cited lines before acting on any single finding.*
