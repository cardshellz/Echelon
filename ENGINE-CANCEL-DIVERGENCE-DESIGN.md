# Engine-side Cancel Divergence — Design Note

**Status:** Proposed — 2026-06-23. Design only; no implementation yet.
**Trigger:** order #59061 (oms 217345 / wms 204130 / shipment 3747, SS order 751077498).
**Builds on:** `SHIPMENT-STATE-MACHINE-DESIGN.md` (ownership model: engine owns physical facts; WMS owns intent).

---

## 1. The incident (verified)

Order #59061's item (`SHLZ-TOP-TOB-P25`) was **out of stock — reserved 0** at order time. An operator (`cardshellz-ops`) cancelled the order **in ShipStation** on 6/19 9:32 (intending to refund/cancel the order, which they did 3 days later). What the system did:

- **6/19 9:32** — cancelled in ShipStation (operator).
- **6/19 23:03** — the WMS reconciler polled SS, saw `orderStatus=cancelled`, and **marked WMS shipment 3747 cancelled** (`cancelled_via_shipstation` / `engine_cancelled`) → rolled the WMS order to `cancelled`.
- **(between 6/19 and 6/22)** — a WMS `createorder` push hit the cancelled SS order and **resurrected it** to `awaiting_shipment`.
- **6/22 11:43** — operator had to **cancel it again** (it showed active).
- **6/22 19:46/47** — Shopify refund then cancel; both no-ops (`"noShipments": true`) because the shipment was already cancelled.

So the system **thrashed**: one half followed the SS cancel and cancelled the shipment; another half silently re-pushed and resurrected it. The operator had to cancel twice.

---

## 2. Root cause (two bugs)

### A. The reconciler treats an engine-side cancel as authoritative
[`reconcile-derive.ts:57-63`](server/modules/shipping/reconcile-derive.ts:57):

```
if (engineState.status === "cancelled" && currentWmsShipmentStatus !== "cancelled")
  return { kind: "cancelled", reason: "engine_cancelled" };
```

It cancels the WMS shipment whenever ShipStation shows cancelled — **with no check that the order itself is cancelled.** This contradicts the ownership model in `SHIPMENT-STATE-MACHINE-DESIGN.md` §2.3: **cancel is WMS-intent-owned; the engine does not own it.** An accidental or operational SS cancel of a *live* order should never silently cancel the WMS shipment.

### B. `createorder` resurrects a cancelled SS order, and not all push paths guard it
ShipStation's `POST /orders/createorder` (used for upserts) brings a cancelled order back to `awaiting_shipment`. The codebase already knows this — [`markAsShipped`](server/modules/oms/shipstation.service.ts:3102) explicitly guards: *"orders in 'shipped' or 'cancelled' state cannot be updated via createorder"* and returns early if `orderStatus === 'cancelled'`. But the other upsert paths don't:

- `pushShipment` ([:3721](server/modules/oms/shipstation.service.ts:3721)) checks only the **WMS** shipment status (`PUSHABLE_SHIPMENT_STATUSES`), never the **SS** order's status.
- `updateShipStationCustomField1` ([:3230](server/modules/oms/shipstation.service.ts:3230), sort-rank sync) re-POSTs `{...ssOrder, customField1}` with **no orderStatus check at all**.

So any such push onto an externally-cancelled SS order resurrects it.

> The "refund-first-then-cancel" theory is **not** the cause — the 6/22 refund/cancel were downstream of an order already cancelled (6/19) and resurrected by bug B.

---

## 3. Design decision

