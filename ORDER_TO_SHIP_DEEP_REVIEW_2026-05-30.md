# Order → Shipment Lifecycle — End-to-End Deep Review (2026-05-30)

**Scope:** The entire pipeline, channel intake → OMS → reservation → WMS pick → shipment →
ShipStation → channel write-back, plus every cancel/refund/reconcile path that mutates that
state.
**Method:** Six parallel forensic traces (one per stage + cross-cutting background jobs), each
grounded in `file:line`, cross-checked against `BOUNDARIES.md`, `CLAUDE.md`, and the prior
`ORDER_TO_SHIP_AUDIT_2026-05-28.md`. Facts are separated from HYPOTHESIS; gaps marked
INSUFFICIENT EVIDENCE.
**Branch:** `claude/fix-order-release-error-sHWUf`. Supersedes the 2026-05-28 audit where noted
(some of its findings are now fixed; new ones are added).

---

## 0. Why it keeps regressing — six structural root causes

Every recurring symptom (duplicate ShipStation orders, the "already shipped — cannot cancel"
spam, zombie orders, "order changed after sync", stuck `partially_shipped`) traces back to one
or more of these. Point-fixes regress because they patch a symptom inside one of these holes
instead of closing the hole.

1. **No shipment ownership model.** There are **8 distinct code paths that INSERT
   `wms.outbound_shipments`**, with inconsistent or absent dedup, and **no unique constraint on
   `outbound_shipments(order_id)`**. The ShipStation `orderKey` is **per-shipment-row**
   (`echelon-wms-shp-${shipmentId}`), so every duplicate WMS row becomes a *distinct* SS order.
   There is no per-order idempotency anywhere in the push path.

2. **No transactional unit-of-work across system seams.** Intake (order+lines+events), OMS→WMS
   sync (order+items+reservation+shipment+push), and the SHIP_NOTIFY cascade (shipment→rollup→
   OMS→inventory→channel) are each long sequences of independent `await`s with no enclosing
   transaction. A throw or crash mid-sequence leaves OMS/WMS/inventory split-brain.

3. **No single guarded state machine.** `warehouse_status` is written by **12+ scattered
   writers** with `WHERE id = ?` only (no from-state guard), and by **~19 schedulers** that can
   disagree. Illegal transitions (`cancelled → ready`, `shipped → in_progress`) are mechanically
   possible. `cancelled` is **not terminal** — `deriveWmsFromShipments` re-derives a cancelled
   order back to `ready_to_ship`, creating oscillation loops.

4. **Idempotency by status-guard instead of durable keys.** Replays either double-act (duplicate
   `oms_order_events`, duplicate Shopify/eBay fulfillments) or skip required work (durable partial
   cancel: the cancel guard on `oms_orders.status` short-circuits the *shipment* cascade on retry).

5. **Unhappy paths never reconcile physical inventory.** Cancel/refund release *reservations* but
   never return *picked* units to on-hand (no path calls `unpick`); a lost SHIP_NOTIFY strands
   `picked_qty` forever (no reconciler replays `recordShipment`). Both are silent inventory loss.

6. **Uncoordinated reconcilers.** ~19 background jobs with overlapping selectors and no shared
   lock fight over `warehouse_status`, shipments, and the ShipStation API — producing the live
   cancel-spam oscillation and latent duplicate re-creation.

**Count across stages:** ~10 P0 · ~22 P1 · ~15 P2 (deduped register in §3).

---

## 1. End-to-end lifecycle map (what actually happens)

### Stage 1 — Channel intake → OMS (`oms.service.ts:ingestOrder`)
All non-dropship channels funnel into `ingestOrder` (`oms.service.ts:112-293`), deduped on
`(channel_id, external_order_id)` via a real unique index (`oms.schema.ts:105`). Writes order
header → per-line variant lookup + line inserts → `created` event. **Not transactional**
(`oms.service.ts:118-289`). Dropship is the strongest path: Zod-validated, single BEGIN/COMMIT,
`FOR UPDATE` (`dropship-order-acceptance.repository.ts:156-166`).

