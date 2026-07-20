# Audit 05 — WMS OPERATIONS (pick queue, picking, shipment rollup, holds, warehouse config)

Scope: `server/modules/orders/**`, `server/modules/warehouse/**`, `server/modules/wms/**`, plus repo-wide enumeration of writers of `wms.orders.warehouse_status` and `wms.outbound_shipments.status`/`held`.
Method: direct file reads + repo-wide grep; out-of-module writer enumeration delegated to a search agent and spot-verified against my own greps. Every claim below carries file:line evidence. Statements not directly verifiable are labeled HYPOTHESIS or INSUFFICIENT EVIDENCE.

---

## 1. SUBSYSTEM MAP

### orders module (`server/modules/orders/`)
- **order-status-core.ts** — `transitionOrderStatus()` + convenience `cancelOrder`/`markOrderShipped`/`completeOrder`. Self-described "sole guarded writer of warehouse_status" (order-status-core.ts:2). Transition matrix (45–88), guarded `UPDATE ... WHERE warehouse_status IN (...)` (177–186).
- **shipment-rollup.ts** — `markShipmentShipped` (199), `markShipmentCancelled` (357), `markShipmentVoided` (624), `handleAddressChangeOnShipment` (465), `handleCustomerCancelOnShipment` (540), `dispatchShipmentEvent` (923), `recomputeOrderStatusFromShipments` (758), `cancelStaleShipmentsIfFullyCovered` (979). Header claims these are the ONLY writers of shipment status and (post-C16) of warehouse_status (shipment-rollup.ts:4–8).
- **orders.storage.ts** — pick-queue query (389–535) with self-heal writes (696–787), `claimOrder` (847), `releaseOrder` (920), `forceReleaseOrder` (960), `updateOrderStatus` (990), `updateOrderProgress` (1135), order/item holds (1176–1215), `resolveException` (1278), OMS→WMS reconcile helpers (1408–1456), diagnostics/fixers (1521–1614).
- **picking.use-cases.ts** — `pickItem` (903, the core pick transaction), `_deductInventory` (1604), `claimOrder`/`releaseOrder`/`markReadyToShip` (1845–1971), `resolveAllocationWithBin` (496), bin count (2104), `getPickQueue` (2213).
- **picking.routes.ts** — HTTP adapters for the above + order/line-item hold endpoints (405–615), exception resolution (862), log backfill (1028), metrics/history.
- **picking-logs.storage.ts** — `createPickingLog` insert + read/aggregation only (56–317).
- **sla-monitor.service.ts** — writes only `wms.orders.sla_status` via guarded batch UPDATEs (119–162).
- **combining.service.ts** — order combining + `markGroupPacked`/`markGroupShipped` (954–1000).
- **fulfillment.service.ts** — legacy shipment creation/confirmation: `confirmShipment` (180), `processShopifyFulfillment` (286), `markDelivered` (649), `confirmShipmentInternal` (674).
- **fulfillment-router.service.ts** — warehouse routing; `assignWarehouseToOrder` (150) writes `warehouseStatus='awaiting_3pl'`.
- **shipment-rollup consumers**: `updateOrderStatus` shipped/partially_shipped path (orders.storage.ts:996–1013).
- **sla/sort-rank, returns.service.ts (no DB writes found), operations-dashboard.{service,routes}.ts (read-only; no UPDATE/INSERT found), order-history.storage.ts (read)**.
- **Packing/boxes**: no dedicated packing module exists in scope. "Packing" exists only as `warehouse_status` values `packing`/`packed` in the transition matrix (order-status-core.ts:50–51), the `postPickStatus` warehouse setting (picking.use-cases.ts:893), and `combining.markGroupPacked` (combining.service.ts:954). Cartonization lives in `server/modules/dropship/` (out of scope).

### wms module (`server/modules/wms/`)
- **insert-order.ts** — `insertWmsOrder` factory enforcing non-null `omsFulfillmentOrderId`/`channelId` (48–82).
- **create-shipment.ts** — `createShipmentForOrder` (198) with pg advisory lock (258–269), idempotency probe + coverage check (278–346); `linkChildToParentShipment` (435).
- **line-item-hold.ts** — `holdLineItemWithSplit` (33) / `releaseLineItemFromHold` (98): item `on_hold` + split into `held=true` shipment, in one transaction each.

