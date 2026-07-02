# Audit 03 — OMS→WMS Sync & Reservation Subsystem

Scope: `server/modules/oms/wms-sync.service.ts`, `server/modules/oms/oms-flow-reconciliation.service.ts`,
reservation implementation (`server/modules/channels/reservation.service.ts` +
`server/modules/inventory/application/inventory.use-cases.ts`), `backfillUnsynced`, and the
reconciliation sweeps wired in `server/index.ts`. All claims cite file:line. Statements not
provable from code are labeled HYPOTHESIS or INSUFFICIENT EVIDENCE.

---

## 1. SUBSYSTEM MAP

### Forward sync (OMS → WMS)
- **`WmsSyncService.syncOmsOrderToWms(omsOrderId)`** — `server/modules/oms/wms-sync.service.ts:123-673`.
  Pipeline: load OMS order (125-136) → terminal-state short-circuit + WMS cancel cascade (138-144) →
  already-synced fast path with header refresh / line reconcile / promote-and-reserve (147-190) →
  out-of-band-fulfilled guard (202-209) → financial snapshot validation (224-249) → routing (259-269) →
  **single transaction**: advisory lock `pg_advisory_xact_lock(918407, omsOrderId)` (402), in-tx duplicate
  recheck (407-427), `ordersStorage.createOrderWithItems` (430), shipment create/link (437-556) →
  **reservation OUTSIDE the tx** (561-580) → engine push with OMS-final recheck (612-659).
- Callers: Shopify bridge enqueue (`server/modules/oms/shopify-bridge.ts:190-209` via retry queue),
  webhook retry worker (`server/modules/oms/webhook-retry.worker.ts:854`), eBay ingestion
  (`server/modules/oms/ebay-order-ingestion.ts:53`), dropship acceptance dispatch
  (`server/modules/dropship/application/dropship-fulfillment-sync-dispatch.ts:67`), dropship ops
  (`server/modules/dropship/application/dropship-order-ops-service.ts:506`),
  `backfillUnsynced` (below).
- **`backfillUnsynced(limit=100)`** — `wms-sync.service.ts:1626-1666`. NOT EXISTS on the canonical link
  `(source='oms' AND oms_fulfillment_order_id = oo.id::text)` + legacy shopify fallback; excludes
  terminal/fulfilled OMS orders (1651-1653). Scheduled via SyncRecovery every 15 min
  (`server/index.ts:685-689`, `server/modules/sync/sync-recovery.service.ts:144-165`,
  default limit 50) and exposed as a route (`server/modules/inventory/inventory.routes.ts:1980-1987`).
- **`propagateOmsEditsToWms`** — `wms-sync.service.ts:1185-1520` (orders/updated webhook,
  called from `server/modules/oms/oms-webhooks.ts:1895`).
- **`reconcileCancellations`** — `wms-sync.service.ts:1676-1748` (route-triggered,
  `inventory.routes.ts:1962-1969`): flips `oms.oms_orders` to cancelled by raw SQL (1721-1728) then runs
  `cancelOrderCascade`.
- **`resyncOrderItems` / `repairBrokenOrders`** — `wms-sync.service.ts:1828-1939` (destructive item
  delete + re-insert; see risks).

### Reservation stack
- Facade: **`ReservationService`** — `server/modules/channels/reservation.service.ts` (note: lives in
  the *channels* module, not inventory or WMS).
  - `reserveForOrder(productId, variantId, qty, orderId, orderItemId)` — :90-222. ATP-gated
    (`atpService.getAtpPerVariant`, :106), picks assigned bin from `product_locations` (:140-158) with
    `inventory_levels` fallback (:164-191), delegates to `inventoryCore.reserveForOrder` (:202-209).
  - `reserveOrder(orderId)` — :239-318. Per-item loop over `wms.order_items`, SKU→variant resolve,
    failures collected, channel sync fired.
  - `releaseOrderReservation(orderId, reason)` — :334-445. Per-item: releases up to `item.quantity`
    from **any** `inventory_levels` row of that variant with `reservedQty > 0` (:369-384).
  - `reallocateOrphaned` — :464-632 (cycle-count orphan repair; force-release via
    `inventoryCore.adjustLevel` :504 + unreserve ledger row :509-516).
  - `autoReserveOnSync(shopifyOrderId)` — :720-799 (legacy Shopify listener path).