### Stage 2 — OMS→WMS sync + reservation (`wms-sync.service.ts:syncOmsOrderToWms`)
Dedup probe (unlocked) → `createOrderWithItems` (**the only transaction**, advisory-locked,
`orders.storage.ts:642-687`) → **post-commit best-effort**: `createShipmentForOrder` (`:456`),
`reserveOrder` (`:479`), route (`:490`), `pushShipment` (`:508`). Re-sync routes to
`reconcileExistingWmsOrderLines` (Case A/B/C shipment logic, `:853-933`).

### Stage 3 — WMS picking + order/item state machine
`claimOrder` is atomic (`orders.storage.ts:726-751`). `pickItem` deduct is transactional,
`FOR UPDATE`, negative-guarded (`inventory.use-cases.ts:137-190`) — **but never re-checks parent
order cancel/hold state**. `getPickQueueOrders` (a GET) performs mutating self-heal UPDATEs.

### Stage 4 — WMS → ShipStation outbound
9-value status enum (`order-status.ts:53-65`). 8 INSERT paths (§3, D-DUP). `pushShipment`
upserts SS `/orders/createorder` keyed on per-shipment `orderKey` (`shipstation.service.ts:3115`).
`cancelOrder` returns `{alreadyInState:true}` without throwing for already-shipped orders
(`:2840-2842`).

### Stage 5 — SHIP_NOTIFY inbound → write-back
13-step cascade (`shipstation.service.ts:1898-2031`), **no enclosing transaction**; only
`recordShipment` is internally transactional and idempotent (`inventory.use-cases.ts:279-291`).
Order rollup `deriveWmsFromShipments` (`order-status.ts:171-191`) treats `voided/planned/queued`
as open. Channel write-back (`fulfillment-push.service.ts`) has no idempotency key for
Shopify/eBay; dropship does.

### Stage 6 — Background jobs (~19) + cancel/refund cascades
Inventory of all schedulers and the conflict matrix in §4. Shopify cancel cascade
(`oms-webhooks.ts:1690-1817`) is non-transactional; refund cascade runs SS side-effects before
its idempotency check (`:675` before `:685`).

---

## 2. The two live symptoms — definitive root cause

### 2A. Duplicate ShipStation orders
**Mechanism:** the SS `orderKey` is per-shipment-row, so two WMS shipment rows for one order
push as two SS orders. Ranked sources of the second row:
1. **Shopify external-fulfillment webhook Path B** (`shopify.routes.ts:255-302`, `480-514`)
   inserts a `shipped` row matched only on `shopify_fulfillment_id`, **without checking for an
   existing active shipment** — leaves the original `planned`/`queued` row active.
2. **`createShipmentForOrder` dedup excludes `voided`** (`create-shipment.ts:254`) but rollup
   treats `voided` as open (`order-status.ts:97`) → re-sync makes a new `planned` row beside the
   voided one.
3. **Per-shipment orderKey** (`shipstation.service.ts:3115`) — no per-order idempotency.
4. **SS auto-split** round-trips new `queued` WMS rows (`shipstation.service.ts:1008`, `1365`).
5. **`FulfillmentService.createShipment`** writes the **invalid enum value `"pending"`**
   (`fulfillment.service.ts:112`) with **zero dedup**.
6. **Concurrent OMS→WMS sync** — probe→insert has no lock (`create-shipment.ts:250-330`).

**Structural fix:** partial unique index on `outbound_shipments(order_id)` for open states +
order-keyed advisory lock around probe+insert + make all 8 paths converge on one creator.

### 2B. "Already shipped — cannot cancel" spam
**Log site:** `shipstation.service.ts:2841` — `cancelOrder` logs and returns
`{alreadyInState:true}` *without throwing* for shipped SS orders.
**The loop (definitely true):**
- Job **#4 OMS↔WMS reconcile** (`index.ts:858-928`, hourly) sets an OMS-cancelled order's WMS
  `warehouse_status='cancelled'`, then cancels its active shipments' SS orders (`:907`).