### warehouse module (`server/modules/warehouse/`)
- **warehouse.routes.ts / locations.routes.ts / settings.routes.ts / pick-zones.routes.ts** — CRUD for warehouses, zones, locations, settings, SLA cutoff; delegate to `warehouse.repository.ts` / storage (warehouse.routes.ts:68–876).
- **infrastructure/warehouse.repository.ts** — all DB access for warehouse config tables (53–477); owns `warehouse.*` config tables only.
- **bin-assignment.service.ts, location-integrity.ts, settings.resolver.ts** — bin assignment writes `product_locations` (333–369); resolver is read-only.

### Reference docs vs code
- BOUNDARIES.md sole-writer matrix: WMS is sole writer of `wms.orders.warehouse_status` (+picker, on_hold), `wms.outbound_shipments` (BOUNDARIES.md:153–165).
- SHIPMENT-STATE-MACHINE-DESIGN.md: hold = orthogonal `held` flag (§2.1), forward-only lifecycle, `warehouse_status` derived-only (invariant 4, §2.2), single writer per fact (§2.3).

---

## 2. STATE & WRITERS

### 2.1 `wms.orders.warehouse_status` — every mutation site found (repo-wide)

Intended chokepoints:
- **W1. `transitionOrderStatus`** — order-status-core.ts:177–186. Guarded `WHERE id AND warehouse_status IN (<legal from-list>)`. Used by: `cancelOrder`/`markOrderShipped`/`completeOrder` (214–272); `orders.storage.transitionStuckOrder` (orders.storage.ts:1600); pick-queue self-heal (orders.storage.ts:706, 735); `fulfillment.service.processShopifyFulfillment` → `markOrderShipped` (fulfillment.service.ts:564–565); OMS reconcilers `oms-flow-reconciliation.service.ts:1025–1027` (inside `withOptionalTransaction`); index.ts schedulers (per search agent: index.ts:915–916, 1047–1048); shipstation.service.ts:2652, 2717 (`markOrderShipped`, pre-guarded on current status).
- **W2. `recomputeOrderStatusFromShipments`** — shipment-rollup.ts:843–847 / 876–879. UPDATE is `WHERE id = ...` only — the cancelled-terminal guard (815), progress-preservation guard (829–835), and no-op comparisons (803, 825) are all **JS-side reads before the write** (order row read at 768–787). Callers: SHIP_NOTIFY v2 (shipstation.service.ts:2270–2275), `pushShipment` (3836), oms-webhooks.ts:327, 751, channel-fulfillment.service.ts:99, shopify.routes.ts:333/436/661/722, index.ts:1351, `updateOrderStatus` shipped-family (orders.storage.ts:997), pick-queue self-heal (orders.storage.ts:763, 773).

