# Fulfillment-State Model — Design

**Status:** Draft for review · **Date:** 2026-06-15 · **Scope:** order/shipment/line fulfillment status across OMS ↔ WMS ↔ shipping engine ↔ sales channels

Replaces the shipment-row-status-driven fulfillment status with a **single line-level fulfillment truth** that every status derives from — and is **channel-agnostic** (Shopify, eBay, .ops dropship, future channels) and **shipping-engine-agnostic** (ShipStation today, a future in-house engine later) by construction. Grounded in a full code map of every status writer, the channel paths, and the canonical shipping layer. Composes with [REFUND_RESTOCK_DESIGN.md](REFUND_RESTOCK_DESIGN.md).

---

## 1. The problem

Fulfillment status is derived **three inconsistent ways** and they drift:

1. **WMS `warehouse_status`** from `deriveWmsFromShipments(shipmentStatuses)` ([shared/enums/order-status.ts:175](shared/enums/order-status.ts)) — keyed off the **set of shipment-row statuses** (*"any shipped + any open → partially_shipped"*). A leftover/duplicate shipment row manufactures a false `partially_shipped`.
2. **OMS `status`** — set both by `deriveOmsFromWms` **and** directly from Shopify `fulfillment_status` webhooks → gets stuck (#57921, #58110).
3. **`wms.order_items.fulfilled_quantity`** — a third, separately-mutated mirror.

Plus 8+ direct status `UPDATE`s bypass the guarded writers, and the order-level hold flag is ignored. **Root cause:** no single line-level source of truth for *units of each line actually shipped*. It must also not be Shopify- or ShipStation-specific.

---

## 2. The model

### 2.1 Source of truth: `wms.line_fulfillments` (append-only ledger)

```
wms.line_fulfillments
  id                bigserial PK
  order_item_id     int NOT NULL  FK wms.order_items.id          -- WMS line covered
  shipment_id       int NOT NULL  FK wms.outbound_shipments.id   -- the shipment that carried it
  qty               int NOT NULL CHECK (qty <> 0)                -- + = shipped, − = void/return reversal
  kind              varchar(20) NOT NULL  -- 'shipped' | 'void_reversal' | 'return' | 'manual_correction'
  source            varchar(30) NOT NULL  -- ENGINE/CHANNEL-NEUTRAL: 'warehouse' | 'reconcile' | 'operator'
  external_event_id varchar(200)          -- engine shipment ref / channel fulfillment id (generic)
  occurred_at       timestamptz NOT NULL
  created_at        timestamptz NOT NULL DEFAULT now()
  UNIQUE (order_item_id, shipment_id, kind, external_event_id)   -- idempotency / replay-safe
```

`net_shipped_qty(line) = Σ qty` over rows whose shipment is shipped-equivalent. `source` is **deliberately engine/channel-neutral** — every warehouse ship is `'warehouse'` regardless of ShipStation/future-engine or Shopify/eBay/dropship; the specific engine lives on the shipment's `shipping_engine` + `EngineRef`, the specific channel on the order. `shipment_id NOT NULL` holds for **every** channel: **all channels (incl. .ops dropship) are warehouse-fulfilled by us** — there is always a real `wms.outbound_shipments` row.

### 2.2 Cancellations/refunds: `oms.order_line_adjustments`

Idempotent, keyed `(source, source_event_id, external_line_item_id, adjustment_type)`. `effective_ordered = ordered_qty − Σ adjustment qty`. **Every channel** must write here (today only Shopify does — see §5.4).

### 2.3 Holds: overlays at three scopes (never touch fulfillment truth)

| Scope | Representation | Meaning |
|---|---|---|
| **Order** | `wms.orders.on_hold` (existing flag, **make derivation honor it**) | freeze whole order |
| **Line** | **NEW** per-`wms.order_items` hold (`on_hold` + `hold_reason`) | pause one line/SKU; rest ships |
| **Shipment** | `outbound_shipments.status='on_hold'` / `requires_review` (existing) | one box flagged for review |

Holds are **operator-controlled (v1)** — set/cleared by people inside Echelon. Channel-side pauses (eBay backorder, etc.) are **surfaced as flags** but never auto-flip a hold (no per-channel hold-signal interpreter to build/maintain; no channel-vs-operator conflict). A held line is "owed but paused": doesn't count toward fully-shipped, excluded from the pickable set, doesn't block other lines (→ `partially_shipped`). All open lines held → order `on_hold`. (The dropship "awaiting funding" hold is enforced **upstream** — those orders aren't accepted/synced to WMS until funded — so it needs no WMS hold.)

### 2.4 Channel- and engine-agnostic by construction

The core (ledger anchored on `order_item_id`, `net_shipped_qty` arithmetic, `order_line_adjustments`, the derivation cascade, holds) has **zero channel or engine branching**. Variation is confined to two thin seams:

- **Inbound seam (NEW): `recordFulfillmentEvent({ orderRef, lines:[{externalLineItemId, qty}], kind, source, external_event_id, occurred_at, tracking? })`** — the *only* entry that inserts ledger rows + calls `recomputeOrderFulfillment`. Every channel/engine path funnels through it. It owns `external_line_item_id → oms_order_line → wms.order_item` resolution and **hard-blocks unmapped lines to `requires_review`** (one place, all channels). Ship events arrive here as a **`CanonicalShipmentEvent`** ([shipping/types.ts](server/modules/shipping/types.ts)) produced by `ShippingEngine.normalizeWebhook()` — already engine-agnostic and **already carrying per-line `items[{sku, quantity}]`**. A future in-house engine = one new `ShippingEngine` adapter; **ledger, derivation, and statuses don't change**.
- **Outbound seam (exists): `IChannelAdapter.pushFulfillment` / `ShippingEngine.upsertShipment`** — fulfillment/tracking write-back per channel (your Shopify, eBay, or the dropship customer's marketplace) and per engine. Orthogonal to the ledger.

Use the engine-neutral `engine_order_ref` / `shipping_engine` columns + `EngineRef`, **never** `shipstation_order_id` (legacy shadow columns, already TODO'd for removal).

### 2.5 Single guarded writer

`recomputeOrderStatusFromShipments` → **`recomputeOrderFulfillment(db, wmsOrderId)`**: the only writer of `wms.orders.warehouse_status`, the `fulfilled_quantity` cache (`= net_shipped_qty`), and the OMS-derivation trigger. Reads ledger + adjustments + hold flags; writes in one transaction with `SELECT … FOR UPDATE` on `wms.orders`. The 8+ direct status `UPDATE`s are replaced with *(insert ledger row / adjustment / hold) → recompute.* OMS status is **never** set directly from a channel webhook again.

---

## 3. Derivation (pure, bottom-up)

1. **`net_shipped_qty(line)`** = Σ ledger qty for shipped-equivalent shipments (voids/returns negative → self-healing).
2. **`deriveLineState(ordered, net_shipped, cancelled, lineHold)`**, `effective = ordered − cancelled`: `lineHold` → `on_hold`; `effective<=0` → `cancelled`; `net_shipped>=effective(>0)` → `fulfilled`; `0<net_shipped<effective` → `partial`; else `unfulfilled`.
3. **`deriveWmsFromLines(lines, anyShipmentOnHold, orderOnHold)`** (replaces `deriveWmsFromShipments`): order/line/shipment hold → `on_hold`; all shippable lines `cancelled` → `cancelled`; every line `fulfilled` → `shipped`; some units shipped + some owed → `partially_shipped`; none shipped → preserve in-warehouse progress else `ready`.
4. **`deriveOmsFromWms(wmsStatus)`** unchanged.

**Key property:** a stale/duplicate shipment has zero ledger rows → contributes nothing → cannot create a false `partially_shipped`. Kills the duplicate/false-partial class structurally.

---

## 4. Abstract events → line-level effect (per channel)

Event names are **abstract**; each channel maps its mechanism onto them.

| Abstract event | Shopify | eBay | .ops dropship | Effect on truth |
|---|---|---|---|---|
| **line shipped** | SHIP_NOTIFY (warehouse) or `orders/fulfilled` (parse `line_items`) | warehouse SHIP_NOTIFY (we ship; eBay doesn't report it) | warehouse SHIP_NOTIFY | `CanonicalShipmentEvent.shipped` → `recordFulfillmentEvent(source='warehouse')` → ledger rows → recompute. Then per-channel tracking write-back. |
| **cancel (full/partial)** | `orders/cancelled` webhook | 5-min poll (order-level) | dropship cancellation service | `order_line_adjustments` rows → recompute. **No per-line data → §5.4.** |
| **refund** | `refunds/create` (per-line) | poll (order-level amount) | marketplace refund | `order_line_adjustments` rows → recompute. Shipped units → expected return (§5.1). |
| **void / re-label** | engine | engine | engine | negative `void_reversal` ledger rows → recompute. |
| **hold** | operator | operator | operator (funding gate upstream) | hold overlay (§2.3); channel pauses surfaced as flags only. |

All ship events share one warehouse spine via the engine layer; the difference is **only** order intake (webhook / poll / dropship accept) and tracking write-back target.

---

## 5. Locked product decisions

1. **Refund/cancel of already-shipped units → "expected return," on-hand only at physical receipt.** Record `wms.returns`+`return_items` (`status='expected'`) + `requires_review`; don't touch on-hand or `net_shipped` at refund time. On-hand increases only at physical receipt via the existing `ReturnsService.processReturn` (`/api/returns/process`), which inserts the negative `return` ledger row + restocks at original COGS. Scan/auto-match UI is a fast-follow, not a blocker. (Aligns with [REFUND_RESTOCK_DESIGN.md](REFUND_RESTOCK_DESIGN.md).)
2. **Cancel after a unit shipped → truth wins.** Shipped unit stays `shipped`; order derives `shipped`/`partially_shipped` + `requires_review`; the cancel only zeroes un-shipped units. Never force `cancelled` over a real shipment.
3. **Holds:** fix derivation to honor the order-level flag; keep order/shipment scopes **distinct**; **add a per-line hold**; all **operator-controlled in v1** (channel pauses surfaced as flags, not auto-applied).
4. **Marketplace cancel/refund with no per-line detail:** a **full cancel** is unambiguous → auto-write all-line adjustments. A **partial** with no line breakdown → record the financial refund, flag `requires_review`, operator confirms which line/qty (a best-effort amount-match *suggestion* may be offered, never auto-written). Never guess line allocation. (Shopify sends per-line detail, so this path is eBay/marketplace-only.)
5. **Channel write-uniformity:** eBay and dropship cancels/refunds are refactored to write `oms.order_line_adjustments` (today eBay does raw `UPDATE oms_orders`, dropship its own path) so derivation is uniform across channels.

---

## 6. Edge-case matrix (condensed)

| Scenario | Correct end state | How |
|---|---|---|
| Stale/duplicate open shipment + another ships all units | `shipped` | Stale row has 0 ledger rows. (Delete the `cancelStaleShipmentsIfFullyCovered` band-aid.) |
| Legit split / multi-warehouse | `partially_shipped`→`shipped` | `net_shipped` sums across shipments per line; monotonic. |
| .ops dropship order | warehouse-fulfilled like any order; tracking pushed to customer's marketplace | Real shipment + ledger rows; `recordFulfillmentEvent(source='warehouse')`; `DropshipMarketplaceTrackingService` writes back. |
| Full cancel after label | shipment `on_hold`+review; void→`cancelled`, ship→`shipped` | Truth wins (decision 2). |
| eBay partial refund, $20 of $50 2-item order, no line data | money recorded; `requires_review`; operator picks the line | Decision 4. |
| Refund of shipped unit (restock=return) | `expected` return + review; on-hand at receipt | Decision 1. |
| Shopify-direct int'l fulfillment | `shipped`/`partially_shipped`, no dup push | Per-line parse → ledger → derive. |
| Line hold on 1 of 3 lines | `partially_shipped`; held line `on_hold` | Held line owed-but-paused; doesn't block others. |
| Future engine replaces ShipStation | no change | New `ShippingEngine` adapter; canonical events unchanged. |
| Duplicate ship event replay | no double-count | Ledger UNIQUE key + same-tracking no-op. |

---

## 7. Migration (staged, reversible, no big-bang)

- **Phase 0 — schema (inert):** `wms.line_fulfillments` + line-hold columns on `wms.order_items`. No behavior change.
- **Phase 1 — backfill + validate:** ledger rows from every shipped/returned/lost shipment's `outbound_shipment_items`; negative reversals for historical voids. **Prefer channel/shipment truth over the stale `fulfilled_quantity` mirror.** Reconciliation report; flip no statuses.
- **Phase 2 — dual-write + shadow:** `markShipment*` also writes ledger; `recomputeOrderFulfillment` computes new (`deriveWmsFromLines`) and old, **logs divergences**, still writes old. Soak.
- **Phase 3 — cutover (per-writer, flagged):** flip to ledger-derived; convert each direct-`UPDATE` bypass to (ledger row → recompute) lowest-traffic first: `orders.storage` → **eBay (incl. cancel/refund→adjustments)** → **dropship (cancel/refund→adjustments)** → `wms-sync` → `oms-webhooks` fulfilled/refund/cancel → engine SHIP_NOTIFY (v2 then legacy). Re-validate after each. Add the **`recordFulfillmentEvent` inbound seam** here and route every channel/engine through it. Keep `deriveWmsFromShipments` one release for rollback.
- **Phase 4 — remove band-aids:** delete `cancelStaleShipmentsIfFullyCovered`, the planned-only refund qty hack, flat "all lines fulfilled" writes, reconciler force-writes. Demote `fulfilled_quantity` to a derived cache.

**Rule:** never change a status writer + reader in the same deploy; ledger writes precede the derivation switch; every phase independently revertible; Phase-1 validator runs in CI + as a scheduled prod check.

---

## 8. Risks

1. **Combined-group shared tracking:** a re-label/void on one child box must fan out to siblings (tracking + their channel fulfillments). `markShipment*` has no sibling awareness — needs a combined-group-aware hook.
2. **Backfill accuracy:** historical `fulfilled_quantity` is stale; backfill must prefer channel/`outbound_shipment_items` truth.
3. **Line-mapping fragility:** items/`line_items` must map to `wms.order_items`; unmapped → **hard-block to `requires_review`**, never silent under-count. The single `recordFulfillmentEvent` seam enforces this for all channels.
4. **Adjustments keyed by external line id, ledger by `order_item_id`:** join must hold; legacy OMS-lines-without-WMS-items need a fallback.
5. **Transaction/locking:** `recomputeOrderFulfillment` needs `SELECT … FOR UPDATE` on `wms.orders`.
6. **Void vs return semantics:** honor `kind` so restock isn't mis-driven.

---

## 9. Open questions (remaining)

- **Shopify-direct shipments:** also create `outbound_shipment_items` rows (table consistency) or treat `line_fulfillments` as sufficient there? (Affects existing `shipment_items` consumers.)
- **Combined-group re-label fan-out:** reuse `pushFulfillmentForCombinedGroup`-style iterator or a new sibling-resolver for void/re-label?
- **Per-line ship quantities:** the canonical `CanonicalShipmentEvent.items[]` carries them; confirm the engine adapter always populates them (define a fallback allocation rule + flag if any flow is order-level-only).
- **`fulfilled_quantity` consumers:** reference audit (reports/exports) before demoting to a derived cache.

---

## 10. What this is NOT

Not a refund-inventory overhaul ([REFUND_RESTOCK_DESIGN.md](REFUND_RESTOCK_DESIGN.md) composes with it), not a change to the cancel→reservation-release path (correct), not an immediate shipment-uniqueness-index tightening (separate, once duplicate splits are proven gone), and **not coupled to ShipStation or any one sales channel** — both sit behind swappable adapters.
