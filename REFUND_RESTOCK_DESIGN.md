# Refund → Inventory / Restock — Design

**Status:** Draft for review · **Date:** 2026-06-08 · **Scope:** Shopify `refunds/create` → WMS/inventory

This doc separates the two things Echelon currently conflates — a **refund** (a financial event plus the channel's *restock intent*) and a **return** (a physical inventory event) — and proposes wiring the `return` case through the existing return-to-stock path. It is grounded in a read-only audit of production and a code read of the refund cascade, the reservation service, and the returns service.

---

## 1. TL;DR

- The refund cascade (`applyShopifyRefundCascade` in `server/modules/oms/oms-webhooks.ts`) correctly handles the **financial** and **order/shipment** side. It **reads and stores** the per-line `restock_type` (as `oms.order_line_adjustments.restock_policy`) but **never uses it to drive an inventory decision**.
- Its only "restock" action is `reservation.releaseOrderReservation(wmsOrder)`, which is a **no-op once a line has shipped** (the reservation was already consumed) and is **not** a physical restock. The code comments flag the real restock as deferred ("C30 will add a formal retry queue") — never built.
- Echelon already has a correct **physical** return path — `POST /api/returns/process` → `ReturnsService.processReturn` — that receives stock to a location at original COGS (sellable) or quarantines it (damaged). The refund path does **not** connect to it.
- **Audited blast radius is small.** Of 149 failed `refunds/create`: **109 `cancel`**, **30 `no_restock`**, **10 `return`**. The cancels were already cancelled in WMS via the order-cancel path (**0 stuck reservations, 0 stuck units — verified**); `no_restock` needs no inventory action. The only real residual is the **~10 physical returns** (~34 units), which need the return-to-stock path regardless of the refund webhook.
- **Conclusion:** this is a *forward-correctness* design (and a small targeted cleanup of ~10 returns), not an urgent inventory-damage incident. The work is the **`return` lifecycle**, not a broad refund-inventory overhaul, and **not** touching the cancel path.

---

## 2. Verified current behavior (grounded)

`applyShopifyRefundCascade` (`oms-webhooks.ts:701–932`), called from `POST /api/oms/webhooks/refunds/create` (`:2029–2202`):

1. **Financial** — `oms.orders`: `financial_status` → refunded/partially_refunded, `refund_amount_cents` (additive), `refunded_at`.
2. **Audit** — one `oms.order_line_adjustments` row per refunded line, including `restock_policy` normalized from `restock_type`/`restock` (`normalizeRefundRestockPolicy`, `:508–517`). Idempotent on `(source, source_event_id, external_line_item_id, adjustment_type)`.
3. **WMS order/shipment** (`applyRefundLineAdjustmentsToWms`, `:578–699`):
   - reduces `wms.outbound_shipment_items.qty` for **planned** shipments;
   - sets `wms.order_items.status = 'cancelled'` if fully refunded and not yet picked/fulfilled;
   - **holds** any `queued`/`labeled`/`shipped` shipment (`requires_review=true`, `review_reason='refund_after_*'`) and cancels `queued` ones in the engine.
4. **Return stub** — inserts `wms.returns` with `restocked = anyRestock` (a boolean computed at refund time).
5. **"Restock"** — `if (anyRestock && helpers.restock)` calls `reservation.releaseOrderReservation(wmsOrderId)` (`:2130–2139`), where `anyRestock` = any line `restock_type ∈ {return, restock}` or legacy `restock=true`.

`releaseOrderReservation` (`reservation.service.ts:334–445`) only decrements `inventory_levels.reserved_qty` for levels where `reserved_qty > 0` and voids the `reserve` transaction. It **does not** add to on-hand (`variant_qty`).

The physical return path — `ReturnsService.processReturn` (`server/modules/orders/returns.service.ts:99`) — is the only code that actually increases on-hand: sellable → `receiveInventory` (new lot at original COGS via `resolveReturnCost`) → immediately available; damaged/defective → receive then adjust-out (quarantine). Requires an explicit `warehouseLocationId` and per-item `condition`.

---

## 3. Audit (read-only, prod, 2026-06-08)

149 failed/dead `refunds/create`, classified from the webhook payloads:

| Intent (`restock_type`) | Refunds | Notes |
|---|---|---|
| `cancel` | 109 | 83 had an already-`cancelled` shipment; 11 distinct orders had no shipment and were already `warehouse_status='cancelled'` |
| `no_restock` | 30 | no inventory action required |
| `return`/`restock` | 10 | all on **shipped** orders (~34 units) — the real physical-return residual |

**Stuck-reservation check (the cancel/no-shipment pocket):** 11 distinct orders, all `cancelled`, **0 with an active (non-voided) `reserve` transaction, 0 reserved units**. → The order-cancel path already released them. **No inventory damage from the cancel failures.**

---

## 4. The gaps

1. **`restock_type` is stored but never drives inventory.** The `return` vs `no_restock` distinction — the entire point of the channel signal — is lost after it's written to the audit table (only re-read later for finance reporting). All refunds get the same WMS treatment.
2. **"Restock" ≠ physical restock.** Releasing a reservation is a no-op on shipped lines, so a refund-with-return on a shipped order sets `restocked=true` but adds **zero** to on-hand. `wms.returns.restocked` is therefore *aspirational*, not factual.
3. **No refund↔return handoff.** A `return` refund and the physical return-to-stock are disconnected: the refund webhook arrives first (money), the item arrives later, and nothing links them.
4. **`location_id` ignored** — multi-location restock target is dropped.

---

## 5. Proposed design — make `return` a lifecycle, leave `cancel`/`no_restock` alone

**Principle:** the refund cascade does the financial + order/shipment work (already correct). The **inventory** leg branches on `restock_policy`, and physical restock is a *lifecycle* reconciled to a physical receipt — not a boolean set at refund time.

### 5.1 Schema
- `wms.returns`: add `status ∈ {expected, partially_received, received, closed}`. Redefine `restocked` to mean **physically received** (or drop it in favor of `status`).
- New `wms.return_items(return_id, order_item_id, product_variant_id, expected_qty, received_qty, restock_policy, location_id, condition)` — per line, so partial receipts and mixed policies work.

### 5.2 Refund cascade — branch per line on `restock_policy`
- **`return`/`restock`:** open a `wms.returns` (+ `return_items`) with `status='expected'`, `expected_qty`, and `location_id` from the payload. **Do not** touch on-hand. (Reservation release only if the line had not shipped.)
- **`no_restock`:** financial + order/shipment adjustments only. No inventory, no expected return. *(Already correct.)*
- **`cancel`:** **leave to the order-cancel path.** Verified: cancellations already release reservations independently. The refund cascade should **not** re-release (double-release risk). At most, it records the adjustment for audit.

### 5.3 Reconcile (the handoff)
When `POST /api/returns/process` runs on physical receipt, match it to the open `wms.returns` for that order+variant, set `return_items.received_qty`, restock via the **existing** `ReturnsService` (sellable → available at original COGS; damaged → quarantine), and advance `status`. **This is the only place on-hand increases** — which is correct (no phantom restock from a webhook).

### 5.4 Durability (the deferred "C30")
Put the inventory leg behind a small retry queue so a failed expected-return creation or restock dead-letters and retries instead of being swallowed (the cascade currently logs-and-continues).

---

## 6. Backlog disposition (the 149)

- **109 `cancel`** — already reconciled by the cancel path; **no action**. Replaying only adds review noise on already-cancelled shipments.
- **30 `no_restock`** — **no action** (no inventory effect by design).
- **10 `return` (shipped, ~34 units)** — the real residual. Handle via the **physical return path** (`/api/returns/process`) if/when the goods are received; once §5 lands, these become proper `expected` returns. *Do not* rely on replaying the refund webhook to restock them — it won't.
- **5 "`cancel` but shipped"** anomalies — worth a one-off look (refund said cancel, item shipped).

**Recommendation:** skip a blind mass-replay; the SQL fix (#608) stops new failures, and the only inventory-relevant items are the ~10 returns + 5 anomalies, handled directly.

---

## 7. Phasing

1. **(done)** Fix the `refunds/create` SQL bugs so the cascade runs (#608).
2. **Schema** — `wms.return_items` + `wms.returns.status`.
3. **Cascade branching** — drive the inventory leg off `restock_policy`; `return` opens `expected`, `cancel` deferred to cancel path, `no_restock` no-op.
4. **Reconcile** — link `processReturn` to open expected returns; restock on receipt; honor `location_id`.
5. **Durability** — retry queue for the inventory leg.

---

## 8. Open questions

- Do we want an **ops surface** for "expected returns awaiting receipt" (so warehouse staff know what's coming)?
- For `return` lines that were **never shipped** (rare), should the refund release the reservation immediately, or still route through an expected return? (Proposed: release immediately — nothing physical is coming back.)
- Should `restock_type='legacy_restock'` (pre-2020 API) be treated as `return`? (Currently unhandled; unlikely in current traffic — confirm none appear.)
