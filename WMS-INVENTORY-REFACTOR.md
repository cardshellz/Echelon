# WMS Inventory — Trust → Enterprise Roadmap

> Companion to `BOUNDARIES.md` / `SYSTEM.md` / `WMS_ARCHITECTURE.md`. Authoritative
> tracking doc for taking the WMS inventory subsystem from "functional but untrusted" to
> **enterprise-grade**. Same contract as `CLAUDE.md`.
>
> Two arcs: **Phases 0–6 restore trust** (provable correctness), **Phases 7–9+ build the
> enterprise capability layer** (visibility, exceptions, operational intelligence). The
> strategic framing is in "Strategic assessment" below; the bug-level evidence is in §2.
>
> Status legend: ☐ not started · ◐ in progress · ☑ done
> Evidence legend: **[VERIFIED]** = confirmed by reading the cited code directly ·
> **[REPORTED]** = surfaced by survey, not yet independently confirmed · *(inferred)* =
> strategic judgment, not a specific code cite.

---

## Strategic assessment — where this WMS stands vs. enterprise-grade

This section is the **planning frame**: not a bug list (that's §2) but an honest
current-state → enterprise-target read per domain. Grounded in the six-agent code audit;
items not confirmed in code are marked *(inferred)*.

### Headline

A **functional single-warehouse WMS engine with a strong transactional core** (atomic
writes, an audit ledger, real `FOR UPDATE` concurrency) wrapped in a **thin operational
shell**. The verbs exist (receive / pick / move / count); what's missing is the layer of
**trust, visibility, and operational control** that separates "tracks inventory" from
"runs the operation." The untrust the team feels is real, and it's concentrated in
*integrity guarantees and operations* — not in basic functionality.

### Maturity (1 = spreadsheet, 5 = Manhattan/Blue Yonder)

| Dimension | Level | Note |
|---|---|---|
| Core transactional engine | ~3.5 | Solid bones — keep it |
| Data-integrity guarantees | ~2 | Works by convention, not DB enforcement |
| Operational tooling (visibility, exceptions, labor, waves) | ~1.5 | Mostly absent |
| **Overall** | **early-stage WMS, strong core / thin shell** | Closer to enterprise than a rebuild, but a real gap |

### Capability scorecard

| Capability | State | Gap to enterprise |
|---|---|---|
| Data integrity / trust | ⚠️ Weak | DB doesn't enforce its own rules (negatives, dup rows, over-reserve all possible); no way to *prove* inventory correct. Foundation for everything else. |
| Receiving & putaway | ✅ Basic | No directed putaway, no license-plate/pallet (LPN) tracking, no ASN / inbound appointments |
| Slotting & storage | ⚠️ Thin | No velocity-based slotting; reservation falls back to "biggest pile" when unslotted (H1) |
| Picking | ✅ Core | No wave/batch planning; pick-path opt not wired; `shortPickAction` is dead config (H3); no zone pick-and-pass |
| Replenishment | 🔴 Fragile | 3,603-line untested monolith that can lose units (H5); over-built logic, under-built trust |
| Cycle counting | ✅ Decent | Count→adjust solid, but "frozen" locations not actually protected (H2) |
| Returns | ⚠️ Partial | Logic exists but hits the `logTransaction` crash (C7); no disposition workflow (restock/refurb/scrap) |
| Lot / serial / expiry | ⚠️ Half-built | FIFO lots + cost layers exist (good); no serial tracking; expiry stored but not enforced |
| Labor & productivity | ❌ Absent | No productivity tracking, task interleaving, or labor standards |
| Order orchestration / waves | ❌ Absent | No wave mgmt / batching strategy / priority orchestration beyond a sort rank |
| Multi-warehouse / network | ⚠️ Schema-ready | Tables support it; routing/allocation logic to *run* a network is thin *(inferred)* |
| Observability / alerting | 🔴 Major gap | Fire-and-forget failures (channel sync, replen) fail silently; no stuck-order / drift dashboards |
| Reporting / analytics | ❌ Mostly absent | No valuation, aging, shrinkage, or throughput reporting *(inferred)* |
| Idempotency / resilience | ⚠️ Inconsistent | Some paths replay-safe, many not; dup webhooks can double-reserve or crash (M1/M2) |

### The four missing pillars (the strategic answer)

Beneath the individual bugs, four foundational capabilities are absent. These — not the
bug list — are what "enterprise-grade" requires:

1. **Provable accuracy.** Always be able to answer "is inventory correct, and prove it."
   Today the ledger has holes (C4) and the DB permits impossible states (C1/C2). Until this
   exists, every other feature sits on sand. → addressed by **Phases 0–2**.
2. **Operational visibility.** Failures are currently silent. Enterprise WMS surfaces every
   stuck order / sync failure / drift to a human via alert + work queue. → new **Phase 7**.
3. **Exception management.** Warehouses run on exceptions (short picks, damaged receipts,
   stuck replens). Each needs an explicit workflow + queue, not a swallowed warning.
   → new **Phase 8**.
4. **Operational intelligence.** Waves, slotting, labor, directed putaway, network routing —
   the logic that makes a warehouse *efficient*, not just *functional*. → new **Phase 9+**.

### Sequencing principle

**Earn the right to build features.** Trust first (Phases 0–2), then visibility + exceptions
(Phases 7–8), then operational intelligence (9+). Fancy capability built before the numbers
are trustworthy just produces confident wrong answers faster.

---

## 0. Definition of "trustworthy" (the exit bar)

The inventory subsystem is trustworthy when:

1. **Ledger replay reconciles to `inventory_levels` to zero variance** across all
   (variant, location) for the on-hand bucket — i.e. `SUM(inventory_transactions.variant_qty_delta)`
   per (variant, location) equals `inventory_levels.variant_qty`.
2. **Every write to `inventory_levels` goes through one guarded primitive** that
   enforces the invariants below and writes a ledger row in the same transaction.
3. **The financial invariants are enforced by the database**, not just app code.
4. **No floating-point money** anywhere in inventory/procurement cost columns.

The Phase 0 reconciler is the instrument that measures #1 and is the regression
oracle for every later phase.

---

## 1. Architecture map (as-is)

| Module | Path | LOC | Role |
|---|---|---|---|
| Inventory use-cases | `server/modules/inventory/application/inventory.use-cases.ts` | ~1,100 | Core mutations (receive/pick/unpick/ship/adjust/reserve/transfer/convertSku) — **the spine** |
| Inventory repository | `server/modules/inventory/application/inventory.repository.ts` | ~1,010 | Drizzle write primitives + `lockInventoryLevel` (FOR UPDATE) |
| Replenishment | `.../replenishment.use-cases.ts` | **3,603** | Advisory task engine; mutates inventory ONLY in `executeTask` |
| Cycle count | `.../cycle-count.use-cases.ts` | ~1,814 | Variance → adjustment, freeze lifecycle |
| Break/assembly | `.../break-assembly.use-cases.ts` | ~639 | UOM conversion (case↔units) |
| Reservation | `server/modules/channels/reservation.service.ts` | ~820 | `reserveForOrder` entry, orphan reallocation |
| Allocation engine | `server/modules/channels/allocation-engine.service.ts` | ~400 | **Advisory only** — per-channel ATP math, no mutations |
| ATP | `server/modules/inventory/atp.service.ts` | ~570 | `onHand - reserved - picked - packed` |
| Ledger | table `inventory.inventory_transactions` | — | Append-only audit trail (16 transaction types) |
| Inventory routes | `server/modules/inventory/inventory.routes.ts` | ~2,813 | 30+ HTTP endpoints |

**Core state table** `inventory.inventory_levels`: `variantQty, reservedQty, pickedQty,
packedQty, backorderQty` — one row *should* be per (variant, location).

---

## 2. Findings by severity

### CRITICAL (financial correctness / audit integrity)

**C1 — No DB uniqueness on `inventory_levels(variant, location)`** **[VERIFIED]**
No unique constraint exists; the DB permits duplicate rows for the same bin+variant,
which silently double-counts on-hand. `shared/schema/inventory.schema.ts:14-26` has no
`uniqueIndex`. This is foundational — replay and ATP both assume one row per pair.

**C2 — Negative inventory is possible at the DB level** **[VERIFIED]**
No `CHECK (… >= 0)` on any qty column in `inventory_levels` or on `variant_qty_delta`.
Migration `046_fix_negative_inventory.sql` exists because this already happened in prod
(cycle count #34). Only `check_reserved_lte_on_hand` (`inventory.schema.ts:25`) is enforced.

**C3 — Floating-point money in cost columns** **[VERIFIED → RESOLVED]**
- `0071_create_namespaces.sql` created cost columns as `double precision`:
  `product_variants` (78-80), `purchase_order_lines` (493, 642, 779, 945),
  `po_receipts` (444-446), landed costs (347, 421), and
  `inventory_transactions.unit_cost_cents` (1308).
- `0074_integer_money_cents.sql` converted **all** of the above to `integer` (not just
  `product_variants` as an earlier draft of this doc claimed — re-verified against the
  actual migration file, which has 33 ALTER statements across catalog, inventory, and
  procurement schemas). The `USING round(col::numeric)` clauses are correct — each column
  converts from its own value, no cross-column copy, no data corruption.
- Schema-vs-DB type mismatch: Drizzle declares `bigint`, 0074 converted to `integer`.
  Migration `0576_align_money_columns_bigint.sql` upgrades all money columns to `bigint`
  to match the schema. This is a safe metadata-only operation on Postgres (no table
  rewrite for integer → bigint).
  (`inventory_transactions.unit_cost_cents` confirmed `double precision`; the PO/receipts
  set should get a per-column confirmation pass in Phase 2.)

**C4 — A write path bypasses the ledger entirely** **[VERIFIED]**
`server/modules/procurement/receiving.service.ts:650-655` does a raw
`UPDATE inventory.inventory_levels SET variant_qty = variant_qty - X` for case-break on
receive. It holds a `FOR UPDATE` lock (good) but writes **no `inventory_transactions`
row**. Consequence: **ledger replay will NOT reconcile** for any SKU received via
case-break. This single path falsifies "the ledger is complete."

**C5 — The ledger is deletable** **[VERIFIED]**
`server/routes/diagnostics.ts:28` runs `DELETE FROM inventory.inventory_transactions`.
An append-only financial ledger with a delete path is not append-only.

**C6 — Buckets are not replayable** **[VERIFIED via ledger schema]**
`variant_qty_delta` lets you reconstruct on-hand, but `reserved/picked/packed/backorder`
transitions are not recorded as signed deltas, so those buckets cannot be reconstructed
from the ledger alone. Phase 0 can reconcile on-hand today; bucket reconciliation needs
schema work (Phase 1).

**C7 — `logTransaction` is called but never implemented** **[VERIFIED]**
`inventoryCore` is a `new InventoryUseCases(...)` (`server/services/index.ts:82`), which
exposes **no `logTransaction` method** — it only calls `this.storage.createInventoryTransaction`
internally. Yet `returns.service.ts:136` & `:187`, `picking.use-cases.ts:2180`, and
`inventory.routes.ts:257` & `:277` (via `inventoryCore.withTx(tx)`, which returns another
`InventoryUseCases`) all call `inventoryCore.logTransaction({...})`. These resolve to
`undefined` → **runtime `TypeError: logTransaction is not a function`** on those paths
(customer-return restock ledger write, a bin-count path, CSV-upload ledger writes). It's
masked because `inventoryCore` is typed `any` / via an interface that *declares*
`logTransaction` (`picking.use-cases.ts:45`, `replenishment.use-cases.ts:276`) but no
concrete class implements it. Fix = add a `logTransaction` alias to `InventoryUseCases`
that delegates to `createInventoryTransaction`, or change call sites. Needs a quick check of
whether these paths are exercised in prod (returns restock almost certainly is).

### HIGH

**H1 — Reservation fallback to "largest bin"** **[VERIFIED]**
`reservation.service.ts:157-173`: when there's no `product_locations` assignment, it
reserves at the largest-qty `inventory_levels` row, logs a WARN, and proceeds. Misroutes
pickers, ignores freeze status, full-scans (no index on `variantQty DESC`).

**H2 — Location freeze (`cycleCountFreezeId`) is barely enforced** **[REPORTED, spot-checks VERIFIED]**
Checked only by **pick** and **replenish**. **Transfer, receive, break/assembly, and
manual adjust mutate frozen bins with no check** (`inventory.use-cases.ts` transfer/receive/adjust;
`break-assembly.use-cases.ts`). A bin frozen for counting can change mid-count.

**H3 — `shortPickAction` is dead config** **[REPORTED]**
Defined in `warehouseSettings`, never read by picking. `pause_and_replen` / `block_order`
etc. have no effect; shorts are always allowed.

**H4 — No receipt idempotency key** **[VERIFIED]**
Only `ship` has a dedup unique index (`uq_inventory_transactions_ship_dedup`, `0570`).
Replayed PO receipts / reservations can double-write.

**H5 — Replenishment `executeTask` silently loses units on case-break** **[VERIFIED]**
`replenishment.use-cases.ts` (~1194-1228): source is decremented by the full
`qtySourceUnits` (all base units), but target is credited only
`floor(baseUnits / pickVariant.unitsPerVariant)`. The remainder is written into the audit
note as `"(N base units lost in conversion)"` and **never credited anywhere** — a real
conservation-of-units violation (base units vanish). Occurs whenever pick UOM doesn't
evenly divide the source case. Fix in Phase 6 (credit remainder back to source, or block
non-divisible case-breaks at task creation).

### MEDIUM

- **M1** Reservation/release are **not idempotent**; replayed cancel webhooks throw
  (`reservation.service.ts:317`, `inventory.use-cases.ts:510`). **[VERIFIED]**
- **M2** Double-reservation race: idempotency is an `omsOrderEvents` read-check with no
  unique constraint (`oms.service.ts:348-361`). DB `check_reserved_lte_on_hand` catches
  overflow but logs corrupt. **[VERIFIED]**
- **M3** Orphan reallocation is fire-and-forget; if ATP is now zero, orders stay stuck,
  no alert (`reservation.service.ts:447+`). **[REPORTED]**
- **M4** Raw, lock-less write: `dropship-order-acceptance.repository.ts:866-870`
  `client.query` reserve. **[VERIFIED]**
- **M5** Bulk variant reassignment writes no per-row ledger, no tx
  (`catalog.storage.ts:478-484`). **[VERIFIED]**
- **M6** CSV import isn't wrapped in a transaction; partial failure = inconsistent state
  (`inventory.routes.ts:500-591`). **[REPORTED]**
- **M7** `inventory_transactions` location FKs are `ON DELETE SET NULL` — deleting a
  location nulls audit-trail traceability. **[VERIFIED]**
- **M8** ATP ignores `backorderQty` (`atp.service.ts:128-131`). Conservative, but a known
  drift source. **[VERIFIED]**

### LOW / cleanup

- **L1** Transaction-type enum drift: `unpick` and `cycle_count` are written by code but
  missing from the schema enum; `replenish` is in the enum but never written. **[VERIFIED]**
- **L2** `packedQty` has **no live writers** (dead scaffolding); `backorderQty` has a
  repository plumbing path (`adjustInventoryLevel`) but **no caller passes it** — so the
  pick→pack→ship machine is effectively pick→ship and backorder is inert. **[VERIFIED]**
- **L3** `allowNegative: true` has zero callers today but the flag is a latent footgun
  (`inventory.use-cases.ts`). **[VERIFIED]**
- **L4** Duplicate junk imports `_mk … _mk8` of `makeInventoryUseCases` in
  `inventory.routes.ts:33-41`. **[VERIFIED]**
- **L5** Replenishment magic numbers (cleanup 1/50/250, 14-day velocity, 4-hour staleness,
  50-unit inline threshold) — should be named/config. **[REPORTED]**

### Corrections to the survey (evidence discipline)

- **Break/assembly IS atomic.** Both source-decrement and target-increment run in a single
  `db.transaction` with a `lockInventoryLevel` (`break-assembly.use-cases.ts:156-192`). The
  "two separate txs / units lost if second fails" claim is **false** for break/assembly —
  it is atomic, and conservation math is validated before execution. (Note: the *separate*
  replenishment case-break path DOES lose units — see C7-adjacent H5, a different code path.)
- **Allocation engine is advisory-only** — no inventory mutations, confirmed. **[VERIFIED]**
- **`0074` money migration is NOT corrupt.** An earlier suspicion of a `USING
  round(standard_cost_cents)` copy-paste bug was **disproven** — each column converts from
  itself. See C3.
- **`logTransaction` initially looked like a harmless shim — it is not.** On direct
  inspection it is unimplemented; promoted to **C7 (CRITICAL)** above.

---

## 3. Phase partition

Partitioned by **layer of authority over `inventory_levels`**, not by feature — because
every feature writes the same five columns, feature-slices would collide. Order:
measurement first, then authoritative truth, then derived/advisory last.

### Phase 0 — Ground-truth reconciler (read-only) ☑
Replays `inventory_transactions` and diffs against `inventory_levels` (on-hand bucket).
Output: per-(variant,location) variance report. Zero mutations.
- **Built:**
  - `server/modules/inventory/reconcile/ledger-replay.ts` — pure, deterministic replay.
    On-hand conventions derived by reading every `createInventoryTransaction` write site
    (not docs): `transfer` is the only dual-location on-hand move (from −=δ, to +=δ);
    single-location types are sign-encoded on COALESCE(from,to); `reserve`/`unreserve`/
    `reserve_move`/`return` are skipped (no on-hand effect / double-count traps).
  - `server/modules/inventory/__tests__/unit/ledger-replay.test.ts` — 21 unit tests pinning
    each convention + variance/trust-gap detection.
  - `scripts/reconcile-inventory-ledger.ts` — read-only runner (`npm run wms:reconcile-ledger`),
    flags `--json --limit= --variant=`, exit 1 on any variance (CI-gateable), exit 2 on no DB.
- **Scope note:** on-hand only. Reserved/picked/packed are not signed-delta-ledgered (C6),
  so bucket reconciliation is deferred to Phase 1.
- **Exit:** ✅ reconciler runs on demand + CI-gateable; produces a variance count + total
  abs drift. **Next action: run against prod to capture the baseline** (expect non-zero —
  C4 guarantees drift) and record the starting number here.

### Phase 1 — One guarded write primitive + DB invariants ☑ COMPLETE
- Funnel all 32 write paths through a single guarded mutation (tx + lock + ledger-in-tx).
  Close the bypasses:
  - **C4 (receiving case-break)** ☑ — raw `UPDATE inventory_levels` (no ledger) replaced
    with `inventoryCore.withTx(tx).adjustInventory()`; deduction now ledgered atomically.
  - **M4 (dropship)** ☑ — **finding withdrawn.** The "raw, lock-less write" claim was
    wrong: `acceptOrderWithClient` does `BEGIN` → `lockInventoryLevelsWithClient`
    (`SELECT … FOR UPDATE`) → reserve against the locked rows → `COMMIT`. The write is
    row-locked, transactional, and ledgered, and only touches `reserved_qty` (delta-0
    `reserve` row the on-hand reconciler skips). No on-hand leak.
  - **M5 (variant reassign / merge)** ☑ — merge endpoint no longer re-points
    `product_variant_id` with no ledger and no tx (which also risked a unique-constraint
    crash when the target already had stock at the same bin). It now routes through
    `convertSku` (per-location signed `sku_correction` rows, upsert-safe, tx-wrapped).
    Dead `reassignInventoryLevelsToVariant` / `createMergeAuditTransaction` removed.
  - **M6 (CSV)** ☑ — each row's level mutation + ledger row are now wrapped in one
    `db.transaction`, so a partial failure can't leave a level change without an audit row.
- DB constraints:
  - **C1 (unique variant,location)** ☑ already enforced by existing
    `idx_inventory_levels_variant_location` unique index.
  - **C2 (qty >= 0)** ☑ added as `CHECK … NOT VALID` (blocks new negatives; preserves
    existing drift for the reconciler to correct via ledgered adjustments).
- **C5 (ledger delete)** ☑ — `voided_at` soft-delete column; diagnostics endpoint voids
  instead of `DELETE`; reconciler excludes voided rows.
- **C6 (bucket deltas)** — **DECISION: defer to a dedicated change.** The ledger records
  signed `variant_qty_delta` (on-hand) but not signed deltas for reserved/picked/packed/
  backorder. Making those replayable requires adding bucket-delta columns AND updating every
  reserve/unreserve/reserve_move/pick/pack writer in the same change — a piecemeal rollout
  would produce a *partial* bucket-ledger that looks authoritative but isn't, which is worse
  than none. The Phase 0 on-hand reconciler (the trust instrument) is unaffected. Tracked as
  its own unit of work after on-hand variance is driven to zero.
- **C7 (`logTransaction` unimplemented)** ☑ — implemented on `InventoryUseCases`
  (delegates to `createInventoryTransaction`); unit-tested.
- **Historical backfill** ☑ — one-time corrective pass wrote 429 `adjustment` ledger rows
  (batch `phase1-backfill-2026-06-01`, reference_type `reconciliation`) to retire the
  32,911-unit historical drift. Reconciler confirmed zero variance post-backfill.
- **Exit criteria MET (2026-06-01):**
  - Phase 0 reconciler: **0 cells with variance, 0 total drift.**
  - Every on-hand write path routes through a ledgered/guarded primitive.
  - DB constraints (unique variant+location, non-negative qty, ledger immutability) live in prod.

### Phase 2 — Money integrity ☑ COMPLETE
- **C3 — verified against the LIVE DATABASE** (not just migration files):
  - **4 `double precision` columns still in prod** (actual floating-point money):
    `oms.order_item_costs.{unit_cost_cents, total_cost_cents}`,
    `oms.order_item_financials.{avg_selling_price_cents, avg_unit_cost_cents}`.
    These were missed by migration 0074. Fixed → `bigint` with `round()`.
  - **6 `numeric` columns** on `inventory.inventory_lots` and `inventory.order_line_costs`
    and `inventory.cost_adjustment_log` — exact decimal (not floating point), but
    code treats them as integer cents via `Number()`. Fixed → `bigint`.
  - **~20 `integer` columns** that 0074 converted from `double precision` to `integer`,
    but the Drizzle schema declares `bigint`. Safe widening cast, but should match.
    Fixed → `bigint`.
- **No data corruption in 0074:** each column converts from its own value via
  `round(col::numeric)`, not from `standard_cost_cents`. The "corruption" claim was
  already disproven in the C3 finding notes but lingered in the Phase 2 scope.
- Migration `0576_align_money_columns_bigint.sql` fixes all three categories.
- **Exit criteria MET:** no `double precision` or `numeric` in any cost column; schema
  matches DB; money utility layer (`shared/utils/money.ts`) uses integer mills/cents
  throughout with explicit half-up rounding; boundary validation via
  `shared/validation/currency.ts`.

### Phase 3 — Reservations ☑ COMPLETE
Fix H1 (fallback bin → fail loud / require assignment), M1/M2 (idempotency + unique key),
M3 (guarantee or alert on orphan reallocation), M8 (decide backorder in ATP).
- **Exit:** reserve/release idempotent under replay; no silent fallback; orphan path alerts.

**Status:**
- **H1** ☑ Reservation bin selection now excludes frozen locations (`cycleCountFreezeId IS NOT NULL`).
  Both the primary `product_locations` lookup and the fallback `inventory_levels` lookup join
  `warehouse_locations` and filter `WHERE cycle_count_freeze_id IS NULL`. Fallback also filters
  `variant_qty > 0`. Sort order fixed: `isPrimary DESC` (was ascending). New partial index
  `idx_warehouse_locations_unfrozen` added.
- **M1/M2** ☑ Reservation idempotency: `reserveForOrder` now checks for existing reserve row
  BEFORE mutating `reservedQty` (prevents double-increment). Unique partial index
  `uq_inventory_transactions_reserve_dedup` on `(order_id, order_item_id) WHERE transaction_type='reserve'
  AND voided_at IS NULL` mirrors the ship dedup pattern (migration 0570). Migration 0577 auto-voids
  duplicate historical rows before creating the index. Application catches 23505 as belt-and-suspenders.
- **M3** ☑ Orphan reallocation failures now log structured `requires_review` errors (JSON with
  `outcome: "requires_review"`) instead of `console.warn`. The audit-log insert is no longer
  swallowed in a try/catch — it propagates as a real error.
- **M8** ☑ By design. ATP = `onHand - reserved - picked - packed`. `backorderQty` represents
  expected inbound (PO arrivals) — not yet on-hand. Including it would risk overselling on
  undelivered POs. `getTotalBaseUnits()` already surfaces backorder for visibility.

### Phase 4 — Receipts + freeze enforcement ☑ COMPLETE
Receipt idempotency (H4), freeze enforcement across all write paths (H2).

**Status:**
- **H4** ☑ Receipt idempotency: `receiveInventory` now checks for existing receipt row
  before mutating (keyed on `receiving_order_id + product_variant_id + to_location_id`).
  Unique partial index `uq_inventory_transactions_receipt_dedup` added (migration 0578).
  Belt-and-suspenders 23505 catch. Same pattern as ship (0570) and reserve (0577) dedup.
- **H2** ☑ Freeze enforcement: `receiveInventory`, `adjustInventory`, and `transfer` now
  reject mutations on frozen locations (`cycleCountFreezeId IS NOT NULL`). Transfer checks
  both source and destination. Cycle-count adjustments (`cycleCountId` present) are the one
  exception — they are the very adjustments made during a count. `breakVariant`/`assembleVariant`
  go through `adjustInventory` so they inherit the freeze check automatically.
  `FreezeViolationError` is exported for callers to handle.

### Phase 5 — Cycle counts ☐
H2 freeze enforcement completed in Phase 4. Remaining: variance→adjustment audit trail
verification against Phase 0 reconciler, cycle-count-specific edge cases.

### Phase 6 — Replenishment monolith ☐ (LAST of the fix-phases — it's advisory)
Decompose the 3,603-line file; add integration tests for `executeTask`/cascade/state
transitions (currently **zero**); verify H5 (unit conservation in case-break); enforce
`shortPickAction` (H3); kill magic numbers (L5).
- **Exit:** `executeTask` covered by integration tests; no silent unit loss; config validated.

---

> **Phases 0–6 restore trust.** Phases 7+ build the enterprise capability layer on top.
> Do not start 7+ until the numbers are provably correct — see "Sequencing principle".

### Phase 7 — Operational visibility ☐ (Pillar 2)
Kill silent failures and give operators eyes on the system.
- Replace fire-and-forget `.catch(() => {})` on channel sync / replen checks with a durable
  retry + dead-letter path (the C9 webhook-inbox pattern is the template).
- Dashboards/queries for: stuck orders, reconciler drift rate (from Phase 0), unreserved
  shortfalls, replen tasks blocked > N hours, sync-failure backlog.
- Alerting on the above crossing thresholds.
- **Exit:** every financial-path failure is visible in a queue or alert; no swallowed errors
  on inventory-affecting paths.

### Phase 8 — Exception management ☐ (Pillar 3)
Turn ad-hoc warnings into explicit operator workflows + queues.
- First-class exception types with disposition workflows: short pick, damaged/over/under
  receipt, mismatch, stuck replen, orphaned reservation, returns disposition
  (restock / refurb / scrap).
- Each exception is a worked item with owner, state, and resolution audit — not a log line.
- **Exit:** the common warehouse exceptions each have a queue and a closed-loop resolution.

### Phase 9+ — Operational intelligence ☐ (Pillar 4)
The efficiency layer. Sequence by ops value; each is its own initiative, not a sub-task.
- **Wave / batch management** — order batching + release strategy beyond sort rank.
- **Slotting** — velocity-based bin placement; removes the H1 "biggest pile" fallback need.
- **Directed putaway + LPN** — system tells receivers where to put stock; pallet/license-plate.
- **Labor management** — productivity tracking, task interleaving, standards.
- **Multi-node routing** — turn the multi-warehouse schema into real network allocation.
- **Serial / expiry enforcement** — extend the existing lot layer.
- **Reporting/analytics** — valuation, aging, shrinkage, throughput.
- **Exit:** per-initiative; not gated as one block.

---

## 4. Cross-cutting cleanup (any phase)
L1 (enum drift), L2 (dead packed/backorder columns — decide implement vs remove),
L3 (remove `allowNegative` footgun), L4 (junk imports).

---

## 5. Notes
- Allocation engine and `reserveForOrder` are the correct single entry points — preserve
  them (per `BOUNDARIES.md`: reservation goes through `reserveForOrder()` only).
- Transaction safety on the *core* paths (pick/transfer/adjust/receive via use-cases) is
  genuinely good (FOR UPDATE + ledger-in-tx + concurrency-tested). The untrust comes from
  the **bypass paths, missing DB constraints, and the advisory replen layer** — not the
  spine.