Direct writers that bypass both chokepoints:
- **W3. `claimOrder`** — orders.storage.ts:884–909. Sets `in_progress`; properly guarded (`onHold=0`, status IN ready/partially_shipped/ready_to_ship/in_progress, picker-conflict guard 902–906). Good pattern, but a second writer.
- **W4. `releaseOrder`** — orders.storage.ts:939–943. Sets `ready` `WHERE id` only — **no status guard**; also resets `order_items` to pending/`pickedQuantity=0` (950–955) with **no inventory restoration**.
- **W5. `forceReleaseOrder`** — orders.storage.ts:974–978. Sets `ready`, clears `onHold`, unguarded.
- **W6. `updateOrderStatus` (ops branch)** — orders.storage.ts:1017–1026. Direct write of any non-shipped-family status, `WHERE id` only, no matrix/terminal guard. Reached from routes: shopify.routes.ts:1268/1274/1542/1563, channels.routes.ts:488, picking.use-cases.markReadyToShip:1952.
- **W7. `updateOrderProgress`** — orders.storage.ts:1147–1171. Post-pick derived write (`cancelled`/`exception`/postPickStatus), `WHERE id` only, no guard. Called after every pick (picking.use-cases.ts:1369).
- **W8. `resolveException`** — orders.storage.ts:1302–1317. Direct write (completed/cancelled), unguarded. Route: picking.routes.ts:877.
- **W9. `combining.markGroupPacked` / `markGroupShipped`** — combining.service.ts:970–973 / 996–999. `set({ warehouseStatus: "packed"|"shipped" })` for the whole group, `WHERE combinedGroupId`, **no guard whatsoever**. No server-side callers found (only PROCESS-MAP.md:1566–1576, which itself warns about it) — latent dead-but-loaded API.
- **W10. `fulfillment-router.assignWarehouseToOrder`** — fulfillment-router.service.ts:157–164. Sets `awaiting_3pl` unguarded.
- **W11. `syncFulfilledStatusesFromShopify`** — orders.storage.ts:1410–1418. Writes `SET status = 'completed'` on `wms.orders` — a column that **does not exist** in the schema (orders.schema.ts:71–145 has `warehouseStatus`, no `status`). Already flagged in ORDER_TO_SHIP_DEEP_REVIEW_2026-05-30.md:214 (D-SYNCSTATUS); still unfixed. Called from shopify.routes.ts:1012 — this endpoint must fail at runtime.
- **W12. OMS module (cross-boundary)**: `oms-webhooks.ts:1725–1744` — `SET warehouse_status = CASE WHEN warehouse_status='pending' AND <paid> THEN 'ready' ...` (raw, in a webhook handler); `wms-sync.service.ts:806–816` (drizzle `warehouseStatus: "ready"` promotion) and `wms-sync.service.ts:1045–1079` (`SET warehouse_status = CASE ...`, preserves cancelled/shipped in the CASE).
- **W13. `server/routes/diagnostics.ts:267–274`** — raw `SET warehouse_status='ready' WHERE warehouse_status='in_progress' AND assigned_picker_id IS NOT NULL` built with `sql.raw` string concatenation, in a route handler.
- **W14. Creation-time inserts** (initial state, not transitions): shopify.routes.ts:987 and channels.routes.ts:333 pass `warehouseStatus: "ready"|"completed"` into `createOrderWithItems` → `insertWmsOrder` (orders.storage.ts:795–834; insert-order.ts:71–74).

**Verdict:** `transitionOrderStatus` is NOT the single chokepoint. Counting chokepoints W1–W2 plus W3–W13, there are **at least 13 distinct writer sites** across 4 modules (orders, oms, combining, top-level routes). The two chokepoint files even both claim sole-writer status for the same column (order-status-core.ts:2–5 vs shipment-rollup.ts:6–8).

### 2.2 `wms.outbound_shipments.status` — every mutation site found

Intended chokepoints (shipment-rollup.ts):
- **S1. `markShipmentShipped`** — UPDATE at 278–287 (`WHERE id` only; idempotency + guards at 243–249 are JS-side on a row loaded at 239).
- **S2. `markShipmentCancelled`** — UPDATE at 425–432 (`WHERE id` only). Terminal-shipped refusal at 386–394 (JS-side). Engine cancel side effect 404–423.
- **S3. `markShipmentVoided`** — UPDATE at 699–708 (`WHERE id` only). Label-of-record guard 660–669 (JS-side).
- **S4. `cancelStaleShipmentsIfFullyCovered`** — UPDATE at 1006–1015, properly guarded in SQL (`status IN ('planned','queued') AND shipped_at IS NULL`) — but performs **no engine cancel** (contrast S2 at 404–423), so a queued SS order is cancelled WMS-side only.

Bypass writers:
- **S5. `fulfillment.service.confirmShipment` / `confirmShipmentInternal`** — status='shipped' at fulfillment.service.ts:246–249 and 737–740, inside a transaction with `inventoryCore.recordShipment` (221–229, 713–722); JS idempotency check (202, 696) but no cancelled-guard (a cancelled shipment can be confirmed shipped).
- **S6. `fulfillment.service.markDelivered`** — fulfillment.service.ts:653–660: status='delivered' `WHERE id`, **no guard of any kind**.
- **S7. `line-item-hold`** — INSERT with `status='planned', held=true` (line-item-hold.ts:64–70); `held` cleared at 120–124.
- **S8. `create-shipment.ts`** — INSERT `status='planned'` (355–358, 513–525); advisory-locked, idempotent.
- **S9. OMS/index bypasses** (verified via search agent, line refs spot-checked by grep): index.ts:949–954 (`status='shipped'` guarded `status NOT IN ('shipped','returned','lost')`); **index.ts:957–960 (`status='cancelled'` `WHERE id` only — unguarded)**; index.ts:1003–1014 (orphan cancel, SQL-guarded); index.ts:1114–1118 (dup cleanup, env-gated off); index.ts:1274–1279 (guarded shipped); shipstation.service.ts:2633–2641 (legacy SHIP_NOTIFY raw `status='shipped'`, JS-guarded on prior status); shipstation.service.ts:2745–2750 (INSERT with `status='shipped'`); shipstation.service.ts:3822–3834 (`status='queued'` in pushShipment, advisory-locked, followed by recompute at 3836).
- **S10. `db.ts` startup migrations** — db.ts:656–664 rewrites `status` for lingering `on_hold` rows; db.ts:647/668 write `held` (see 2.3).

