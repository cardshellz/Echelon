# Inventory Subsystem Audit — Echelon WMS

Date: 2026-07-02. Scope: `server/modules/inventory/**` (~16.4k LOC) + every repo-wide writer of `inventory.*` tables. Method: direct code read of all cited files; repo-wide greps for `allowNegative`, `inventory_levels` / `inventory_transactions` / `inventory_lots` / `reserved_qty` writers. All claims carry file:line. Statements not provable from code are labeled **HYPOTHESIS** or **INSUFFICIENT EVIDENCE**.

---

## 1. SUBSYSTEM MAP

| Component | Path | LOC | Role |
|---|---|---|---|
| Core mutations (the spine) | `server/modules/inventory/application/inventory.use-cases.ts` | 1,232 | receive / pick / unpick / ship / adjust / reserve / release / transfer / convertSku / syncWarehouse / logTransaction / withTx |
| Write primitives | `server/modules/inventory/infrastructure/inventory.repository.ts` | 1,010 | `lockInventoryLevel` (FOR UPDATE :115-138), `upsertInventoryLevel` (FOR UPDATE :145-171), atomic `adjustInventoryLevel` (`SET x = x + δ`, :173-195), `createInventoryTransaction` (:243-246), `executeTransfer`/`undoTransfer` (:292-554) |
| Lot layer (FIFO cost layers) | `server/modules/inventory/lots.service.ts` | 984 | createLot (mills authoritative :99-129), reserve/release/pick/unpick/ship/adjust/transfer FromLots, valuation, createLegacyLots |
| COGS engine | `server/modules/inventory/cogs.service.ts` | 1,196 | lot cost mutation (landed/invoice/CSV/backfill), cascade recost of `oms.order_item_costs`, valuation, reports |
| Cost resolver | `server/modules/inventory/cost-resolver.ts` | 120 | cost waterfall fallback for un-costed receipts/adjustments |
| Replenishment | `server/modules/inventory/application/replenishment.use-cases.ts` | 3,671 | advisory task engine; mutates inventory ONLY inside `executeTask` via `inventoryUseCases.withTx(tx)` (:1186-1312) |
| Cycle count | `server/modules/inventory/application/cycle-count.use-cases.ts` | 1,888 | count → real-time-variance adjustment (:282-393), freeze lifecycle |
| Break/assembly | `server/modules/inventory/application/break-assembly.use-cases.ts` | 649 | UOM conversion via two `adjustInventory` calls (:177-197, :279-299) |
| ATP | `server/modules/inventory/atp.service.ts` | 571 | read-only (no insert/update anywhere in file — verified by grep) |
| Reconciler (Phase 0) | `server/modules/inventory/reconcile/ledger-replay.ts` (+ `scripts/reconcile-inventory-ledger.ts`) | 229 | pure ledger replay → on-hand variance |
| Lot reconciler (L0) | `server/modules/inventory/reconcile/lot-onhand-replay.ts` (+ `scripts/reconcile-lot-onhand.ts`) | 56 | lot-sum vs level diff |
| HTTP routes | `server/modules/inventory/inventory.routes.ts` | 2,835 | 30+ endpoints; CSV import, transfers, receive, level delete |
| Reservation service | `server/modules/channels/reservation.service.ts` | 823 | **lives in the channels module** — ATP-gated `reserveForOrder`, release, orphan reallocation |
| Wiring | `server/services/index.ts` | :82 `inventoryCore = new InventoryUseCases(db, inventoryStorage, inventoryLots, cogs)`; injected `as any` into fulfillment/reservation/returns/picking/shipstation (:91-97, :243) |

State tables (`shared/schema/inventory.schema.ts`): `inventory_levels` (:14-26, buckets variant/reserved/picked/packed/backorder; CHECK reserved ≤ on-hand :25), `inventory_transactions` ledger (:125-163, `voided_at` soft-void :162), `inventory_lots` (:550-594, location **NOT NULL** :554; numeric(10,4) legacy cents :573-576 + **integer mills authoritative** :583-587), `cycle_counts`/`cycle_count_items`, `replen_*`, `order_line_costs` (retired ledger :606-617).