- `deriveWmsFromShipments` **never returns `completed`** and returns `ready_to_ship` for an order
  whose shipments are all open (`order-status.ts:171-191`). So `recomputeOrderStatusFromShipments`
  (run by V2 #8 every 10 min, and by cascades) **flips the cancelled order back to
  `ready_to_ship`** — which is in #4's re-select set (`index.ts:881`).
- Next hour, #4 re-cancels and re-fires `ss.cancelOrder` on the same shipment whose SS order is
  already `shipped` → logs the spam again.
- **#4 discards `cancelOrder`'s `{alreadyInState}` return** (`:907`), so it can never branch on
  "SS says shipped → record shipped & stop." There is no per-shipment terminal guard on #4's
  cascade SELECT.

**Amplifier:** orders carrying ≥2 active shipment rows (from 2A) — one ships, the sibling is
re-cancel-attempted every sweep.
**Fix:** (a) #4 reads `{alreadyInState}` and routes shipped SS orders through the shipped rollup
instead of forcing cancelled; (b) make `cancelled` terminal/non-re-derivable in the rollup;
(c) add a terminal/`last_reconciled_at` guard to #4's cascade SELECT.

> **Note (P0 financial):** #4 currently force-sets `outbound_shipments.status='cancelled'` even
> when the SS order actually **shipped** (`index.ts:907-911`) — a shipped order marked cancelled
> in WMS, tracking lost. Same defect, financial face.

---

## 3. Consolidated defect register (deduped across stages)

### P0 — order loss / double-ship / wrong qty / inventory or financial loss / durable stuck

| ID | Defect | Evidence | Fix direction |
|----|--------|----------|---------------|
| D-DUP | No unique constraint on `outbound_shipments(order_id)`; 8 inconsistent INSERT paths; per-shipment orderKey | `migrations/060`,`086` (absent); `shipstation.service.ts:3115`; §2A | Partial unique index + advisory lock + single creator |
| D-SHOPFUL | Shopify external-fulfillment Path B inserts `shipped` row ignoring existing active shipment | `shopify.routes.ts:255-302`,`480-514` | Transition existing shipment via `markShipmentShipped`, don't insert |
| D-PENDING | `FulfillmentService.createShipment` writes invalid enum `"pending"`, no dedup | `fulfillment.service.ts:106-118` | Map to `planned`+dedup, or delete if dead |
| D-FORCECXL | #4 reconcile force-cancels WMS shipment whose SS order shipped (discards `alreadyInState`) | `index.ts:907-911`; `shipstation.service.ts:2840` | Branch on `alreadyInState`→ship rollup |
| D-SPAM | Cancel↔ready_to_ship oscillation re-fires `ss.cancelOrder` forever | `index.ts:858-928`,`881`; `order-status.ts:171-191` | §2B fix |
| D-PICKGUARD | `pickItem` deducts inventory without re-checking parent cancel/hold under lock (S4-F1) | `picking.use-cases.ts:949-1020` (no order-state read) | `SELECT … FOR UPDATE` order; reject cancelled/held/shipped |
| D-GETWRITE | `GET /api/picking/queue` mutates order/item/shipment state + `completed_at=NOW()` (S4-F3) | `orders.storage.ts:554-619`; `picking.routes.ts:100` | Move self-heal to a background job; keep GET pure |
| D-LEDGER | Deduct failure leaves item `completed` with no ledger row (S4-F6) | `picking.use-cases.ts:1009-1013`,`1256-1288` | Roll back item completion on deduct failure |
| D-CXLPARTIAL | Shopify cancel cascade non-transactional; idempotency guard on `oms_orders.status` skips shipment cascade on retry (S1-F2) | `oms-webhooks.ts:1690-1817`,`:1698` | One tx; guard on a cascade-complete signal |
| D-REFUNDORDER | Refund SS side-effects (`ss.cancelOrder`) + WMS writes run BEFORE idempotency check (S1-F5) | `oms-webhooks.ts:675` before `:685` | Move `wms.returns` dedup to top of cascade |
| D-DUPFUL | Shopify/eBay fulfillment write-back: no idempotency key, no lock → duplicate fulfillment on crash-then-retry (S5-S7) | `fulfillment-push.service.ts:1297→1327`,`:743→752` | Deterministic idempotency key / in-flight marker in one tx |
| D-LOSTNOTIFY | Lost SHIP_NOTIFY strands `picked_qty`; no reconciler replays `recordShipment` (S5-S9) | grep: only SHIP_NOTIFY + manual call `recordShipment` | Sweep shipped-shipments-with-no-ship-ledger; replay (guard is idempotent) |
| D-RESTOCK | Cancel/refund never returns picked units to on-hand (no `unpick` call) (S1-F3) | `inventory.use-cases.ts:535` (reserve-only); no `unpick` refs in cancel paths | Branch on item state: picked→`unpick`; shipped→returns flow |

### P1 — significant operational risk / silent drift / frequent manual intervention

| ID | Defect | Evidence |
|----|--------|----------|
| D-NOTX-SYNC | OMS→WMS shipment/reservation/push post-commit best-effort → order `ready` with no shipment/reservation (S3-W2) | `wms-sync.service.ts:456-537` |
| D-NOTX-NOTIFY | SHIP_NOTIFY cascade has no tx; inventory recorded after OMS marked shipped → split-brain (S5-S1) | `shipstation.service.ts:1920-2025` |
| D-NOTX-INGEST | `ingestOrder` order+lines+events not atomic → committed header with no lines (S1-F12/P0-1) | `oms.service.ts:118-289` |
| D-ZOMBIE | `updateOrderProgress` has no transition for mixed-cancelled lines; only a GET self-heal covers `ready`/`in_progress` | `orders.storage.ts:984-1007`,`570-590` |
| D-SHORTRES | Short-pick never releases reservation for un-picked qty → ATP suppressed | `picking.use-cases.ts:1079-1129`; `inventory.use-cases.ts:151` |
| D-SHORTREPLEN | Short-pick replen fire-and-forget; silent `null`; no durable blocker | `picking.use-cases.ts:1079-1129`,`1375-1409` |
| D-SYNCSTATUS | `syncFulfilledStatusesFromShopify` writes non-existent `orders.status` column | `orders.storage.ts:1232` vs `orders.schema.ts:113` |
| D-VOIDSTRAND | Voided shipments never re-pushed; voided sibling pins order at `partially_shipped` (S5-S2/S5-S6) | `shipment-rollup.ts:908`; `order-status.ts:97` |
| D-DUPEVENT | `recordShipmentEventV2` unguarded INSERT → duplicate `oms_order_events` on rollup-changing replay | `shipstation.service.ts:2163`,`:1985` |
| D-RESERVEGATE | Reservation gated on `ready` (paid only); unpaid order gets shipment+push but no reservation | `wms-sync.service.ts:477`; `:553` |
| D-SHORTFALL | Stock shortfall doesn't hold/backorder; pickers routed to empty stock (S3-W8) | `wms-sync.service.ts:477-486`; `reservation.service.ts:201` |
| D-RESVSKU | Reservation resolves variant by SKU, diverging from `productVariantId` on the WMS item | `reservation.service.ts:241` vs `wms-sync.service.ts:307` |
| D-EDITATOMIC | Edit propagation release-then-reserve not atomic; transient full un-reserve (S3-W5) | `wms-sync.service.ts:1201-1205` |
| D-EBAYCXL | eBay cancel raw-writes `wms.orders`, never releases reservation; refund no cascade (S2-E2/3/4) | `ebay-order-ingestion.ts:258-289` |
| D-CHANNELDIV | Bridge vs webhook channel divergence can create duplicate `oms_orders` (S1-F9) | `shopify-bridge.ts:54-63` vs `oms-webhooks.ts:1208` |
| D-200LOSS | Empty/garbled webhook body ACKed 200 → silent order loss | `oms-webhooks.ts:1038-1041` |
| D-PUSHFLAG | Push validation failure throws without stamping `requires_review`; retry loops | `shipstation.service.ts:2914-3236`; `webhook-retry.worker.ts:875` |
| D-NOMATCH | No-match SHIP_NOTIFY silently dropped, no alert | `shipstation.service.ts:2188-2190` |
| D-FANOUT | Combined-order fulfillment fan-out has no cross-child atomicity | `fulfillment-push.service.ts:789-792` |
| D-STALECLEAN | `cancelStaleShipmentsIfFullyCovered` only on V2 shipped path, not legacy/reconcilers; ignores voided | `shipstation.service.ts:1945-1950`; `shipment-rollup.ts:908` |
| D-PINGPONG | #4 (OMS→WMS) vs #13 `WMS_FINAL_OMS_OPEN` (WMS→OMS) can ping-pong status | `index.ts:881`; `oms-flow-reconciliation.service.ts:1001`,`1070` |
| D-RECREATE | #13 `WMS_READY_WITHOUT_SHIPMENT` can re-create a shipment #6 cancelled | `oms-flow-reconciliation.service.ts:839-905` |
| D-EBAYAUTH | eBay POST notifications have no signature verification | `ebay-order-ingestion.ts:386-491` |

### P2 — occasional issues / scaling / observability / standards

| ID | Defect | Evidence |
|----|--------|----------|
| D-NOSM | No central guarded transition fn; 12+ direct writers; illegal transitions possible | `orders.storage.ts` (table in Stage 3) |
| D-BOOTREPAIR | "One-time" startup repairs re-run every boot; re-issue SS cancels, no lock | `index.ts:937`,`1007`,`1063` |
| D-CLOCK | Non-injected `new Date()`/`NOW()` re-stamps `completed_at`, sort_rank/SLA; non-deterministic | `orders.storage.ts:555`,`579`,`861`; `wms-sync.service.ts:228`,`231` |
| D-FLOAT | `parseFloat(...)*100` on money in channel mappers | `oms-webhooks.ts:125`; `ebay-order-ingestion.ts:72` |
| D-ENUMDRIFT | `partially_shipped`/`cancelled` written but absent from TS enums; loose `varchar` | `orders.schema.ts:17`,`33`; shipment `status` typed `varchar` `:423` |
| D-BOUNDARY | Cross-system raw joins/writes: `channels.partner_profiles`, `membership.*`, raw `wms.*` from OMS | `wms-sync.service.ts:217`,`1301`; `oms-webhooks.ts` cancel/refund |
| D-DROPCONFLICT | Dropship acceptance writes `inventory_levels.reserved_qty` directly, reimplements reservation (S2-E1) | `dropship-order-acceptance.repository.ts:865` |
| D-FULLQTY | `applyShipmentQuantitiesToWmsOrderItems` additive, unguarded (bounded by LEAST) | `shipstation.service.ts:1495-1509` |
| D-QGUARD | `recordShipment` dedup needs both `shipmentId`+`orderItemId`; no DB unique to enforce | `inventory.use-cases.ts:279` |
| D-NOENGINE | No `ShippingEngine` interface; ShipStation hardcoded throughout (S5-S3) | `shipstation.service.ts:628-3225` |

### Already fixed since 2026-05-28 audit (verified this pass)
- **S3-W1** reservation no-op → now calls `reserveOrder(wmsOrderId)` correctly; regression test
  exists (`wms-sync-reservation-method.test.ts`).
- **S4-F2** `resolveException` wrong column → now writes correct exception columns.

---

## 4. Scheduled-job inventory + conflict matrix (Stage 6)

~19 jobs. The ones that mutate order/shipment/SS state and can fight:

| # | Job | Schedule | Mutates | Lock |
|---|-----|----------|---------|------|
| 4 | OMS↔WMS reconcile | 15s→1h | `warehouse_status`, `ss.cancelOrder`, shipments | **none** |
| 5 | Data repair (orphan/zombie) | 12s/boot | items, shipments, `warehouse_status` | none |
| 6 | Duplicate-shipment cleanup | 15s/boot | shipments→cancelled, `ss.cancelOrder` | none |
| 8 | ShipStation reconcile V2 | 30s→10m | rollup helpers, `ss.markAsShipped/cancelOrder` | freshness only |
| 9 | ShipStation reconcile V1 | 30s→10m | `ss.markAsShipped/cancelOrder` | flag only |
| 10 | SS queue sweeper | 10m | SS createorder→cancelled, shipments | DB finality |
| 13 | OMS flow reconciliation | 20s→15m | `warehouse_status`, `oms_orders.status`, push retries | **adv lock 918405** |
| 16 | Sync recovery | 30s→15m | `ss.pushShipment` (creates SS orders) | none |

**Key conflicts:** C1 (#4 vs rollup oscillation → spam, §2B); #4 vs #13 (opposite directions →
ping-pong); #16/#13 can re-create/re-push a shipment another job cancelled during the durable
partial-cancel window (D-CXLPARTIAL). Only #11-14 hold advisory locks; the rest race.

---

## 5. Test baseline (2026-05-30)

`npx vitest run unit`: **1723 passing, 3 failing, 14 skipped** (187 files).
- 3 failures all in `server/modules/wms/__tests__/unit/link-child-to-parent.test.ts`
  (execute-call-count assertions: "expected 6 to be 4", and a downstream `undefined.values`).
  Pre-existing per prior session (confirmed by stash earlier); located in the
  shipment-creation area touched by this work — **must be triaged as part of the shipment-creator
  consolidation**, not patched in isolation.
- Integration tests require a docker Postgres (`docker-compose.test.yml`) — not run this pass.

---

## 6. Remediation plan — canonical cores, no divergent flows

### 6.0 Governing principle (the antidote to §0)

Every recurring bug comes from the **same concern being reimplemented in more than one place**
(8 shipment creators, 12+ status writers, 2 ingest cores, 2 reservation implementations, 3
divergent cancel paths, per-channel write-back). The fix is one principle applied everywhere,
straight from `BOUNDARIES.md` ("single entry point… never reimplemented"):

> **One owning interface ("core") per domain concern. Every entry point — channel adapters,
> reconcilers, UI routes, retry workers — calls that core. No concern is implemented twice.
> Channels/callers differ ONLY in a thin adapter that maps their payload to the core's input;
> they never fork the core's logic.**

This is ports-and-adapters: **thin adapters around fat, transactional, idempotent cores.** A
channel may *compose extra steps around* a core inside the same transaction (e.g. dropship's
wallet debit), but it must not reimplement what the core owns. "No divergent experience by
channel" = the order/reservation/shipment/transition/cancel logic is byte-identical regardless
of source; only payload-mapping and auth differ.

The eight cores below subsume the entire defect register. The plan is sequenced so each core
lands before the callers that depend on it, so nothing regresses.

| Core | Owns | Replaces (divergent today) | Callers become adapters |
|------|------|----------------------------|--------------------------|
| **C1 Ingest core** | atomic order+lines+events, one dedup key, validation, fires `order.ingested` | `ingestOrder` (non-tx) **and** dropship's bespoke order INSERTs | shopify-webhook, shopify-bridge, eBay poll/webhook, dropship |
| **C2 Reservation core** (tx-aware) | ATP-gated `reserveForOrder`, accepts a tx handle | dropship's raw `inventory_levels` reservation | C1, edit-propagation, dropship (in its own tx) |
| **C3 Shipment core** | one `createOrUpdateShipmentForOrder`, per-order uniqueness, one status filter, per-order SS idempotency | 8 INSERT paths | sync, reconcilers, Shopify external-fulfillment, SS split round-trip |
| **C4 Order-status core** | one guarded `transitionOrderStatus(from[],to)`, terminal states enforced, no read-path writes | 12+ scattered writers + reconciler status writes | pick, sync, rollup, all reconcilers, resolveException |
| **C5 Shipment-event applier** | one transactional inbound cascade (shipment→rollup→OMS→inventory→outbox), idempotent | V2 + legacy + per-channel SHIP_NOTIFY branches | SHIP_NOTIFY webhook, reconcilers, lost-notify replay |
| **C6 Inventory movement** | `inventoryCore` for reserve/pick/ship/unpick — the only writer of `inventory_levels` | dropship direct write; missing unpick on cancel | C2, picking, C5, cancel/refund cascade |
| **C7 Write-back core** | uniform idempotency-key + durable outbox for channel fulfillment/tracking | Shopify/eBay (no key) vs dropship (key) | shopify, eBay, dropship adapters |
| **C8 Cancel/refund core** | one transactional cascade (inventory reverse, shipment cascade, SS cancel, events), idempotency key at the top | Shopify cancel, eBay cancel, dropship (missing) | shopify, eBay, dropship adapters |

**Cross-cutting — Reconciler discipline:** the ~19 background jobs must call C3/C4/C5/C6 (never
raw SQL reimplementations), run under advisory locks, and be consolidated under one orchestrator.
This dissolves the conflict matrix (§4) and the cancel-spam oscillation by construction.

Each phase ships with tests (unit + integration where DB-touching) per CLAUDE.md §11.

---

### Phase 0 — Stop the live bleeding (hours; tactical, low blast radius)
Interim hotfixes that hold until C3/C4 land; do not build new divergent logic here.
1. **D-FORCECXL + D-SPAM:** in reconcile #4 (`index.ts:888-916`), read `cancelOrder`'s
   `{alreadyInState}`; when SS reports shipped, route through the shipped rollup and stamp the
   shipment terminal; add a terminal guard to the cascade SELECT. Make `cancelled` non-re-derivable
   in `deriveWmsFromShipments`.
2. **D-PENDING:** fix/remove `FulfillmentService.createShipment`'s invalid `"pending"` write.

### Phase 1 — C4 Order-status core + C3 Shipment core (kills duplicates, spam, zombies structurally)
3. **C4 (D-NOSM, D-ZOMBIE, D-GETWRITE, D-SYNCSTATUS, D-PINGPONG, D-FORCECXL, D-SPAM):** build
   `transitionOrderStatus(orderId, from[], to)` as one guarded UPDATE with a terminal-state matrix
   (`cancelled`/`shipped` terminal, non-re-derivable). Route **all** 12+ writers *and every
   reconciler* through it; move pick-queue self-heal out of the GET into a job; fix the
   `orders.status` column bug. The oscillation loop and the ping-pong die here.
4. **C3 (D-DUP, D-SHOPFUL, D-PENDING, D-VOIDSTRAND, D-STALECLEAN, D-RECREATE):** one
   `createOrUpdateShipmentForOrder`; partial unique index `outbound_shipments(order_id) WHERE
   status NOT IN (terminal)`; order-keyed `pg_advisory_xact_lock` around probe+insert; one status
   filter (voided handled explicitly); **per-order** (not per-shipment) SS idempotency or a
   documented split model. Converge all 8 INSERT paths (incl. Shopify external-fulfillment Path B
   → transition, not insert) onto it. Run stale-cleanup via C4 in reconcilers too.
5. Re-triage the 3 `link-child-to-parent` test failures against the consolidated C3 creator.

### Phase 2 — C2 Reservation core (tx-aware) + C1 Ingest core (one path for all channels)
6. **C2 (D-DROPCONFLICT/S2-E1, D-RESVSKU, D-RESERVEGATE, D-SHORTFALL, D-EDITATOMIC):** make
   `reserveForOrder` accept an external transaction/connection handle and reserve by
   `productId/variantId` (not SKU). On shortfall, set a queryable backorder/hold sub-state instead
   of silent `ready`. This is the prerequisite for C1 + dropship convergence.
7. **C1 (D-NOTX-INGEST, D-CHANNELDIV, D-200LOSS, D-EBAYAUTH, D-FLOAT, partially D-DROPCONFLICT):**
   one transactional `ingestOrder` core (order+lines+events atomic, one dedup-key strategy,
   validation against one canonical schema, calls C2, emits `order.ingested`). Reduce **every**
   channel — Shopify webhook, Shopify bridge, eBay poll/webhook, **and dropship** — to a thin
   adapter (payload map + auth + dedup key) over this core. Dropship's wallet/economics compose
   *around* C1 inside the same tx; it stops re-INSERTing orders and stops reserving directly.
7a. **D-NOTX-SYNC (the OMS→WMS seam):** with C2 tx-aware and C3 in place, the sync orchestration
    composes order+items (C4-backed) + reservation (C2) + shipment (C3) in **one transaction**;
    the SS push moves to the C7 outbox. No more `ready` orders with no shipment/reservation.

### Phase 3 — C5 Shipment-event applier + C6 Inventory truth on unhappy paths
8. **C5 (D-NOTX-NOTIFY, D-DUPEVENT, D-NOMATCH, D-FULLQTY, D-LOSTNOTIFY):** one transactional
   inbound applier for V2/legacy/all channels; WMS-side writes in one tx, external pushes via the
   C7 outbox; unique constraint on ship events; alert on no-match; reconciler that **replays the
   same applier** for shipped-but-unrecorded shipments (idempotent guard already exists).
9. **C6 (D-RESTOCK, D-LEDGER, D-SHORTRES, D-SHORTREPLEN, D-PICKGUARD):** all `inventory_levels`
   movement through `inventoryCore` only; `pickItem` re-checks order state under lock and rolls
   back item completion on deduct failure; release reservation on short with a durable blocker.
   **D-QGUARD:** add a DB unique constraint on `inventory_transactions(transaction_type,
   reference_id, order_item_id)` for ship rows so the idempotency guard cannot be bypassed.
   (Cancel/refund `unpick` lands with C8.)

### Phase 4 — C8 Cancel/refund core + C7 Write-back core (channel parity)
10. **C8 (D-CXLPARTIAL, D-REFUNDORDER, D-EBAYCXL, D-RESTOCK):** one transactional cancel/refund
    cascade — idempotency key at the *top*, inventory reverse via C6 (`unpick` picked units,
    release reservation), shipment cascade via C3, SS cancel, events. Shopify/eBay/dropship become
    adapters; the durable partial-cancel window closes (guard on a cascade-complete signal, not
    `oms_orders.status`).
11. **C7 (D-DUPFUL, D-DUPEVENT, D-FANOUT):** one write-back core with a uniform idempotency-key +
    durable outbox contract (dropship is the model); Shopify/eBay adapters send keys; per-child
    atomicity for combined-order fan-out.

### Phase 5 — Reconciler consolidation onto the cores
12. **Conflict matrix (D-BOOTREPAIR, D-PINGPONG, D-SPAM residue):** consolidate the ~19 jobs under
    one orchestrator; each calls C3/C4/C5/C6 (no raw SQL), runs under an advisory lock, and writes
    a `last_reconciled_at`. Startup "one-time" repairs become locked, idempotent jobs. With C4's
    terminal states and C3's uniqueness, the reconcilers can no longer fight or re-create.

### Phase 6 — Determinism, boundaries, observability (P2)
13. Inject one clock through SLA/sort_rank/completed_at (**D-CLOCK**); integer money parser at all
    adapters (D-FLOAT); enum/CHECK constraints (D-ENUMDRIFT); remove cross-boundary raw joins
    (D-BOUNDARY); `ShippingEngine` port (D-NOENGINE); alerts on push-fail/dropped-webhook
    (D-PUSHFLAG).

---

## 7. Open questions — verify against prod before acting

1. `RECONCILE_V2` value in prod (decides #8 vs #9 active).
2. Census: `SELECT order_id, count(*) FROM wms.outbound_shipments WHERE status NOT IN
   ('voided','cancelled','shipped','returned','lost') GROUP BY 1 HAVING count(*)>1;`
3. Spam sources: orders where `oms_orders.status='cancelled'` AND
   `wms.orders.warehouse_status IN ('ready_to_ship','partially_shipped')` AND a child shipment's
   SS `orderStatus='shipped'`.
4. `oms_orders` sharing `external_order_id` across differing `channel_id` (D-CHANNELDIV incidence).
5. `oms_orders` with zero `oms_order_lines` (D-NOTX-INGEST incidence).
6. `inventory_transactions` for picked-then-cancelled/refunded orders (quantify D-RESTOCK loss).

---

*Grounded in code on branch `claude/fix-order-release-error-sHWUf` as of 2026-05-30. Citations
are `file:line`; verify before acting. Stage traces produced in parallel and cross-checked; the
2026-05-28 audit's S3-W1 and S4-F2 are confirmed fixed, the rest stand or are superseded above.*