**Verdict:** the mark-* helpers are the majority path but there are **≥6 bypass sites** (S4–S6, S9, S10) writing `status` raw, two of them with no guard at all (S6; index.ts:957–960).

### 2.3 `wms.outbound_shipments.held` (hold flag)
- Writers: line-item-hold.ts:68 (set true), 120–124 (clear); db.ts:647 (boot backfill set), db.ts:656–664 + **db.ts:668 (boot: `SET held=false ... WHERE held=true` — clears ALL)**.
- Reader/enforcer: `pushShipment` refuses `held=true` (shipstation.service.ts:3473–3482) — the declared "single chokepoint" (line-item-hold.ts:6–7).

### 2.4 Other WMS-ops state
- `wms.orders.on_hold`/`held_at`: holdOrder/releaseHoldOrder (orders.storage.ts:1176–1194), forceReleaseOrder (965–966), channels.routes.ts:495–502. Engine sync via `queueShipStationHoldSync` (picking.routes.ts:25–64, durable retry + fire-and-forget engine call).
- `wms.order_items.on_hold`: holdOrderItem/releaseOrderItem (orders.storage.ts:1199–1215), holdLineItemWithSplit/release (line-item-hold.ts:40–43, 103–106).
- `wms.orders.sla_status`: sla-monitor.service.ts:119–162 (guarded batch UPDATEs; separate column, no conflict).
- `picking_logs`: insert-only storage API (picking-logs.storage.ts:57–60); no UPDATE/DELETE in the module. Two integrity caveats: catalog SKU rename rewrites history (`catalog.storage.ts:470 db.update(pickingLogs).set({ sku: newSku })`), and the admin backfill route fabricates rows with `pickMethod = Math.random() > 0.3 ? "scan" : "manual"` (picking.routes.ts:1074).

---

## 3. BOUNDARY VIOLATIONS

1. **OMS module writes WMS-owned state directly** (BOUNDARIES.md:153–155, 168: "OMS never writes `wms.*`"):
   - oms-webhooks.ts:1725–1744 (`warehouse_status` CASE promotion in webhook handler).
   - wms-sync.service.ts:806–816, 1045–1079 (`warehouseStatus` writes).
   - shipstation.service.ts:2633–2641, 2745–2750, 3822–3834; index.ts:949–960, 1003–1014, 1274–1279 (`outbound_shipments.status` raw writes). These are OMS/scheduler code, not the WMS shipment interface.
2. **Routes write the DB directly** (CLAUDE.md §16): diagnostics.ts:267–274 (raw `warehouse_status` UPDATE with string-built WHERE); channels.routes.ts:461–507 (PUT `/api/wms/orders/:id` forwards arbitrary `status` from the body to `updateOrderStatus`, plus hold toggles) — a channels-module route mutating WMS order state.
3. **Cross-schema joins in WMS storage**: pick-queue query LEFT JOINs `oms.oms_orders` from WMS storage (orders.storage.ts:440–465, "BELT & SUSPENDERS"); `syncFulfilledStatusesFromShopify` joins/derives from `oms.oms_orders`/`oms_order_lines` and force-completes WMS items (orders.storage.ts:1408–1455). BOUNDARIES.md:14 forbids cross-system inner joins; these are deliberate safety nets but they re-derive OMS truth inside WMS.
4. **Startup migration as a state writer**: db.ts:647–668 mutates live operational state (`status`, `held`) on every boot — `runStartupMigrations()` is called unconditionally at index.ts:417. A migration layer is not an owner under the single-writer matrix.
5. **GET path mutates state**: `getPickQueueOrders` performs transition/rollup/cancel writes during a queue read (orders.storage.ts:696–787), violating CLAUDE.md §8 ("no mutating side effects inside read/GET paths"), even though it uses the guarded helpers.
6. **Warehouse module**: clean. Routes delegate to repository/storage; no writes to orders/shipments/inventory found (warehouse.routes.ts, locations.routes.ts, settings.routes.ts, pick-zones.routes.ts, warehouse.repository.ts:53–477). Residual business logic in routes is limited to bulk import/delete loops (warehouse.routes.ts:584–627, 660–752).