- Core primitives: **`InventoryUseCases`** — `server/modules/inventory/application/inventory.use-cases.ts`.
  - `reserveForOrder` — :550-626. Transactional; **idempotent** on `(order_id, order_item_id)` via
    ledger pre-check (:564-575) + unique partial index `uq_inventory_transactions_reserve_dedup`
    (`migrations/0577_reservation_dedup_and_freeze_index.sql:66`; 23505 treated as success :609-615).
  - `releaseReservation` — :628-679. Transactional, row-locked (`lockInventoryLevel` :640), throws when
    `reservedQty < qty` (:647). **No idempotency key** — every call decrements again.
  - `adjustInventory` — :460-544. On negative adjustments below reserved, auto-drains `reservedQty`
    and reports `orphanedQty` (:497-507).

### Reconcilers touching this state
- **`oms-flow-reconciliation.service.ts`** — 15-min scheduler under advisory lock 918405
  (:1193-1213, started at `server/index.ts:792-793`). Detects 8 issue classes (:125-560); auto-remediates
  up to 10 samples per class (:575-671): `OMS_FINAL_WMS_ACTIVE` → `cancelOrder(tx)`/`markOrderShipped(tx)`
  (:1005-1054); `WMS_FINAL_OMS_OPEN` / `SHIPMENT_SHIPPED_OMS_OPEN` → raw UPDATE of `oms.oms_orders`
  (:1056-1174); others enqueue retries.
- **Hourly OMS↔WMS sweep** — `server/index.ts:899-981`. Finds WMS rows in
  `ready/in_progress/ready_to_ship/completed` whose OMS order is `cancelled/shipped/refunded` (:902-911);
  calls `markOrderShipped`/`cancelOrder` (:914-916), nulls picker (:918), cascades engine cancel and
  writes `wms.outbound_shipments` status directly (:931-967).
- **Boot-time data repair** — `server/index.ts:987-1060` (item completion, orphan shipment cancel,
  zombie `cancelOrder`/`completeOrder` :1044-1052).
- **Webhook cancel path** — `cancelOrderCascade` (`server/modules/oms/oms-webhooks.ts:345-446`):
  release reservations (:390) → shipment cascade → `cancelOrder` (:429) → OMS event (:434).

---

## 2. STATE & WRITERS (schema.table → writing functions)

### `wms.orders` (row creation)
| Writer | Evidence |
|---|---|
| `WmsSyncService.syncOmsOrderToWms` → `ordersStorage.createOrderWithItems` → `insertWmsOrder` | `wms-sync.service.ts:430`; `server/modules/orders/orders.storage.ts:795-845`; `server/modules/wms/insert-order.ts:48-82` |
| **`POST /api/shopify/...sync-from-raw` route** — direct `storage.createOrderWithItems` from a route handler | `server/routes/shopify.routes.ts:968-992` |
| **Manual-order route** — direct `storage.createOrderWithItems` from a route handler | `server/modules/channels/channels.routes.ts:352` |

`insertWmsOrder` is the single physical INSERT (`insert-order.ts:71-74`; only drizzle
`insert(wmsOrders)` in the repo — grep of `INSERT INTO wms.orders|insert(wmsOrders)` returned exactly
this site). But three *logical* creators exist above. Dedup: advisory lock + in-create recheck by
`(source='oms', omsFulfillmentOrderId)` then `externalOrderId` (`orders.storage.ts:49-93,797-800`),
plus partial unique index `uq_wms_orders_oms_fulfillment_active` (`migrations/0581_wms_orders_oms_fulfillment_dedup.sql:10`;
best-effort startup copy `server/db.ts:1055-1069`) — index **excludes cancelled rows** and only covers
`source='oms'`.