DB invariants (verified in code/migrations): unique (variant, location) index `idx_inventory_levels_variant_location` (`server/db.ts:326`); `chk_variant_qty_non_negative CHECK (variant_qty >= 0) NOT VALID` (`server/db.ts:335-338`, `migrations/0575_inventory_ledger_immutability.sql:25-28`); `check_reserved_lte_on_hand` (`migrations/054_prevent_over_reservation.sql:4`); dedup partial unique indexes for ship/reserve/receipt (migration 0570 exists; 0577/0578 cited in WMS-INVENTORY-REFACTOR.md — **live-DB state not verified from here**).

---

## 2. STATE & WRITERS

### 2a. `inventory.inventory_levels` — every writer found (repo-wide)

**Inside the module (sanctioned):**
- `inventory.repository.ts` — `createInventoryLevel` :140-143, `upsertInventoryLevel` :145-171 (SELECT FOR UPDATE then update/insert), `adjustInventoryLevel` :173-195 (atomic `SET qty = qty + δ`), `updateInventoryLevel` :197-213 (**absolute set, no ledger — no production caller found; dead/latent**), `deleteInventoryLevel` :680-682, `executeTransfer` :340-376 (FOR UPDATE, ledgered :413-447), `undoTransfer` :517-554.
- `inventory.use-cases.ts` — all core verbs, each: lock/upsert-lock → mutate → lot mutation → ledger row, in ONE `db.transaction` (receive :92-186, pick :205-258, unpick :278-324, ship :362-453, adjust :477-540, reserve :560-622, release :639-676, transfer :707-900, convertSku :930-1027 incl. level DELETE :1018).
- `inventory.routes.ts` — CSV import writes levels + ledger via `storage.*` directly from the route in one tx (:439-475); empty-row delete :621-646 (guarded: qty=0, reserved=0, unassigned).
- `break-assembly.use-cases.ts` — private direct-write helpers `adjustWithinTx`/`insertLevel`/`logTx` (:599-640) are **dead code** (no call sites; verified by grep). Live path uses `adjustInventory` (:177, :190, :279, :292).

**Outside the module (see §3):** channels catalog-backfill :867; channels reservation :504/:509; dropship :866-891; catalog storage :237-238; `server/db.ts:549-561` (startup delete of all-zero "zombie" rows — no qty impact); repair scripts (`server/scripts/fix_orphaned_picks.ts:34-70`, `scripts/clear_reserved.ts:20-24`, `scripts/cleanup-over-reserved.ts`, `scripts/fix-orphaned-reservations.{cjs,sql}` [not read]).

### 2b. `inventory.inventory_transactions` — append-only status: **UPHELD (one soft-void path)**

Writers: `inventory.repository.ts:243-246` (choke point used by all use-cases) and :413/:430 (executeTransfer); dead `break-assembly` logTx :639; **external:** `channels/reservation.service.ts:509-516`, `channels/catalog-backfill.service.ts:878-889`, `dropship-order-acceptance.repository.ts:872-891`, scripts (`fix_orphaned_picks.ts:42-70`, `scripts/backfill-ledger-variances.ts` — ledger-only corrective rows, dry-run default).

UPDATE/DELETE sweep (repo-wide grep for `UPDATE|DELETE ... inventory_transactions` and drizzle `.update/.delete(inventoryTransactions)`): the **only** mutation is `server/routes/diagnostics.ts:28-50` — `UPDATE ... SET voided_at = NOW()`, the sanctioned C5 soft-void (reconciler excludes voided rows, `scripts/reconcile-inventory-ledger.ts:81`). **No hard DELETE of ledger rows anywhere.** Caveat: the *COGS* ledger `oms.order_item_costs` is NOT append-only — `cascadeRecostForLot` rewrites unit/total cost in place (`cogs.service.ts:366-374`) and `unpickFromLots` deletes rows (`lots.service.ts:489-513`, correct for reversal but unlogged per-row).

### 2c. Reservations — every `reserved_qty` writer (repo-wide)

