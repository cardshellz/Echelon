# Line-Item Hold — Partial Fulfillment for Pre-Orders

**Status:** Proposed — 2026-06-20. Design only; no implementation yet.
**Owner ask:** hold an *individual line item* (e.g. a pre-order that doesn't physically exist yet) and **ship the rest of the order now**, then ship the held line when it arrives — without putting the whole order on hold.
**Builds on:** `SHIPMENT-STATE-MACHINE-DESIGN.md` (Phases 1a–1d done: hold is an orthogonal flag, `on_hold` shipment status retired).

---

## 1. The problem

Order #123 = item **A** (in stock) + item **B** (pre-order, not received yet).
We want: **ship A today, hold B, ship B when the PO lands.**

Today we can't. Holds are **whole-order only** (`wms.orders.on_hold` → ShipStation `holdUntil 2099`). So our only options are (a) hold the entire order (A waits on B — bad) or (b) ship A and lose track of B. There is no per-line hold.

---

## 2. Current state (verified against code)

| Fact | Where | Implication |
|---|---|---|
| **One non-terminal shipment per order is an enforced invariant** | `create-shipment.ts:212` (idempotency probe + `pg_advisory_lock` on order_id) | The natural design — a separate held shipment — **breaks this invariant**. This is the core lift. |
| **ShipStation hold is order-level only** (`holdUntilDate=2099-12-31`) | `shipstation.service.ts` `putOrderOnHold` | We **cannot** ask SS to hold one line. A held line must simply **never be pushed to SS** until released. |
| **Shopify fulfillment is per-shipment and supports partial** | `fulfillment-push.service.ts` `fulfillmentCreateV2` *(per investigation — confirm at impl)* | Ship A → one fulfillment for A's lines; release B later → a second fulfillment. `deriveOmsFromWms` already handles `partially_shipped`. The channel side already supports this. |
| **The per-line hold columns exist but are INERT** | `order_items.on_hold` + `hold_reason`; `outbound_shipments.held` + `held_at` | No code writes them. (The refund-hold that briefly wrote `held` was removed in 1c.) These are the design anchors. |
| **Ready-to-ship gate is all-or-nothing** | `picking.use-cases.ts` `getReadyToShipBlockers` *(per investigation)* | One un-pickable line blocks the **whole** order. Must change so a held line doesn't block the rest. |
| **A backorder concept exists** | `inventory_levels.backorder_qty`, `channels.allow_backorder` | Inventory can already represent "owed but not on-hand." Useful for not reserving a held pre-order line. No per-line *hold* mechanism exists though. |

---

## 3. Core design decisions

- **D1 — A held line lives in its own shipment.** When an order has held line(s), split it: ship-now items → **shipment A** (normal flow), held items → **shipment H** (`held=true`, `status='planned'`, **not pushed to SS**). This reuses the existing *shipment-as-a-unit* model, so order roll-up, ShipStation push, and Shopify fulfillment all keep working per-shipment.
  *Rejected alternative:* keep one shipment and filter held lines out at push time. It makes shipment status ambiguous (a "shipped" shipment that still owes lines) and forces new per-item roll-up logic everywhere. Separate held shipment is cleaner.
- **D2 — "Held" = "not in ShipStation yet."** We do **not** call `engine.hold` for a line hold (SS can't do it). The held shipment is simply withheld from the push; `outbound_shipments.held=true` is the gate that the push must respect.
- **D3 — `order_items.on_hold` + `hold_reason` are the line-level source of truth.** They decide which items go into shipment H.
- **D4 — Release turns shipment H into a normal shipment.** On release: `held=false` → it pushes to SS → gets picked → ships → its own Shopify fulfillment. No item ever moves between shipments after it ships.

---

## 4. End-to-end lifecycle (the pre-order example)

1. **Order syncs in** (#123, items A + B). B is flagged held (how it gets flagged = Decision Q1).
2. **Split:** shipment A = {A}, shipment H = {B}, `held=true`. `order_items.on_hold=true` for B.
3. **Push:** shipment A → ShipStation (normal). Shipment H → **not pushed** (held gate).
4. **Pick + ship A** like any order. Ready-to-ship gate ignores B (held).
5. **Ship-notify for A** → shipment A `shipped` → Shopify fulfillment for A's line → order rolls up to **`partially_shipped`**.
6. **PO for B lands** (goods received). B becomes fulfillable → **release** (auto or manual = Decision Q2).
7. **Release:** shipment H `held=false` → pushed to SS → picked → shipped → second Shopify fulfillment for B → order rolls up to **`shipped`**.

---

## 5. Data model

- **Activate `order_items.on_hold` + `hold_reason`** — line-level intent (the "why": `preorder`, `awaiting_stock`, `manual`, …).
- **Activate `outbound_shipments.held` + `held_at`** as the **push gate** for shipment H (its first real writer + reader).
- **Hold audit** (recommended): who/when/why/released-at — either a small `line_holds` table or reuse picking-log events.
- The composite `outbound_shipment_items (shipment_id, order_item_id)` already lets one order's items live in different shipments — no schema change there.

---

## 6. Layer by layer

**6.1 Where a hold originates (two triggers):**
- **Pick-time (smallest v1):** a lead can't pick a line → "hold line (reason)" → split B into shipment H, ship the rest. Manual, operator-driven.
- **Order-entry / sync (bigger):** a *known* pre-order auto-splits into shipment H from day 1. Needs a pre-order signal (Decision Q1).

**6.2 Shipment split (the invariant break):** new `splitHeldItemsIntoShipment(orderId, heldItemIds[])` (or extend `createShipmentForOrder`) to allow one ship-now shipment + one held shipment. **Constraint:** an item already *picked into* shipment A can't be silently moved — block hold-after-pick or require an explicit un-pick.

**6.3 Picking:** shipment H's items aren't pickable while held. `getReadyToShipBlockers` must treat held lines as *not blocking* so shipment A reaches `ready_to_ship`.

**6.4 ShipStation push:** push must skip `held=true` shipments. Shipment A pushes normally (already filters `qty>0`; B simply isn't in it). On release, H pushes as its own SS order (sibling-dedup must keep A and H as **separate** SS orders — verify against the partial-shipment dedup path).

**6.5 Shopify fulfillment:** A → `fulfillmentCreateV2` for A's lines (partial). B stays unfulfilled. Release+ship → second fulfillment for B. Already supported per investigation.

**6.6 Inventory:** a held pre-order line must **not** reserve/deduct on-hand until released (use backorder accounting). PO receipt of B → marks B release-eligible.

**6.7 Order-status roll-up:** with B in a planned+held shipment, `deriveWmsFromShipments` already yields `partially_shipped` after A ships. **But** every reader of "open shipments" must become **held-aware** so a held shipment doesn't look stuck: pick queue, ops-health/flow-monitor "not pushed" alerts, address-change re-push, the reconciler. This is where the `held` flag finally earns its keep.

**6.8 Front-end UI:**
- **Hold action** (line-level, lead-gated) on the order/picking screen: pick a line → Hold → reason (+ optional ETA).
- **Display:** order badge "Partially shipped — 1 line held (pre-order)"; the held line shows a Held badge + reason + ETA.
- **Release action** (manual) + the auto-release path.
- **Ops:** a held-line **aging report** (lines held > N days), and an "all lines held" exception view.

**6.9 Reconcile / monitoring:** held shipments don't time out and don't trip "stuck/not-pushed" alerts. New metrics: lines-held, held-aging, all-items-held exceptions.

---

## 7. Edge cases

- **Whole order is pre-order** (every line held) → no ship-now shipment; order is effectively held but with per-line semantics.
- **Multiple held lines, different ETAs** → one held shipment, or one per ETA? (Decision Q3.)
- **Refund/cancel of a held line** → cancel shipment H (or its line); the refund cascade (post-1c) must treat a held line sensibly (flag for review, don't auto-ship).
- **PO cancelled / B never arrives** → held forever → aging alert + a manual cancel path for the held line.
- **Channel cancels the order** while B is held → cancel both shipments (the #668 channel-cancel path, made held-aware).
- **Item already picked into shipment A, then someone wants to hold it** → blocked (can't move a picked item) → flag for manual handling.

---

## 8. Resolved decisions (2026-06-20, with the owner)

1. **Hold starts MANUALLY in the UI.** A lead/operator marks a specific line held (with a reason). No auto-detection of pre-orders in v1. (Today's hold is order-level only, so the new **line-item hold UI mechanism is the starting point**.)
2. **Release is MANUAL.** An operator clicks Release when the stock lands. (Auto-release on PO receipt is a later enhancement.)
3. **Each held line is its OWN held shipment** → it ships the moment it's released, independently of any other held line. No regrouping / no waiting to combine. (Also the simpler build.)
4. **No extra customer comms in v1.** Lean on Shopify's automatic "partially fulfilled" status; ETAs / proactive emails are later.
5. **v1 = manual hold + manual release**, end-to-end. Auto-detect + auto-release layered on afterward.
6. **Access control — gated by the existing RBAC.** Hold/release use the permission **`orders:hold`** (already defined; admin + lead have it, **picker does not**). Backend: `requirePermission("orders","hold")` on the endpoints. Frontend: render the Hold/Release buttons only when `useAuth().hasPermission("orders","hold")` ([auth.tsx](client/src/lib/auth.tsx)). Not available to pickers by default. *(Open micro-decision: reuse `orders:hold` — simplest, recommended — vs. add a dedicated `orders:hold_line` permission if line-hold should be controlled separately from whole-order holds.)*

---

## 9. Phased plan

**v1 = a held line is pulled out of shipping, the rest ships, and a manual release ships the held line — with its UI.** Build sequence:

- **P1 — Line hold mechanism (UI + backend write).** "Hold line (reason)" + "Release line" actions on the order/picking screen; backend endpoint writes `order_items.on_hold` + `hold_reason` + a hold audit; "Held" badge + held-line visibility. Lead-gated. Constraint: a line already picked into the ship-now shipment can't be held (block or require un-pick).
- **P2 — Held line does not ship; the rest does.** Held line goes into its own shipment with `held=true`; the SS push, pick queue, and stuck-order readers skip held shipments; the ship-now shipment ships normally. **(P1+P2 = the safe minimum — a hold must actually withhold the line.)**
- **P3 — Release → ship.** Release clears `held`; the held shipment pushes to ShipStation → picks → ships → its own Shopify fulfillment (partial). Order rolls up `partially_shipped` → `shipped`.
- **P4 — Inventory:** held line doesn't reserve/consume on-hand until released (backorder accounting); receiving makes it release-eligible.
- **P5 — Ops:** held-line aging report; all-lines-held exception view.
- **P6 — (optional, later)** auto-detect pre-orders at sync + auto-release on receipt.

Each phase is independently shippable; **P1+P2+P3 is the minimum working manual flow.**