### `wms.orders.warehouse_status` (and picker/cancelled_at/completed_at)
| Writer | Evidence |
|---|---|
| `transitionOrderStatus`/`cancelOrder`/`markOrderShipped`/`completeOrder` (guarded gate) | `server/modules/orders/order-status-core.ts:143-272` |
| syncOmsOrderToWms header refresh (promote pending→ready, SLA/sort_rank) — direct `db.update(wmsOrders)` | `wms-sync.service.ts:806-816` |
| reconcileExistingWmsOrderLines — raw `UPDATE wms.orders SET warehouse_status = CASE…` (can flip to ready/completed/cancelled outside the gate) | `wms-sync.service.ts:1045-1079` |
| propagateOmsEditsToWms — raw count update | `wms-sync.service.ts:1432-1439` |
| index.ts sweeps — picker null + via gate | `server/index.ts:918` |
| oms-flow-reconciliation — picker null + via gate | `oms-flow-reconciliation.service.ts:1031` |
| Legacy route `storage.updateOrderStatus(order.id, "cancelled")` | `server/routes/shopify.routes.ts:1274` |

### `wms.order_items`
| Writer | Evidence |
|---|---|
| createOrderWithItems (initial insert, in tx) | `orders.storage.ts:822-830` |
| reconcileExistingWmsOrderLines — qty edits (:903-925), missing-line inserts (:948-973), raw financial re-stamp (:982-991) | `wms-sync.service.ts` |
| propagateOmsEditsToWms — qty/SKU/cancel updates (:1258-1361), new-item inserts (:1392-1408) | `wms-sync.service.ts` |
| resyncOrderItems — **DELETE all + re-insert** | `wms-sync.service.ts:1842-1874` |
| index.ts data repair — bulk complete | `server/index.ts:989-999` |

### `inventory.inventory_levels.reserved_qty`
| Writer | Path through owner? | Evidence |
|---|---|---|
| `inventoryCore.reserveForOrder` (+ dedup) | yes (owner) | `inventory.use-cases.ts:550-626` |
| `inventoryCore.releaseReservation` | yes (owner) | `inventory.use-cases.ts:628-679` |
| `inventoryCore.adjustInventory` orphan drain | yes (owner) | `inventory.use-cases.ts:497-507` |
| `ReservationService.reallocateOrphaned` via `adjustLevel` | borderline (skips ledger-first design, writes level then manual ledger row) | `reservation.service.ts:504-516` |
| **Dropship acceptance — raw SQL `SET reserved_qty = reserved_qty + $1`** | **NO — bypasses `reserveForOrder()` entirely** | `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:865-871` |

### `oms.oms_orders` (reverse-direction writes from this subsystem)
- `reconcileCancellations` raw `UPDATE oms.oms_orders SET status='cancelled'` — `wms-sync.service.ts:1721-1728` (module = OMS, acceptable owner but bypasses any OMS status gate).
- `remediateOmsFlowIssue` WMS_FINAL_OMS_OPEN / SHIPMENT_SHIPPED_OMS_OPEN raw UPDATEs — `oms-flow-reconciliation.service.ts:1069-1100, 1130-1149`.
- eBay hourly sweep raw UPDATE — `server/index.ts:856-863`.

---

## 3. BOUNDARY VIOLATIONS