1. `inventory.use-cases.ts` — reserveForOrder :582, releaseReservation :649, pickItem release :219-226, recordShipment release :402-407, adjustInventory orphan release :499-507, transfer reserve-move :804-827.
2. `inventory.repository.ts` — executeTransfer reserve-spillover move :331-347/:357-376 (+ `reserve_move` ledger row :429-447).
3. `channels/reservation.service.ts` — delegates to core (:202-209, :387-395) ✅; **but** fallback orphan path calls nonexistent `inventoryCore.adjustLevel` :504 (see R2) and writes a ledger row directly :509-516.
4. `dropship/infrastructure/dropship-order-acceptance.repository.ts:865-891` — **raw SQL reservation writer** (parallel implementation).
5. Lot bucket mirrors: `lots.service.ts` reserveFromLots :240-248 / releaseFromLots :296-305.
6. Repair scripts: `scripts/clear_reserved.ts:20-24` (raw `reservedQty: 0`, **no ledger row**), `scripts/cleanup-over-reserved.ts`, `scripts/fix-orphaned-reservations.*`.

**Verdict:** `reserveForOrder()` is NOT the single reservation path. Dropship is a second, independent writer; scripts are a third class.

### 2d. `allowNegative` — every occurrence (repo-wide grep, non-doc)

| Site | Nature |
|---|---|
| `inventory.use-cases.ts:468` | param declaration on `adjustInventory` |
| `inventory.use-cases.ts:488-492` | the negative guard it bypasses |
| **`inventory.use-cases.ts:1172`** | **`allowNegative: true` — LIVE USE** in `syncWarehouse` (3PL/Shopify virtual-location delta sync). Only caller is `warehouse.routes.ts:823-837` via `services.inventorySource` — which is wired to `null` (`services/index.ts:109`), so the route 200s then TypeErrors in fire-and-forget; the violation is latent but the code path exists on `inventoryCore` |
| `replenishment.use-cases.ts:258` | interface declaration only; no call passes it |
| `cycle-count.use-cases.ts:277, :338, :911` | comments asserting **NEVER allowNegative** — verified: approval computes real-time variance and flags `investigate` instead of going negative (:293-322) — the NEGATIVE-INVENTORY-INVESTIGATION fix is implemented |
| `client/src/pages/PurchaseOrderEdit.tsx:293-343` | unrelated UI input flag (negative amounts on adjustment PO lines) |

L3 ("remove the footgun") from WMS-INVENTORY-REFACTOR §4 is **not done**: the flag and one `true` caller remain.

### 2e. `inventory_lots` writers

`lots.service.ts` (all qty ops via single atomic jsonb-recordset UPDATEs — no FOR UPDATE on lots, but every use-case path first locks the corresponding `inventory_levels` row, which serializes per (variant,location)); `cogs.service.ts` cost mutations (:181-193, :295-306, :432-439, :902-913, :1000-1006, :1034-1037, :1153-1161) — **not serialized by the level lock and mostly not in transactions**; `scripts/remediate-lot-drift.ts` (L0.5 remediation, dry-run default, lot-only).

---

## 3. BOUNDARY VIOLATIONS (external writers of inventory.* — the key question)

Per BOUNDARIES.md:156 the sole writer of `inventory_levels`/`inventory_transactions` is WMS `inventoryCore`. Violations found:

