# WMS Inventory Refactor — Trust Restoration Plan

> Companion to `BOUNDARIES.md` / `SYSTEM.md` / `WMS_ARCHITECTURE.md`. This is the
> authoritative tracking doc for making the WMS inventory subsystem **trustworthy** —
> i.e. provably correct under a financial audit. Same contract as `CLAUDE.md`.
>
> Status legend: ☐ not started · ◐ in progress · ☑ done
> Evidence legend: **[VERIFIED]** = confirmed by reading the cited code directly ·
> **[REPORTED]** = surfaced by survey, not yet independently confirmed.

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

**C3 — Floating-point money in cost columns** **[VERIFIED]**
- `0071_create_namespaces.sql` created cost columns as `double precision`:
  `product_variants` (78-80), `purchase_order_lines` (493, 642, 779, 945),
  `po_receipts` (444-446), landed costs (347, 421), and
  `inventory_transactions.unit_cost_cents` (1308).
- `0074_integer_money_cents.sql` fixed **only `product_variants`** (→ `integer`; the
  `USING round(col)` clauses are correct — *no* data-corruption bug, an earlier suspicion
  was disproven on inspection).
- **Still `double precision`** (unfixed): `purchase_order_lines`, `po_receipts`, landed
  costs, and `inventory_transactions.unit_cost_cents`. The Drizzle schema declares several
  of these `bigint`, so there's a schema-vs-DB type mismatch that hides the violation from
  code review. Direct violation of `CLAUDE.md §4` ("never floating point for money").
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

### Phase 0 — Ground-truth reconciler (read-only) ☐
Build a harness that replays `inventory_transactions` and diffs against `inventory_levels`
(on-hand bucket). Output: per-(variant,location) variance report. Zero mutations.
- **Exit:** reconciler runs in CI + on demand; produces a variance count. Expect non-zero
  initially (C4 guarantees drift) — that's the baseline we drive to zero.

### Phase 1 — One guarded write primitive + DB invariants ☐
- Funnel all 32 write paths through a single guarded mutation (tx + lock + ledger-in-tx).
  Close the bypasses: C4 (receiving case-break), M4 (dropship), M5 (variant reassign),
  M6 (CSV).
- Add DB constraints: C1 (unique on variant,location), C2 (qty >= 0), state-machine
  ordering where columns are live.
- Remove C5 (ledger delete) — soft-delete or forbid.
- Decide on C6: add bucket deltas to the ledger so reserved/picked are replayable.
- Fix C7 (`logTransaction` unimplemented) — add the alias on `InventoryUseCases`. This is a
  latent runtime crash on returns-restock / CSV / bin-count paths and could be hotfixed
  ahead of the rest of the phase.
- **Exit:** Phase 0 reconciler hits **zero on-hand variance**; every write provably routes
  through the primitive; constraints live in prod.

### Phase 2 — Money integrity ☐
- Convert remaining `double precision` cost columns to `bigint` (C3): `purchase_order_lines`,
  `po_receipts`, landed costs, `inventory_transactions.unit_cost_cents`.
- **Fix the `0074` corruption** of `last_cost_cents`/`avg_cost_cents` (re-derive from source
  data, not `standard_cost_cents`).
- **Exit:** no `double precision` in any cost column; schema matches DB; values audited.

### Phase 3 — Reservations ☐
Fix H1 (fallback bin → fail loud / require assignment), M1/M2 (idempotency + unique key),
M3 (guarantee or alert on orphan reallocation), M8 (decide backorder in ATP).
- **Exit:** reserve/release idempotent under replay; no silent fallback; orphan path alerts.

### Phase 4 — Receipts + lots ☐
Receipt idempotency (H4), receive freeze-check (H2), over/under variance, FIFO lot integrity.

### Phase 5 — Cycle counts + freeze enforcement ☐
Enforce `cycleCountFreezeId` across transfer/receive/break/adjust (H2). Variance→adjustment
already atomic — verify against Phase 0 reconciler.

### Phase 6 — Replenishment monolith ☐ (LAST — it's advisory)
Decompose the 3,603-line file; add integration tests for `executeTask`/cascade/state
transitions (currently **zero**); verify H5 (unit conservation in case-break); enforce
`shortPickAction` (H3); kill magic numbers (L5).
- **Exit:** `executeTask` covered by integration tests; no silent unit loss; config validated.

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