**An engine-side cancel of a *live* order is a discrepancy, not a fact to act on.** The system must not silently pick a side (it can't infer whether the SS cancel was an accident → re-push, or intentional → cancel the order). It **flags the shipment for review** and lets a human resolve it. (If/when we want a non-blocking default while flagged, re-push *with a loud alert* is more defensible than silent-cancel — but the alert is the point.)

This keeps the ownership model intact: the engine reports a fact (the SS order is cancelled), but it does not get to drive the WMS *cancel intent*.

---

## 4. The fix (three parts)

### 4.1 Reconciler — gate the cancel on order intent
In `deriveReconcileEvent`, change the `engine_cancelled` branch:
- **Order is cancelled** (OMS/channel cancelled) → cancel the WMS shipment, as today (the cancel is real).
- **Order is live** → **do not cancel, do not re-push.** Keep the shipment's lifecycle status and set `requires_review = true, review_reason = 'engine_cancelled_order_active'`.

`deriveReconcileEvent` currently only receives `engineState` + `currentWmsShipmentStatus` ([reconcile-derive.ts:17-23](server/modules/shipping/reconcile-derive.ts:17)); it needs the **order's cancel state** plumbed in (the reconciler in `server/index.ts` already has the order context). The "flag for review" outcome likely needs a new `ReconcileEvent` kind (e.g. `{ kind: "review", reason }`) or for the caller to handle the live-order case directly.

### 4.2 `createorder` cancelled-guard (defense in depth)
Give `pushShipment` and `updateShipStationCustomField1` the same guard `markAsShipped` already has: before an **update** upsert (an existing SS order id), fetch the SS order and **skip (and ideally flag) if `orderStatus === 'cancelled'`** — so a stray push can't silently resurrect a cancelled order even if 4.1 misses a path.

### 4.3 Operator resolution (close the loop)
The flagged shipment already surfaces — **no new bucket needed**:
- `SHIPMENT_REQUIRES_REVIEW` in the **Flow Monitor** ([flow-waterfall.service.ts:194](server/modules/oms/flow-waterfall.service.ts:194)) and **ops-health** ([ops-health.service.ts:625](server/modules/oms/ops-health.service.ts:625)) — any `requires_review = true` shipment, rolled up by `review_reason`.

The operator resolves from the **OMS Orders page** ([OmsOrders.tsx:294](client/src/pages/OmsOrders.tsx:294), "Push to ShipStation" → `/api/oms/orders/:id/push-to-shipstation` → `pushShipment`). Two outcomes:
- **Re-push** (it should ship) — **but `pushShipment` refuses `requires_review = true`** ([shipstation.service.ts:3411](server/modules/oms/shipstation.service.ts:3411)). So the action must **clear `requires_review` + push** — an explicit operator override of the guard. This is the one genuinely-new UI/endpoint behavior.
- **Cancel** (the SS cancel was intentional) — cancel/refund the order in the channel, as today.

> The Flow Monitor itself is **observe-only today** ([FlowMonitor.tsx:671](client/src/pages/FlowMonitor.tsx:671) — *"the existing replay / requeue / remediate endpoints can be wired here as one-click actions later"*), so the operator acts from the order page, not the monitor. Wiring a one-click "re-push / cancel" into the monitor is optional follow-up.

---

## 5. Scope / phasing

- **P1 (core + safety):** 4.1 (reconciler gate) + 4.2 (createorder guard). Stops both the wrong-cancel and the resurrection. The shipment lands in the existing review bucket.
- **P2 (resolution UX):** 4.3 — make "Push to ShipStation" clear-review-and-push for a flagged shipment (explicit override), so the operator can act in one step. (Optional: surface re-push/cancel directly in the Flow Monitor.)

## 6. Edge cases / open questions

- **Order cancelled *after* the SS cancel** (#59061's real shape): once the channel cancel arrives, the flagged shipment should resolve to cancelled automatically (the cancel cascade / next reconcile sees the order cancelled). Verify the flag clears.
- **Re-push override + the createorder guard (4.2) interaction:** an explicit operator re-push must bypass 4.2's cancelled-skip (the operator is intentionally resurrecting). Make sure the override path doesn't get blocked by its own guard.
- **`held` shipments** (line-item hold) are already excluded from the not-pushed detectors and the push guard refuses them — confirm the review flag + held flag don't collide on the same row.
- **Backfill:** any current shipments cancelled-in-WMS-via-engine while their order is still live? (Spot-check; likely just #59061.)