1. **Dropship module — parallel reservation implementation (worst writer-control violation).** `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:865-871` raw `UPDATE inventory.inventory_levels SET reserved_qty = reserved_qty + $1` + :872-891 raw ledger INSERT. It IS row-locked and transactional (`lockInventoryLevelsWithClient` :610-629, called :213), but it bypasses `reserveForOrder()` (BOUNDARIES.md rule 5), the ATP gate, the frozen-bin filter (`reservation.service.ts:139-157`), and the reserve-dedup key — its reserve rows carry **no `order_id`/`order_item_id`** (:873-877), so `uq_inventory_transactions_reserve_dedup (order_id, order_item_id)` cannot protect against replay.
2. **Catalog module destroys inventory rows unledgered.** `server/modules/catalog/catalog.storage.ts:237-238` `db.delete(inventoryLevels)` for a whole variant; callers `catalog.routes.ts:975` (product archive) and :2011 (variant archive). The routes first zero `variantQty` through `inventoryCore.adjustInventory` (:964-972, :2000-2007 — ledgered ✅) but the delete is unconditional, in a separate non-transactional step, and silently destroys any remaining `reserved_qty`/`picked_qty` buckets with no ledger row.
3. **Channels module seeds inventory directly.** `server/modules/channels/catalog-backfill.service.ts:867-875` inserts an `inventory_levels` row and :878-889 a `receipt` ledger row — two separate statements, **not in one transaction** (level without ledger on partial failure), raw insert can 23505 against the unique (variant,location) index if a zero-qty row exists, and no lot is created (lot↔level drift by construction).
4. **Reservation service is a channels-module file writing the WMS ledger.** `server/modules/channels/reservation.service.ts:509-516` direct `insert(inventoryTransactions)` (unreserve row with non-standard `variantQtyDelta: -excess`; harmless to on-hand replay only because replay skips `unreserve`, `ledger-replay.ts:62-67`), plus the broken `adjustLevel` call :504 (§4 R2). Module placement itself contradicts BOUNDARIES.md ("Reservation Service (inside WMS)").
5. **Startup migration deletes level rows.** `server/db.ts:549-561` — deletes only rows with all buckets zero; no on-hand effect; acceptable but still a non-inventoryCore writer.
6. **Repair scripts** write levels/reservations raw: `scripts/clear_reserved.ts:20-24` (no ledger), `scripts/cleanup-over-reserved.ts`, `server/scripts/fix_orphaned_picks.ts:34-70` (ledgered, tx), `scripts/fix-orphaned-reservations.*` (not read).
7. **Reverse-direction leaks (inventory writing others' tables):** `lots.service.ts:810-818` and `cogs.service.ts:1169-1179` write `catalog.product_variants` cost fields; `inventory.use-cases.ts:833-846` and `inventory.repository.ts:394-407` write `wms.order_items` (pick re-pointing — cohesive with the transfer but crosses the orders module's table).

**Compliant external callers (positive):** procurement receiving → `inventoryCore.receiveInventory(..., tx)` (`receiving.service.ts:643-658`; the old C4 raw case-break UPDATE is gone — auto-break on receive removed entirely, :685-695); picking → `inventoryCore.pickItem` (`picking.use-cases.ts:1767`) and `withTx` (:996-997); returns → `receiveInventory`/`adjustInventory`/`logTransaction` (`returns.service.ts:130-204`; C7 `logTransaction` now implemented at `inventory.use-cases.ts:1200-1202`); ShipStation SHIP_NOTIFY → `inventoryCore.recordShipment` with shipmentId dedup key (`shipstation.service.ts:1687-1698`); cycle count → `adjustInventory` via `withTx` (`cycle-count.use-cases.ts:330-339`); replenishment → `inventoryUseCases.withTx(tx)` only (`replenishment.use-cases.ts:1186-1312`).

---

## 4. CORRECTNESS RISKS (ranked)

**R1 — CRITICAL — Break/assembly is NOT atomic (units can vanish).**
`break-assembly.use-cases.ts:160-198` (break) and :263-300 (assemble) open `this.db.transaction(async (tx) => …)` but then call `this.inventoryUseCases.adjustInventory(...)` **without** `withTx(tx)`. `adjustInventory` opens its own transaction on the root db (`inventory.use-cases.ts:477`; `inventoryUseCases` is constructed with the root db, `services/index.ts:82,90`). So the source decrement commits independently; if the target credit then fails (e.g. freeze on target bin — `assertNotFrozen` :479-481 — or crash), the outer rollback undoes nothing: **stock is destroyed with a one-sided ledger trail**. This directly contradicts WMS-INVENTORY-REFACTOR §2 "Corrections" ("Break/assembly IS atomic … lockInventoryLevel (break-assembly.use-cases.ts:156-192)") — the current code has neither the lock nor tx-threading; the stock pre-check :164-172 is an unlocked plain SELECT. Also: the generated `batchId` (:158, :261) is never attached to the ledger rows (`adjustInventory` takes no batchId), so break/assemble pairs are not linked in the audit trail, and the enum's `break`/`assemble` types are never written. Contrast: replenishment's case-break does this correctly via `withTx(tx)` (`replenishment.use-cases.ts:1186, 1232-1293`).