1. **Dropship reservation bypass (worst violation).**
   `reserveInventoryWithClient` (`dropship-order-acceptance.repository.ts:845-919`) reserves inventory
   with raw SQL against `inventory.inventory_levels` (:865-871) and hand-writes a `'reserve'`
   `inventory_transactions` row (:872-891) with **no `order_id`/`order_item_id`**
   (`reference_type='dropship_order_intake'`). This violates BOUNDARIES.md:235 ("Every reservation goes
   through `reserveForOrder()` — no raw SQL, no reimplementation") and the sole-writer matrix
   (BOUNDARIES.md:156). Consequences in §4-C1.

2. **Routes create `wms.orders` rows directly.**
   `server/routes/shopify.routes.ts:968` and `server/modules/channels/channels.routes.ts:352` call
   `storage.createOrderWithItems` from HTTP handlers, bypassing `WmsSyncService` (no reservation, no
   financial snapshot, no shipment row, no routing/SLA). Violates CLAUDE.md §16 ("never write to the DB
   directly from controllers/routes") and undermines "syncOmsOrderToWms is the creator".

3. **Reservation service lives in the Channels module.**
   BOUNDARIES.md:89 places the Reservation Service "inside WMS"; the implementation is
   `server/modules/channels/reservation.service.ts` and reads/writes `wms.order_items`
   (:249-252) and `inventory_levels` (:369-377) from Channels. BOUNDARIES.md:113 says Channel Sync
   "Does NOT … create orders or reservations". Module placement contradicts the documented ownership.

4. **Reconcilers write both sides' tables.**
   `remediateOmsFlowIssue` raw-updates `oms.oms_orders` (:1069-1100, 1130-1149) and index.ts sweeps
   raw-update `oms.oms_orders` (:856-863) and `wms.outbound_shipments` (:949-960) from the composition
   root. BOUNDARIES.md:163-171 explicitly calls the reconciler/OMS-direct-write pattern the "reverse
   leak … to eliminate".

5. **`allowNegative: true` in production code.**
   `inventory.use-cases.ts:1172` (3PL virtual-location sync) — direct violation of CLAUDE.md §16 and
   BOUNDARIES.md:234. Mitigating: it is inside the owning module and targets a non-pickable virtual bin
   (:1134-1141), but the prohibition is absolute.

6. **Raw cross-schema status flip in reconcile path.**
   `reconcileExistingWmsOrderLines` raw `UPDATE wms.orders SET warehouse_status = CASE …`
   (`wms-sync.service.ts:1045-1079`) bypasses `transitionOrderStatus`, the self-described "sole guarded
   writer of warehouse_status" (`order-status-core.ts:2-6`). It can resurrect (`→'ready'`) or terminate
   (`→'cancelled'`) an order outside the matrix.

---

## 4. CORRECTNESS RISKS (ranked)

### CRITICAL

**C1. Dropship orders are double-reserved, and the raw reservation is never released.**
Trace: acceptance reserves raw (`dropship-order-acceptance.repository.ts:865-891`) → acceptance
dispatch calls `syncOmsOrderToWms` (`dropship-fulfillment-sync-dispatch.ts:67`) → OMS order was created
`'confirmed'/'paid'` (`dropship-order-acceptance.repository.ts:735-736`) → `determineWarehouseStatus`
returns `"ready"` (`wms-sync.service.ts:682`) → step 6 calls `reservation.reserveOrder(wmsOrderId)`
(:572). The core dedup keys on `(order_id, order_item_id)` (`inventory.use-cases.ts:564-575`); the raw
dropship row has neither, so the second reserve proceeds → **reserved twice per dropship order**
(bounded only by remaining ATP). No release path for the raw reservation exists anywhere in
`server/modules/dropship` (grep for `unreserve|releaseReservation|reserved_qty -` returns only the
`+` write). On cancel, `releaseOrderReservation` releases only the WMS-order quantity once → the raw
reservation **leaks permanently**, understating ATP (undersell). Since migration
`055_drop_over_reservation.sql:4` dropped `chk_reserved_lte_onhand`, nothing at the schema stops
`reserved_qty` from exceeding on-hand.

**C2. `releaseOrderReservation` is neither idempotent nor scoped to the order's own reservations.**
`reservation.service.ts:369-384`: it selects **any** `inventory_levels` rows of the variant with
`reservedQty > 0` and releases `min(item.quantity, level.reservedQty)` — regardless of whether *this*
order reserved anything (partial reserve, zero reserve, or already-released). Every duplicate call
drains **other orders' reservations** → ATP overstated → oversell. Duplicate-call windows exist:
- `cancelOrderCascade` selects WMS rows with **no warehouse_status filter** (`oms-webhooks.ts:360-364`)
  and releases unconditionally (:390) — a replayed/second cancel-ish webhook or the historical repeat
  cascade (the code's own comment cites order #57977 accumulating **8 cascades**, `oms-webhooks.ts:1031-1036`)
  re-releases each time.
- `cancelExistingWmsOrderForFinalOmsOrder` (`wms-sync.service.ts:708-746`) releases then cancels with
  **no transaction and no lock**; it is invoked on *every* sync/reconcile touch of a final OMS order
  (:139, :846, :622). Two concurrent invocations (webhook retry × 15-min reconciler × hourly sweep)
  both pass the `warehouse_status NOT IN ('cancelled','shipped')` read (:716) before either cancels →
  double release. A crash between release and cancel leaves the row matching → next run releases again.
- Manual API (`inventory.routes.ts:1068`) and legacy route (`shopify.routes.ts:1277`) add more
  unguarded callers.

**C3. Release → re-reserve is a silent no-op: reserve ledger rows are never voided.**
The reserve dedup treats any non-voided `'reserve'` row as "already reserved"
(`inventory.use-cases.ts:564-575`), but nothing ever sets `voided_at` (repo-wide grep: only the two
read sites, `inventory.use-cases.ts:105,570`); `releaseReservation` writes an `'unreserve'` row without
voiding the `'reserve'` row (:660-675). Therefore `propagateOmsEditsToWms`'s rebalance —
`releaseOrderReservation` then `reserveOrder` (`wms-sync.service.ts:1443-1447`) — releases real
`reserved_qty` and then **re-reserves nothing** for every previously-reserved item. Every edited order
ends up unreserved while the ledger claims it is reserved. Same defect poisons any future
cancel/un-cancel or manual release→re-reserve flow.

**C4. Reconciler-driven cancels never release reservations (reservation leak).**
`cancelOrder()` only flips status (`order-status-core.ts:214-229`). Callers that skip the release:
- Hourly sweep: `server/index.ts:914-916` (`cancelOrder(db, row.id, "oms_wms_reconcile")` — no release).
- 15-min auto-remediation `OMS_FINAL_WMS_ACTIVE`: `oms-flow-reconciliation.service.ts:1026` (no release).
- Zombie repair: `server/index.ts:1047`.
Contrast the two paths that *do* release: `wms-sync.service.ts:722` and `oms-webhooks.ts:390`. Any
cancel that reaches WMS via a reconciler instead of a webhook leaks the reserved units permanently
(ATP understated → undersell). Note the interlock: the reconcilers exist precisely for **missed
webhooks** — i.e., exactly the cases where the releasing path never ran.

### HIGH

**H1. (WMS order + items + reservation) is NOT one transaction; reservation failure is swallowed.**
Order+items+shipment commit atomically (`wms-sync.service.ts:386-559`); reservation runs after commit
(:561-580) with a comment citing `chk_reserved_lte_onhand` poisoning the tx — a constraint dropped by
`migrations/055_drop_over_reservation.sql:4` (stale rationale; INSUFFICIENT EVIDENCE whether prod still
has the constraint from a manual re-add — not in migrations). On failure/partial failure the code only
`console.warn/error`s (:573-578; promotion path :181-186) — no retry row, no `requires_review`, no
event. No reconciler re-reserves (the 8 issue classes in `oms-flow-reconciliation.service.ts:125-560`
cover missing WMS rows/shipments/pushes, never missing reservations). A crash between commit and
step 6 yields a permanently unreserved `ready` order. Inverse orphan (reservation without order) cannot
happen — reservation always follows the committed order — but orphaned *reservations on cancelled
orders* arise via the C2/C4 interleavings.

**H2. Concrete losing interleaving: cancel webhook lands between sync-tx commit and step-6 reserve.**
t1: sync tx commits (order `ready`, shipment `planned`). t2: Shopify cancel webhook →
`cancelOrderCascade` releases (nothing reserved yet — and per C2 may steal other orders' units) and
cancels the WMS order. t3: sync step 6 checks only the **stale in-memory** `warehouseStatus === "ready"`
(:568) — it does not re-read the row — and reserves inventory **for a now-cancelled order**. t4: the
self-heal recheck (:619-623) runs only `if (engine?.isConfigured?.())` (:617) **and**
`shipmentIdForPush !== null` (:618); for combined-child orders `shipmentIdForPush` is forced null
(:502), and if the engine is unconfigured the whole block is skipped → nothing releases the reservation;
the reconcilers that later observe OMS-final/WMS-cancelled do not release (C4). Result: permanent
reserved leak. The status side of the fight is safe (guarded transitions, terminal states,
`cancelled→shipped` truth-wins, `order-status-core.ts:45-88`); the **reservation side-effects are the
unguarded resource** all three actors fight over.

**H3. Duplicate WMS-order creators with weaker invariants.**
`shopify.routes.ts:968` route creates `source:'oms'` rows with no reservation/financial
snapshot/shipment; its own pre-check keys on `externalOrderId` (:907), not the canonical link (the
storage-level recheck `orders.storage.ts:61-93` saves dedup, but the row it creates diverges from
sync-created rows). `channels.routes.ts:318-352` manual orders go straight to `ready` **without any
reservation**, so pickers pick unreserved stock and ATP oversells to channels.

**H4. `releaseOrderReservation` releases post-edit quantities, not what was reserved.**
It derives release amounts from the *current* `item.quantity` (`reservation.service.ts:365`), which
`propagateOmsEditsToWms`/`reconcileExistingWmsOrderLines` mutate *before* releasing
(`wms-sync.service.ts:1309-1332` precede :1443). Qty 5→2 edit: releases 2 of 5 (3 leak). Qty 2→5:
attempts 5 (drains 3 of someone else's, per C2). Partial reservations (ATP shortfall path,
`reservation.service.ts:117-123`) mis-release the same way.

### MEDIUM

**M1. `resyncOrderItems` breaks the reservation ledger linkage.**
It deletes all `wms.order_items` and re-inserts with new ids (`wms-sync.service.ts:1842-1874`) without
touching reservations. Existing `'reserve'` rows point at dead `order_item_id`s → the dedup key no
longer matches (double-reserve if anything re-reserves) and item-scoped release/repair semantics are
lost. `repairBrokenOrders` can trigger this in bulk (:1929-1931).

**M2. Raw status CASE-update bypasses the transition gate.**
`wms-sync.service.ts:1045-1079` can move `completed→ready` or `→cancelled` outside
`transitionOrderStatus` — no audit trail, no matrix. The hourly sweep also targets `'completed'` rows
(`server/index.ts:910`) so the two can ping-pong a completed order (cancel via gate is legal from
`completed`, `order-status-core.ts:82-86`).

**M3. Idempotency backstop is best-effort and partially stale.**
The comment at `wms-sync.service.ts:393-395` claims "no unique constraint … at the DB", but
`uq_wms_orders_oms_fulfillment_active` exists (migration 0581 + `db.ts:1055-1063`). The startup copy
swallows creation failure with just a log (`db.ts:1064-1068`), and the index excludes cancelled rows and
non-`'oms'` sources — a legacy `source='shopify'` row (route H3) escapes it. Advisory-lock namespaces
are distinct (918405 reconciler / 918406 shipment / 918407 sync; `oms-flow-reconciliation.service.ts:13`,
`wms-sync.service.ts:398-402`).

**M4. Error classification absent on the reservation path.**
CLAUDE.md §6 requires transient/permanent/fatal classification. Reservation failures are logged raw
(`console.warn/error`, `wms-sync.service.ts:182-186, 573-578`; `reservation.service.ts:300-307,
399-423`) with no class, no dead-letter, no retry. Only the cancel-release failure gets a
`requires_review` event (`wms-sync.service.ts:731-739`, `oms-webhooks.ts:398-407`) — and nothing in
scope consumes that event (INSUFFICIENT EVIDENCE of any consumer).

**M5. `syncBatch` mislabels intentional skips as failures.**
`wms-sync.service.ts:1610-1616` counts `null` (documented as "no-op success", :117-121) in `failed` —
noisy metrics for `backfillUnsynced` (its callers report `synced` only, :1664-1665, so impact is logs).

### LOW

**L1.** `determinePriority` reads `membership.*` cross-schema directly from the OMS module
(`wms-sync.service.ts:1563-1572`) — read-only, but a cross-boundary inner join per BOUNDARIES.md:14.
**L2.** `slaStatusFor`/`computeSortRank` use ambient `new Date()` (`wms-sync.service.ts:98,294-299`) —
non-injected clock (CLAUDE.md §3); not financial, but untestable determinism.
**L3.** Manual release endpoint (`inventory.routes.ts:1068`) does not check order state before draining
reservations of an active order.

---

## 5. SEAM ASSESSMENT

- **The seam the docs promise (`reserveForOrder()` as WMS's single published entry point) is ~90% real
  in call-graph terms**: OMS/webhooks/wms-sync all route through `ReservationService` →
  `inventoryCore`. The two breaches are dropship (raw SQL, §3.1) and the module placement (the
  "WMS-owned" service physically lives in `channels/`, §3.3).
- **The reservation seam is quantity-only, not identity-bearing.** `inventory_levels.reserved_qty` is an
  aggregate counter; per-order truth lives only in `inventory_transactions` and is consulted for reserve
  dedup but **not** for release. That asymmetry is the root cause of C2/C3/H4. A modular monolith with
  single-writer ownership needs a first-class reservation entity (order_item ↔ location ↔ qty, with
  state) so release is "delete/void my rows", not "guess from current quantities".
- **`wms.orders` creation seam** is nearly consolidated behind `insertWmsOrder` (physical) but not
  behind `WmsSyncService` (logical) — two routes still compose their own rows.
- **Status seam** (`order-status-core`) is a good pattern (guarded UPDATE, matrix, terminal states) and
  is what makes the sync/reconciler/webhook status races benign; it is undermined by one raw CASE-update
  (M2) and — more importantly — it does not own the *side effects* of transitions (reservation release,
  engine cancel), so every caller re-implements or forgets them (C4).
- **Reconciler seam**: three overlapping reconcilers (15-min flow reconciliation, hourly index.ts sweep,
  boot repair) with different predicates and different side-effect completeness. They agree on status
  direction (OMS-final wins), so they converge; they disagree on reservation handling, so inventory
  truth diverges.

---

## 6. REFACTOR RECOMMENDATIONS

1. **Make cancellation-with-release the only WMS cancel primitive.** Add
   `wms.cancelOrder(orderId, reason)` in the WMS module that atomically (one tx): release this order's
   reservations (by ledger rows, see #2) → `transitionOrderStatus(→cancelled)` → emit event. Migrate
   `oms-flow-reconciliation.service.ts:1026`, `server/index.ts:916,1047`, `oms-webhooks.ts:390-429`,
   and `wms-sync.service.ts:708-746` onto it; delete their bespoke sequences. This closes C4 and shrinks
   C2's duplicate-call surface to one guarded place.
2. **Make release ledger-driven and idempotent.** Release = void this order-item's non-voided
   `'reserve'` rows (set `voided_at`) and decrement exactly those quantities at exactly those locations,
   inside one tx keyed on the rows' `FOR UPDATE`. Re-reserve after release then works because the dedup
   checks `voided_at IS NULL` (`inventory.use-cases.ts:570`) — fixing C2, C3, and H4 in one schema-true
   change. Add the mirror unique index for `'unreserve'` per (reserve-row id).
3. **Route dropship through the seam.** Replace
   `dropship-order-acceptance.repository.ts:845-919` with `reservationService.reserveOrder(...)`
   (or defer reservation entirely to `syncOmsOrderToWms`, which already runs for every accepted order —
   the simplest fix is to *delete* the raw reservation and let the existing sync step 6 do it).
4. **Move reservation into the WMS/inventory module** (BOUNDARIES.md:89) and export it from the WMS
   public interface; forbid `channels/*` from importing `wms.order_items`.
5. **Reservation durability:** persist reservation failures from `wms-sync.service.ts:573-578` to the
   retry queue (like push failures, :643-647) and add a `WMS_READY_UNRESERVED` issue class to
   `collectOmsFlowReconciliationIssues` so a crashed step-6 is self-healing (closes H1).
6. **Kill the two route-level creators** (`shopify.routes.ts:968`, `channels.routes.ts:352`): both
   should call `wmsSync.syncOmsOrderToWms(omsOrderId)` after OMS ingestion. Then tighten
   `uq_wms_orders_oms_fulfillment_active` to a hard migration (fail loudly, not best-effort) and delete
   the stale "no unique constraint" comment (`wms-sync.service.ts:393-395`).
7. **Re-read order state inside step 6** (`WHERE warehouse_status='ready'` guard on the reserve, or
   move reservation into the tx now that `chk_reserved_lte_onhand` is gone) and run the OMS-final
   recheck (:619-623) unconditionally, not only when an engine push is pending (closes H2).
8. **Collapse the hourly index.ts sweep into the 15-min flow reconciler** — same predicate family,
   one advisory lock, one side-effect implementation; the composition root should schedule, not embody,
   reconciliation logic.
9. Remove `allowNegative: true` at `inventory.use-cases.ts:1172` (model 3PL virtual stock as a set-to
   operation with explicit sign handling, or flag negatives for review per BOUNDARIES.md:234).

---

## 7. UNKNOWNS

- **Production schema state**: dev DB is empty (CLAUDE.md); whether `uq_wms_orders_oms_fulfillment_active`
  and `uq_inventory_transactions_reserve_dedup` actually exist on Heroku prod, and whether
  `chk_reserved_lte_onhand` was manually re-added after migration 055, **cannot be verified from the
  repo** (the `wms-sync.service.ts:562-567` comment implies the check constraint still fires in some
  environment — contradicting migration 055).
- **`lots.service.ts` reserve/release-from-lots** (`inventory.use-cases.ts:584-591, 651-657`) was not
  audited; lot-level reservation may have its own drift under C2/C3.
- Whether any consumer/alert exists for `cancel_release_failed` / `requires_review` events —
  INSUFFICIENT EVIDENCE in scope.
- `cascadeShopifyCancelToShipments` / `shipment-rollup` internals (invoked at `oms-webhooks.ts:411`)
  — could add further status writers; not traced here.
- Whether the Shopify "sync-from-raw" route (`shopify.routes.ts:900-1003`) is still reachable/used in
  production (it may be legacy) — HYPOTHESIS: legacy, but it is registered and unauthenticated beyond
  `requireAuth`.
- Runtime frequency of `propagateOmsEditsToWms` (drives C3 exposure) — depends on Shopify
  orders/updated volume; not measurable from code.