---

## 4. CORRECTNESS RISKS (ranked)

### CRITICAL
- **C1. Every server restart silently releases all line-item holds.** db.ts:668 runs on every boot (index.ts:417): `UPDATE wms.outbound_shipments SET held = false, held_at = NULL WHERE held = true`. Its comment ("Post-1c `held` has no writer until an operational hold path lands", db.ts:665–667) is stale: the operational writer landed — `holdLineItemWithSplit` creates `held=true` shipments (line-item-hold.ts:64–70) behind live routes (picking.routes.ts:489–560). After a deploy/restart: the held shipment's `held` flag is wiped, the `pushShipment` refusal (shipstation.service.ts:3473–3482) no longer applies, so the "never ship this line" intent is destroyed while `wms.order_items.on_hold` stays true — state is internally inconsistent and the held line becomes pushable/shippable. This is a non-owner (boot migration) overwriting WMS intent state — the single worst writer-control violation in this subsystem.

### HIGH
- **H1. `warehouse_status` has ≥13 writers, several unguarded** (see §2.1). Concrete regressions possible today:
  - `releaseOrder` (orders.storage.ts:939–955): no status guard → can flip a `shipped`/`cancelled` order back to `ready`; with `resetProgress=true` (the route default, picking.routes.ts:244) it zeroes `order_items.picked_quantity` **without reversing the inventory decrement** made at pick time (picking.use-cases.ts:1008 → inventoryCore.pickItem) — a re-pick then decrements the same stock twice. No compensating restore exists in releaseOrder.
  - `updateOrderProgress` (orders.storage.ts:1147–1171) runs unguarded after the pick transaction commits (picking.use-cases.ts:1369): a cancel landing between the in-tx guard (953–970) and this write resurrects a cancelled order to `ready_to_ship`/`completed` (TOCTOU).
  - PUT `/api/wms/orders/:id` (channels.routes.ts:473–490) → `updateOrderStatus` ops-branch (orders.storage.ts:1017–1026): any authenticated `orders:edit` caller can set any non-shipped status on any order, including regressing terminal states; `cancelled` here cancels nothing downstream (no unreserve, no shipment/engine cancel — compare oms cancel cascade).
  - `combining.markGroupShipped` (combining.service.ts:996–999): unguarded group-wide `shipped` write with no shipments, no inventory ship, no `completed_at`. Currently uncalled (latent), already red-flagged in PROCESS-MAP.md:1576.