**R2 — CRITICAL — `inventoryCore.adjustLevel()` does not exist (C7-class phantom method, again).**
`channels/reservation.service.ts:504` calls `this.inventoryCore.adjustLevel(level.id, { reservedQty: -excess })` in `reallocateOrphaned`'s fallback branch (entered whenever `orphanedQty` is not supplied). The concrete `inventoryCore` is `new InventoryUseCases(...)` (`services/index.ts:82`, passed `as any` :92) which has **no `adjustLevel` method** (full class read, :29-1231; repo grep finds only consumer-side interface declarations `picking.use-cases.ts:37`, `replenishment.use-cases.ts:249` — never implemented). Runtime = `TypeError: adjustLevel is not a function` **after** the orphan is detected, so orphaned reservations in that path are never released. The one production caller today passes `orphanedQty` (`cycle-count.use-cases.ts:359-364`), so the crash is latent — but this is exactly the mechanism that produced C7, and it survives because the wiring is `as any` with structural interfaces that declare phantom methods.

**R3 — HIGH — The ledger is not replayable for the pick→ship flow (writer/reconciler contradiction).**
Facts: `pickItem` decrements `variant_qty` by qty and writes a `pick` row with `variantQtyDelta: -qty` (`inventory.use-cases.ts:222-226, :241-255`). `recordShipment` decrements `variant_qty` only by `fromOnHand` (zero when the item was picked, :387-407) yet **always** writes `variantQtyDelta: -params.qty` (:431); its own before/after fields disagree with the delta whenever `fromPicked > 0` (`before − after = fromOnHand ≠ qty`, :432-433). The reconciler counts BOTH `pick` and `ship` rows as on-hand deltas (`ledger-replay.ts:62-92`; pinned by its own test summing pick −10 and ship −5 at one location, `__tests__/unit/ledger-replay.test.ts:132-142`; the runner applies no ship filtering, `scripts/reconcile-inventory-ledger.ts:76-102`). Consequence: every unit picked-then-shipped is double-counted in replay → the Phase 0 instrument must show variance ≈ shipped-after-pick volume, or the ledger write is wrong. One of the two is incorrect; the internally inconsistent ship row (delta ≠ before−after) says the writer. **Next check:** run `npm run wms:reconcile-ledger` against prod; expected fix is `variantQtyDelta: -(fromOnHand)` on ship rows (with the picked movement expressed as a bucket delta once C6 lands).

**R4 — HIGH — `allowNegative: true` live occurrence.** `inventory.use-cases.ts:1172` (see §2d). Prohibited by CLAUDE.md §16 and BOUNDARIES.md rule 4. Currently unreachable only because `services.inventorySource` is `null` (`services/index.ts:109`) — which itself means `POST /api/warehouses/:id/sync-inventory` (`warehouse.routes.ts:823-837`) responds "started" then crashes in fire-and-forget. Two bugs for one: a prohibited flag plus a silently broken endpoint.

**R5 — HIGH — Cents/mills split-brain on lot recost (COGS booked at stale cost).**
Mills are the declared authoritative cost (`inventory.schema.ts:577-587`) and the pick-time COGS write reads mills FIRST: `lots.service.ts:387` `lot.unitCostMills || centsToMills(lot.unitCostCents)`. But four of five lot-cost-mutation paths update **only the `*_cents` columns and leave mills stale**: `updateLotLandedCost` (`cogs.service.ts:295-306`), `reconcileInvoiceVariance` (:432-439), `updateManualLot` (:1000-1006), `backfillLotCostsBySku` (:1153-1161). Only `setLotProductCostMills` (:902-913, the CSV path) writes both. After any landed-cost finalization or invoice reconciliation, subsequent picks book COGS from the stale mills value while valuation reads the new figure — cents/mills disagree indefinitely. (The mills-COGS mirrors written by `cascadeRecostForLot` :366-374 are themselves derived from rounded cents — cent-precision only.)

**R6 — HIGH — Dropship parallel reservation writer** (§3.1): bypasses ATP gate, freeze filter, reserve-dedup; second implementation of a "never reimplemented" function (BOUNDARIES.md:99).

**R7 — HIGH — Catalog unledgered destruction of levels** (§3.2): reserved/picked buckets deletable with no audit row; delete not atomic with the ledgered zeroing.

**R8 — MEDIUM — `transferLots` destroys lot identity, FIFO age, and mills precision.**
`lots.service.ts:706-778`: each transfer decrements source lots and mints NEW destination lots via `createLot`, passing only `unitCostCents` (:740, :767-777) — so (a) mills are reconstructed from rounded cents (`createLot` :99 lifts cents×100; true sub-cent mills lost), (b) `poLineId`/cost breakdown dropped (falls out of the landed-cost cascade), (c) **`receivedAt` is stamped `new Date()`** (`createLot` :136) despite the layer's original `receivedAt` being captured (:741) and the docstring claiming "same cost and receivedAt (FIFO identity preserved)" (:702-704) — transferred stock becomes the NEWEST lot, corrupting FIFO consumption order and therefore COGS sequencing. Matches WMS-INVENTORY-REFACTOR §6 except the receivedAt reset, which is worse than documented.

**R9 — MEDIUM — Level↔lot drift is still being manufactured.** Paths that mutate levels + ledger but never touch lots: `convertSku` (`inventory.use-cases.ts:930-1027` — no `lotService` call at all), `executeTransfer`/`undoTransfer` (`inventory.repository.ts:292-554` — also no freeze check), CSV import (`inventory.routes.ts:439-475`), catalog-backfill insert (§3.3), catalog delete (§3.2). These are the structural root causes behind the L0 baseline drift (232 cells / 6,382 units, WMS-INVENTORY-REFACTOR.md §6 L0) that `scripts/remediate-lot-drift.ts` exists to repair. The *cost* backfill scripts (`backfillLotCostsBySku`, lot-cost CSV `applyLotCostUpload`) exist because lots were historically created at $0 — `createLegacyLots` explicitly writes `unitCostCents: 0` (`lots.service.ts:929-934`) and receipts without PO linkage fall back through `resolveCost`. Remediation itself is intentionally lot-only and un-ledgered (documented, `scripts/remediate-lot-drift.ts:10-16`) to keep the Phase 0 ledger reconciler green.

**R10 — MEDIUM — COGS cost mutations are non-transactional and rewrite a financial ledger in place.** `updateLotLandedCost` = 3 separate statements (lot update :295-306, cascade :309, audit log :312-315) with no wrapping transaction — partial failure leaves cost changed without cascade or audit. Same shape in `reconcileInvoiceVariance` (:421-459) and `backfillLotCostsBySku` (:1149-1181). `cascadeRecostForLot` mutates `oms.order_item_costs` rows in place (:366-374) — retroactively recosting *shipped* orders, which contradicts COGS-ENGINE-SPEC §5.3 ("COGS is locked at time of sale"); this is a deliberate design change per the comment :334-339, but the per-row before→after is not preserved anywhere (only lot-level totals in `cost_adjustment_log`).

**R11 — MEDIUM — Float money on inventory/COGS paths.** `parseLotCostCsvRow`: `Number(rawCost)` → `Math.round(dollars * 10000)` (`cogs.service.ts:39-43`) — float parse/multiply where the integer-exact `dollarsToMills` (`shared/utils/money.ts:79-118`) exists for precisely this. `getOrderCOGS` revenue: `Number(order.totalAmount || 0) * 100` (:561) — float dollars→cents (reporting only). Break cost propagation: `Math.round(sourceTotalCost / targetQty)` in whole cents (`break-assembly.use-cases.ts:187, :289`) — re-introduces the cent-rounding the mills migration removed (`perUnitMills` unused here). Replen case-break: `consumedCostCents / baseConsumed` float intermediate (`replenishment.use-cases.ts:1244-1249`). Also `getOrderCOGS` line filter `order_item_id === item.id || product_variant_id === item.productVariantId` (:535-537) double-counts COGS rows when an order has two lines of the same variant (reporting only).