- **H2. Shipment terminal-state guards are read-then-write, not atomic.** All mark-* helpers load the row (shipment-rollup.ts:239, 371, 643) then `UPDATE ... WHERE id` (278–287, 425–432, 699–708) with no status predicate and no `FOR UPDATE`. Two concurrent events (e.g. SHIP_NOTIFY webhook + customer-cancel fan-out, or webhook + reconcile sweep) can interleave: cancel loads `queued`, ship commits `shipped`, cancel then overwrites → `shipped → cancelled`, violating design invariant 1 (SHIPMENT-STATE-MACHINE-DESIGN.md §2.2) — the exact regression class (#659/#668) the design targets. Same pattern in `recomputeOrderStatusFromShipments` (order-state guards at 803–835 evaluated on a row read at 768; write at 843/876 unguarded) and `fulfillment.service.confirmShipment` (load 192–196, write 246–249). `markDelivered` (fulfillment.service.ts:653–660) has no guard at all: it can flip a `cancelled`/`voided` shipment to `delivered`.
- **H3. Picks are not blocked on held orders/lines.** The in-transaction pick guard re-checks only `["cancelled", "shipped"]` (picking.use-cases.ts:965) — it SELECTs `on_hold` (954) and never tests it, and never checks `order_items.on_hold`. Hold enforcement exists only at claim time (orders.storage.ts:894 `eq(orders.onHold, 0)`). A hold placed after claim (or a direct PATCH `/api/picking/items/:id`, picking.routes.ts:259–282, which requires no claim) picks and decrements inventory on a held order. CLAUDE.md §9 explicitly requires rejecting picks on held orders.
- **H4. `syncFulfilledStatusesFromShopify` writes a non-existent column** (`wms.orders.status`, orders.storage.ts:1411–1413 vs orders.schema.ts:71–145) — known defect (ORDER_TO_SHIP_DEEP_REVIEW_2026-05-30.md:214) still present; the route (shopify.routes.ts:1012) fails at runtime. Steps 2–4 (1421–1455) also force `picked_quantity = quantity` with no inventory ledger entry, fabricating pick state.

### MEDIUM
- **M1. Picking is not fully atomic across its three legs.** (a) inventory decrement and (c) item status/qty update ARE in one transaction with row locks and in-tx re-checks (picking.use-cases.ts:949–1048: order `FOR UPDATE` 953–958, item `FOR UPDATE` 976–981, `inventoryCore.withTx(tx)` 995–998, D-LEDGER coupling 1024–1041 — good). But (b) the `picking_logs` write happens after commit (1081–1102): a log failure leaves a committed pick with no audit row; conversely nothing replays it. `updateOrderProgress` also runs post-commit (1369). The audit trail is best-effort, not transactional.
- **M2. `cancelStaleShipmentsIfFullyCovered` cancels WMS-side only** (shipment-rollup.ts:1006–1015) — no engine cancel (unlike markShipmentCancelled:404–423). A stale `queued` SS order stays live in the engine until a reconcile sweep converges it; if SS auto-ships it first, you get ship-after-WMS-cancel drift (design §2.3 requires WMS-cancelled → engine.cancel).
- **M3. Rollup vs. other writers can fight.** `recomputeOrderStatusFromShipments` refuses to leave `cancelled` (815) and preserves in-warehouse progress only via the heuristic at 66–83/829–835 — a `packed`/`completed` order with a short pick (`pickedUnits < shippableUnits`) fails `shouldPreserveWarehouseProgressDuringOpenShipmentRollup` (79) and gets regressed to `ready` by any recompute while shipments are open. Meanwhile W7 (`updateOrderProgress`) and W6 (`updateOrderStatus`) write the same column from item-state, and OMS reconcilers write via helpers (oms-flow-reconciliation.service.ts:1025–1027) — three derivation bases (shipments, items, OMS status) with no ordering. The pick-queue GET self-heal (orders.storage.ts:749–786) adds recompute+cancelStale on every queue fetch, so the fight can trigger from a read path under concurrent webhooks.
- **M4. Three overlapping hold models, divergent semantics.** (1) Order hold: `wms.orders.on_hold` int + `heldAt`, engine-synced via hold/releaseHold for all non-terminal shipments (picking.routes.ts:25–64), blocks claim only (H3). (2) Line-item hold: `order_items.on_hold` bool + split shipment `held=true` (line-item-hold.ts), enforced only at pushShipment. (3) Shipment `held` flag (design Phase 1) — retired refund-hold writer, then a boot migration that zeroes it (C1). Plus a 4th signal: priority `-1` is presented as "Hold" in the priority endpoint (picking.routes.ts:618, 639) and a hold bit inside `sort_rank` (sort-rank.ts:19–20). Who clears holds: releaseHoldOrder route, forceReleaseOrder (silently, admin), channels PUT route, releaseLineItemFromHold, and db.ts:668 (silently, every boot). No single owner, no unified audit.
- **M5. `transitionOrderStatus` quality defects**: dead string-built `setClauses`/`fromList` remnant (order-status-core.ts:166–175, only `fromList` used via `sql.raw`); result reports `previousStatus: legalFrom[0]` — a guess, not the actual prior state (204); the docstring promises "Audit trail — every transition is logged with before/after" (12–13) but the function writes no log/event row at all. The matrix is also deliberately permissive (43: "intentionally permissive for Phase 1"), e.g. completed→cancelled allowed with no compensation.
- **M6. Audit-log integrity**: admin backfill inserts synthetic picking_logs with randomized `pickMethod` (picking.routes.ts:1074) — fabricated evidence in an append-only financial-history trail (CLAUDE.md §10); catalog SKU rename mutates historical rows (catalog.storage.ts:470).
- **M7. Line-item hold TOCTOU**: the "pending only, nothing picked" check lives in the route (picking.routes.ts:511–520) outside the transaction; `holdLineItemWithSplit` doesn't re-check inside the tx (line-item-hold.ts:40–43). A concurrent pick completing between check and hold splits a picked line into a held shipment.
- **M8. `updateOrderItemStatus` deliberately drops the WHERE-guard for `completed` transitions** (orders.storage.ts:1103–1108) — safe only because pickItem's tx path locks first; other callers of this storage method get last-write-wins.

### LOW
- **L1.** `handleBinCount` / scan auto-adjust write inventory adjustments driven by picker input with review flags (picking.use-cases.ts:1729–1750, 2141–2155) — governed, but adjustments are outside any tx with the pick.
- **L2.** Money conversion via `Math.round(parseFloat(x) * 100)` (shopify-order-reconciliation.ts:270–274) — FP-touching but rounded at the boundary; consistent with intake elsewhere.
- **L3.** `console.*` logging throughout instead of the structured logger mandated by CLAUDE.md §10 (e.g., shipment-rollup.ts:271–273, 390–392; orders.storage.ts:862–915).
- **L4.** diagnostics.ts:263–265 builds SQL WHERE by string concatenation (`parseInt` bounds it; NaN yields SQL error, not injection).
- **L5.** `claimOrder` permits claiming `partially_shipped`/`ready_to_ship` orders (orders.storage.ts:895–900) — documented intent (875–883), but widens the writer surface for `in_progress`.

---

## 5. SEAM ASSESSMENT

- **Good seams that exist and mostly hold:**
  - `transitionOrderStatus` (order-status-core.ts) is a genuine guarded-CAS chokepoint with a matrix and terminal states; OMS reconcilers and index schedulers already route order-status transitions through it (oms-flow-reconciliation.service.ts:1025–1027; index.ts:915/1047 per verified enumeration).
  - `shipment-rollup.ts` mark-*/recompute is a coherent shipment-lifecycle seam with idempotent replays, tracking history, label-of-record guard, and the terminal-shipped refusal (386–394) that encodes the 2026-06-15 incident lesson.
  - `insertWmsOrder`/`createShipmentForOrder` enforce creation invariants with advisory locks — model citizens.
  - The pick transaction (picking.use-cases.ts:949–1048) is the strongest concurrency work in the subsystem: order lock + status re-check, item lock, tx-bound inventoryCore.
  - Warehouse config module is a clean vertical (routes → repository), fully separable.
- **Where the seams leak:** the storage layer (orders.storage.ts) still exposes raw-write methods (release/updateOrderStatus/updateOrderProgress/resolveException) that predate the chokepoints, and routes/OMS code call them freely. The shipment seam is bypassed by fulfillment.service.ts (a parallel, older shipment writer with its own inventory semantics) and by index.ts repair blocks. The `held` flag has an enforcement point (pushShipment) but no ownership defense (boot wipe).
- **Design-doc conformance:** SHIPMENT-STATE-MACHINE-DESIGN.md Phase 1 (hold-as-flag) is partially landed and then effectively reverted by db.ts:656–668 for everything except line-item holds — which the same block breaks (C1). Phase 2 (single applier), Phase 3 (shipment-id identity — `engine_shipment_ref` still carries orderKey, db.ts:639), Phase 4 (single push gate) are not landed. Invariant 4 ("warehouse_status derived, never written directly") is aspirational: §2.1 counts ≥13 writers.

---

## 6. REFACTOR RECOMMENDATIONS

1. **Immediate (before any restart-sensitive ops):** delete or gate db.ts:668 (and re-scope 656–664 to `WHERE status='on_hold'` rows only, which 656 already is — 668 is the offender). Add a regression test asserting a `held=true, status='planned', source='line_item_hold'` row survives `runStartupMigrations()`.
2. **Make the WHERE clause the guard.** Push each JS-side status check into the UPDATE predicate: mark-* helpers → `UPDATE ... WHERE id=? AND status NOT IN ('shipped','returned','lost','cancelled')` (per event type) with `RETURNING` to detect no-op; recompute → `WHERE id=? AND warehouse_status = <the status read>` (optimistic CAS, retry once); confirmShipment/markDelivered same. This structurally closes H2 without redesign.
3. **Collapse order-status writers into W1/W2.** Migrate `releaseOrder`/`forceReleaseOrder`/`updateOrderStatus`(ops branch)/`updateOrderProgress`/`resolveException`/`assignWarehouseToOrder` to `transitionOrderStatus` with explicit from-lists (the phase1-regression test already polices some patterns — extend it to these file/functions). Delete `markGroupPacked`/`markGroupShipped` (uncalled, PROCESS-MAP-flagged) and `syncFulfilledStatusesFromShopify` (writes a non-existent column; its item-forcing is a ledger hazard).
4. **releaseOrder must be inventory-safe:** either forbid `resetProgress` once any item has a pick ledger row, or emit compensating `inventoryCore` un-pick transactions inside one DB transaction with the item reset.
5. **Unify holds into two flags with one owner each:** order-level `on_hold` (WMS intent, blocks claim AND pick — add `on_hold` and item `on_hold` to the blocked-set at picking.use-cases.ts:965) and shipment `held` (push gate). Retire priority=-1-as-hold. Route every set/clear through one `holds.service` that writes the audit row and enqueues engine sync.
6. **Give `cancelStaleShipmentsIfFullyCovered` the engine-cancel side effect** (or convert it to loop `markShipmentCancelled` per row) so WMS-cancel ⇒ engine-cancel holds everywhere.
7. **Move the pick-queue self-heal out of the GET** into the existing scheduled reconcile (index.ts already hosts sweeps), keeping GET pure per CLAUDE.md §8.
8. **Make the picking audit row transactional:** insert the `item_picked` picking_log inside the pick transaction (it's the financial-history record of the decrement); keep the enrichment-only logs async. Remove the Math.random backfill or stamp rows `metadata.synthetic=true` with `pickMethod='backfill'`.
9. **transitionOrderStatus cleanup:** delete dead `setClauses` (166–175), return the true previous status via `RETURNING` of a CTE or a prior locked read, and actually write the promised transition log (an `oms_order_events`-style append row).
10. Toward the modular monolith: the seam to formalize is `orders/wms` as the **fulfillment state owner** exposing exactly `transitionOrderStatus`, `dispatchShipmentEvent`+`recomputeOrderStatusFromShipments`, `reserveForOrder`, `createShipmentForOrder`, `holds.*` — then delete raw-write storage methods so OMS/channels/routes physically cannot bypass (enforce with a lint/grep CI rule like `__tests__/unit/phase1-regression.test.ts:497`).

---

## 7. UNKNOWNS

- **Production schema drift:** whether `wms.orders.status` exists as a legacy column in the production DB (schema file lacks it; if the column exists remotely, W11 silently writes a dead column instead of erroring). I cannot verify from the repo — needs a `\d wms.orders` against `DATABASE_URL`.
- **Whether any scheduler auto-pushes `planned` shipments** (which determines how fast C1 turns into an actual wrong shipment vs. just destroyed intent). `pushShipment` is invoked from retry-queue and sync paths; I did not trace every enqueue site. HYPOTHESIS: the wms-sync/reconcile sweeps re-push planned shipments, making C1 ship-affecting within one sweep interval.
- **`fulfillment.service.confirmShipment` live callers:** `processShopifyFulfillment` calls the internal variant (fulfillment.service.ts:462); I did not enumerate whether any route still calls `confirmShipment`/`markDelivered` directly — their guard gaps (S5/S6) matter proportionally to caller traffic.
- **eBay/other channel fan-out** into these writers (only Shopify paths were traced end-to-end).
- **Packing/boxes:** no packing-station or box/carton module exists inside the audited scope; if a packing UI exists client-side it must be driving `updateOrderStatus`/`postPickStatus` — not verified (client/ out of scope).
- **Search-agent-derived line refs** for index.ts/oms internals (§2.1 W12–W13 helper-usage claims, §2.2 S9) were spot-verified by grep for existence and SET/WHERE shape, but I did not personally read every surrounding function body in index.ts 900–1500; guard quotes there carry that caveat.