**R12 — MEDIUM — Idempotency map.** Solid: receipt (pre-check `inventory.use-cases.ts:97-111` + 23505 catch :175-178), reserve (:562-575, :609-615), ship (:363-375, :447-452), pick (COGS-row existence check, `lots.service.ts:327-349`), CSV import (set-to-target ⇒ naturally replay-safe :434). Gaps: **manual `adjustInventory` and `transfer` have no idempotency key** (operator double-submit double-applies); **dropship reserve** outside the dedup key (§3.1); `undoTransfer`'s already-undone check is a read-then-write on a notes string (`inventory.repository.ts:533-544`) — racy double-undo possible.

**R13 — LOW — hygiene.** `transactionTypeEnum` lacks `unpick`/`cycle_count` while code writes `unpick` (`inventory.schema.ts:37-52` vs `inventory.use-cases.ts:309`) — varchar column so no failure, but enum lies (L1). `updateInventoryLevel` (absolute-set, unledgered) and break-assembly's direct-write helpers are dead code that should be deleted before someone calls them. `generateLotNumber` (`lots.service.ts:43-64`, `cogs.service.ts:1069-1089`) is read-max-increment — duplicate lot numbers under concurrency (no unique constraint on `lot_number` found). `generateBatchId` uses `Date.now()+Math.random()` (`break-assembly.use-cases.ts:526-528`) — determinism rule §3. Routes performing storage writes directly (CSV :441, delete :640) violate the no-DB-writes-from-routes rule even though discipline (tx+ledger) is otherwise observed.

**Concurrency verdict (question asked):** core paths are lock-then-check-then-atomic-increment — `lockInventoryLevel`/`upsertInventoryLevel` take `FOR UPDATE` (`inventory.repository.ts:115-122, :151-156`) inside the same tx as the guard and the `SET x = x + δ` update (:173-195); lot updates are serialized by the level lock. Not the `UPDATE … WHERE qty >= x` conditional style, but equivalent under the lock, with DB CHECKs as backstop. Exceptions: break/assembly's unlocked pre-check + cross-tx pair (R1), COGS lot-cost updates (no lock, no tx — R10), upsert insert-race resolves via unique-index 23505 (fail-loud, no corruption).

---

## 5. SEAM ASSESSMENT

A real published interface exists and most modules honor it: `inventoryCore` (`InventoryUseCases`) is called by procurement receiving (`receiving.service.ts:643`), picking (`picking.use-cases.ts:1767`), returns (`returns.service.ts:130-204`), ShipStation webhook (`shipstation.service.ts:1687`), fulfillment (`fulfillment.service.ts:221, :713`), cycle count and replenishment (via `withTx`), and even catalog archive for the ledgered zeroing. `atpService` is a clean read-only seam. `reserveForOrder` is a genuine choke point for OMS/Shopify order flow (`oms.service.ts` → `reservation.reserveOrder`, wired `services/index.ts:234`).

Weaknesses of the seam:
1. **No compile-time contract.** The service is injected `as any` (`services/index.ts:91-97, :243`) and each consumer declares its own structural interface — which is how two phantom methods (`logTransaction`, historical C7; `adjustLevel`, live R2) got declared and called without existing.
2. **The reservation service lives in `channels/`** while BOUNDARIES.md places it inside WMS; it also writes the ledger directly (:509).
3. **Bypasses:** dropship (raw SQL), catalog (delete), channels backfill (insert), scripts. The seam is real but porous — roughly 6 external writer sites remain.
4. `withTx()` (`inventory.use-cases.ts:1208-1230`) is the right atomic-composition mechanism and is used correctly by replen/cycle-count/receiving — break/assembly inside the module itself doesn't use it (R1), which shows the seam's discipline is convention, not structure.

---

## 6. REFACTOR RECOMMENDATIONS

1. **Immediate (correctness):** thread `withTx(tx)` through break/assembly's two `adjustInventory` calls and lock the source level (R1); implement `adjustLevel` on `InventoryUseCases` (delegating to `storage.adjustInventoryLevel` + ledger row) or change `reservation.service.ts:504` to `adjustInventory` (R2); decide the ship-row delta convention — write `variantQtyDelta = -(fromOnHand)` in `recordShipment` — and re-run `wms:reconcile-ledger` (R3); make every lot-cost mutation write mills + cents together inside one transaction (R5, R10).
2. **Delete the `allowNegative` parameter entirely** (R4/L3). Replace `syncWarehouse`'s negative-delta case with a guarded set-to-zero + `requires_review` flag; fix or remove the null `inventorySource` wiring.
3. **One typed `InventoryCore` interface** exported from `server/modules/inventory/index.ts`; ban `as any` in `services/index.ts`; consumers import the type. This single change makes R2-class bugs compile errors.
4. **Close the reservation seam:** route dropship acceptance through `reserveForOrder(params, txOverride)` (the tx-override plumbing already exists, `inventory.use-cases.ts:557, :620-622`); stamp `order_id`/`order_item_id` (or an intake-scoped dedup index) on its reserve rows; move `reservation.service.ts` into the inventory module and delete its direct ledger insert.
5. **Give catalog an owner-side verb:** `inventoryCore.archiveVariantInventory(variantId)` — one transaction: zero all buckets ledgered, then delete rows; remove `deleteInventoryLevelsByVariantId` from catalog.storage. Same for channels backfill → `inventoryCore.receiveInventory` (or a dedicated `importOpeningBalance` that also creates a lot).
6. **Fold `executeTransfer`/`undoTransfer` into the use-case `transfer`** (single transfer implementation: freeze check + lots + ledger); express undo as a compensating forward transfer with an idempotency key, not a notes-string match.
7. **Lot arc (L1-L4) proceeds as designed** — `lot_location_quantities` + `origin_lot_id` structurally fixes R8; until then, pass `receivedAt` + full mills breakdown + `poLineId` through `transferLots`, and lift break/assembly cost propagation to `perUnitMills`.
8. **Ledger completeness:** add bucket-delta columns (C6) before trusting reserved/picked reconciliation; then CSV/convertSku/undoTransfer must also write lot adjustments or the L-arc reconciler stays red at those cells.
9. Single-writer enforcement backstop: a CI grep (or db role separation) rejecting `inventory_levels`/`inventory_transactions` references outside `server/modules/inventory/**` + an allowlist.

---

## 7. UNKNOWNS

- **Current prod reconciler state.** R3 predicts non-zero variance for picked→shipped cells; WMS-INVENTORY-REFACTOR claims zero on 2026-06-01. Cannot run `npm run wms:reconcile-ledger` here (read-only audit; prod DB via `EXTERNAL_DATABASE_URL`). Either the writer changed after the backfill or the 06-01 traffic was ship-before-pick — INSUFFICIENT EVIDENCE which; the run resolves it.
- **Live-DB constraint state** (validation status of `chk_variant_qty_non_negative NOT VALID`, presence of 0577/0578 dedup indexes, whether `lot_number` has any unique index) — verified in code/migrations only, not against the running database.
- Whether any runtime path invokes `reallocateOrphaned` WITHOUT `orphanedQty` (only the cycle-count caller was found, and it passes it) — determines whether R2 is latent or firing.
- Contents of `scripts/fix-orphaned-reservations.{cjs,sql}` and `scripts/reserve-existing-orders.cjs` (not read; assumed raw reservation writers by name).
- Whether dropship intake has upstream idempotency (intake-table unique key) compensating for the missing reserve-dedup — dropship module not fully audited here.
- Git history is squashed to a single import commit (`ffbd5167`), so whether break/assembly *regressed* after the refactor doc's "atomic" verification or the doc was wrong cannot be established from history.
- `oms.order_item_costs` writers outside this module were not exhaustively swept (pick path + cascade confirmed; a full-repo sweep of that OMS-schema table belongs to the OMS audit).
