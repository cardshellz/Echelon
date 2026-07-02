# 12 — Documentation Reconciliation Audit (Echelon)

**Auditor:** docs-reconciliation subagent · **Date:** 2026-07-02 · **Mode:** READ-ONLY
**Scope:** ~28 root design/audit markdown docs vs current code on `main` (HEAD `1fa0d303`).
Every status mark below was spot-checked against the cited file:line unless marked
[UNVERIFIABLE]. Marks: **[FIXED]** / **[STILL OPEN]** / **[PARTIALLY DONE]** / **[UNVERIFIABLE]** /
**[BY DESIGN]** (deliberately resolved as won't-fix with documented rationale).

---

## 1. DOCUMENTED TARGET ARCHITECTURE (synthesis)

The docs converge (with contradictions noted below) on this target:

**Systems & sole-writer ownership** (`BOUNDARIES.md` 2026-05-30, §0.1 of `ORDER_TO_SHIP_DEEP_REVIEW`):
- **OMS owns the ORDER** (`oms.oms_orders/_lines/_events`): lifecycle, cancel, financial status,
  channel write-back. Never touches `inventory_levels`, never knows bins.
- **WMS owns FULFILLMENT**: `wms.orders.warehouse_status`, `wms.order_items`,
  `wms.outbound_shipments(+items)`, all of `inventory.*`. All inventory mutation through
  `inventoryCore` only; all reservation through `reserveForOrder()` only ("no raw SQL, no
  reimplementation"). Never `allowNegative: true`.
- **Shipping engine EXECUTES but owns no truth** — truth is `wms.outbound_shipments`; engine
  is commanded through the `ShippingEngine` port (C9); no vendor identifier
  (`shipstation_order_id`) may leak past the adapter into domain SQL.
- **Channel Sync** owns `channels.*`, reads ATP, pushes to Shopify/eBay, never writes inventory.
- **Catalog** owns products/variants; **Procurement** owns POs/receiving/AP and hands off to WMS
  via `inventoryCore.receiveInventory()`.
- **Two boundary patterns** and only two: external/replaceable → **port + adapter** with a
  canonical vocabulary (shipping engine, sales channels); internal/owned → **published module
  interface, one owner per table, NO swappable-adapter machinery** (OMS, WMS, Catalog,
  Procurement).

**Canonical cores** (`ORDER_TO_SHIP_DEEP_REVIEW` §6 — the master remediation frame): nine cores
C1–C9 — transactional ingest (C1), tx-aware reservation (C2), single shipment creator with
per-order uniqueness (C3), one guarded `transitionOrderStatus` with terminal states (C4), one
transactional inbound shipment-event applier (C5), inventoryCore as the only `inventory_levels`
writer incl. unpick (C6), idempotency-keyed write-back outbox (C7), one transactional
cancel/refund cascade (C8), engine port (C9). Reconcilers (~19 jobs) must call cores under
advisory locks. Cross-cutting error contract E1–E7: structured `{code, message, context}` errors
classified transient/permanent/fatal, correlation context on every log line, one JSON logger,
append-only audit, dead-letter + `requires_review` surfacing.

**Shipment state machine** (`SHIPMENT-STATE-MACHINE-DESIGN`, 2026-06-19): lifecycle status is
engine-owned physical truth (`planned → queued → labeled → shipped → delivered` + terminal
`cancelled/voided/returned/lost`), forward-only; **hold is an orthogonal `held` flag**, not a
status; cancel is pre-ship only and WMS-intent-owned; post-ship "cancel" is a refund; order
`warehouse_status` is always **derived** from shipments. Identity migrates from engine *order* id
to engine *shipment* (label) id; a single push gate at pick-ready replaces the pre-pick push.

**Inventory trust bar** (`WMS-INVENTORY-REFACTOR` §0): ledger replay reconciles to
`inventory_levels` at zero variance; every write goes through one guarded, ledgered primitive;
invariants enforced by the DB (unique (variant,location), qty≥0, reserved≤on-hand, dedup
unique indexes for ship/reserve/receipt); integer-cents money everywhere.

**Refund vs return** (`REFUND_RESTOCK_DESIGN`): a refund is financial + a channel restock
*intent*; a return is a physical lifecycle (`expected → partially_received → received → closed`
in `wms.returns`/`wms.return_items`); on-hand only ever increases at physical receipt via
`ReturnsService.processReturn` — never from a webhook.

**Engine-cancel divergence** (`ENGINE-CANCEL-DIVERGENCE-DESIGN`): an engine-side cancel of a
*live* order is a discrepancy → flag `requires_review`, never silently cancel or re-push;
`createorder` upserts must never resurrect a cancelled SS order.

**Schema namespacing** (`schema-map.md`, `artifact-exhaustive-map.md`): all `public.*` tables move
to domain schemas (`channels`, `inventory`, `oms`, `wms`, `procurement`, `warehouse`, `identity`,
`ebay`, `notifications`). **DB role separation** (`DB-ROLE-SEPARATION-RUNBOOK`): membership.* and
shellz public tables owned by a separate `shellz_club` Postgres credential; Echelon gets DML-only;
no cross-app DDL possible at the permission layer.

### Where docs contradict each other
1. **`WMS_ARCHITECTURE.md` describes a fictional flow.** Wave/batch planning, Batch IDs, "Hard
   Reserved (Locked to Batch)", totes, pack-station scan-to-box — none of this exists.
   `WMS-AUDIT-REPORT` §5 ("no batch picking — single_order mode only") and
   `WMS-INVENTORY-REFACTOR` L2 ("`packedQty` has **no live writers** — the pick→pack→ship machine
   is effectively pick→ship") directly contradict it. It reads as current-state but is aspiration.
2. **Reservation single-entry rule vs dropship.** `BOUNDARIES.md` ("Every reservation goes through
   `reserveForOrder()` — no raw SQL, no reimplementation") vs
   `dropship-order-acceptance.repository.ts:867` which still does
   `SET reserved_qty = reserved_qty + $1` directly. `ORDER_TO_SHIP_AUDIT` S2-E1 called this a P0
   violation; `WMS-INVENTORY-REFACTOR` Phase 1 **withdrew** the finding (M4) on the grounds it is
   locked/transactional/ledgered — but the boundary-rule violation itself (two reservation
   implementations that can diverge on ATP) still stands in code. The docs disagree with each
   other and the stricter doc (BOUNDARIES) disagrees with the code.
3. **`SYSTEM.md` module map vs reality.** It documents `inventory/core.service.ts`,
   `replen.service.ts`, `picking.service.ts`, `oms/shipstation.service.ts` "push eBay orders" from
   OMS, and `ebay-channel.routes.ts` — the inventory module was rebuilt around
   `application/*.use-cases.ts`, the push is WMS-first (per `SHIPSTATION-WMS-REFACTOR`), and
   `ebay-channel.routes.ts` was split into `server/routes/ebay/*`. Its "Known Bugs" list is
   3 generations stale.
4. **`COGS-ENGINE-SPEC.md` header says "Status: SPEC — no code"** but the engine exists
   (`server/modules/inventory/cogs.service.ts`, `cost-resolver.ts`, `inventory_lots.po_line_id`
   at `shared/schema/inventory.schema.ts:572`, `order_line_costs`, lot-mills work in
   `WMS-INVENTORY-REFACTOR` §6). Implemented with drift from the spec (e.g. `cost_source` vs the
   spec'd `cost_status`).
5. **`ORDER_TO_SHIP_AUDIT_2026-05-28` vs `ORDER_TO_SHIP_DEEP_REVIEW_2026-05-30`**: the later doc
   explicitly supersedes the earlier and corrects it (e.g. `outbound_shipments` ownership:
   "WMS writing shipments is correct and required" — reversing the earlier framing). Use only the
   05-30 doc + BOUNDARIES.md as the boundary source of truth.
6. **`DEPENDENCY-ENTANGLEMENT-AUDIT` Finding 12 vs `WMS-INVENTORY-REFACTOR` H1**: the former says
   reservation *should* fall back to any location with stock; the latter fixed the fallback to
   **fail loud** / exclude frozen bins. The refactor doc's decision is what shipped.

---

## 2. OPEN-ITEMS LEDGER

### 2.1 CLAUDE.md — post-soak TODO (HIGHEST PRIORITY per task)

| Item | Status | Evidence |
|---|---|---|
| Drop legacy `shipstation_order_id`/`shipstation_order_key` columns | **[STILL OPEN]** | Columns live: `shared/schema/oms.schema.ts:101-102`, `shared/schema/orders.schema.ts:454-455`. 223 references across server TS (`grep -c`), incl. non-test code in `shipstation.service.ts`, `wms-sync.service.ts`, `shipment-rollup.ts`, `create-shipment.ts`, `line-item-hold.ts`, `picking.routes.ts`, `webhook-retry.worker.ts`, `index.ts`. |
| Remove dual-writes in `pushOrder()`/`pushShipment()` | **[STILL OPEN]** | Dual-writes present: `shipstation.service.ts:1132-1133` (`SET shipstation_order_id = …, engine_order_ref = …`), `:1534-1535` (INSERT lists both legacy and engine columns), `:3828` (`engine_shipment_ref = ${orderKey}`). |
| Delete COALESCE fallbacks | **[STILL OPEN]** | 8 live COALESCE sites: `picking.routes.ts:41,84`; `webhook-retry.worker.ts:1130,1252`; `index.ts:937,1196,1529`; `routes/shopify.routes.ts:198` — all `COALESCE(engine_order_ref, shipstation_order_id::text)`. |

This is legitimate "post-soak" phasing, but note the soak has no documented exit criterion or
date; the shadow columns are ~1 month old and accreting new references (e.g. `line-item-hold.ts`,
added 2026-06, reads `shipstation_order_id`).

### 2.2 ULTRAREVIEW-echelon.md + ULTRAREVIEW-FIX-PLAN.md (2026-04-17)

Blockers:

| ID | Finding | Status | Evidence |
|---|---|---|---|
| B1 | Float money (`doublePrecision`) | **[FIXED]** | `grep doublePrecision shared/schema/*.ts` → 0 hits; migrations `0074_integer_money_cents`, `0576_align_money_columns_bigint`; live-DB verification recorded in WMS-INVENTORY-REFACTOR Phase 2 ☑; `shared/utils/money.ts` mills/cents layer. |
| B2 | Dev-secret fallbacks (session/vendor JWT) | **[FIXED]** | `server/index.ts:95-96` throws at boot if `SESSION_SECRET` missing. Old `dropship/vendor-auth.ts` deleted (dropship rebuilt); Stripe secrets now throw structured `DROPSHIP_STRIPE_*_NOT_CONFIGURED` errors (`dropship-stripe-funding.provider.ts:535-560`). |
| B3 | Stuck-order reconciler out of scope, throws every run | **[FIXED]** | Rewritten; scheduled eBay reconcile now calls the authed endpoint with `INTERNAL_API_KEY` (`index.ts:577,603`) and enqueues delayed retries (`index.ts:253`). |
| B4 | `/api/ebay/listings/reconcile` unauthenticated | **[FIXED]** | `server/routes/ebay/ebay-listings.routes.ts:1781` — `requireAuthOrInternalApiKey`. |
| B5 | Subscription admin routes unauthenticated | **[FIXED]** | `subscription.routes.ts:15` `adminMw = [requireAuth, requirePermission("shellz","admin")]`; all listed routes carry middleware. |
| B6 | Diagnostics destructive endpoints unauthenticated | **[FIXED]** | `routes/diagnostics.ts:10` — mounted under `/api/_internal/diagnostics` behind `requireInternalApiKey` (+ per-route `requireAuth`). |
| B7 | `Receiving.close()` not atomic; `GREATEST(0,…)` clamp | **[PARTIALLY DONE]** | Case-break bypass now ledgered via `inventoryCore.withTx(tx)` (WMS-INV C4 ☑); receipt idempotency unique index `uq_inventory_transactions_receipt_dedup` (migration 0578, H4 ☑) makes double-close safe. Whole-loop single-transaction close not verified; `close()` at `receiving.service.ts:440` still iterates lines. Residual risk is now bounded (idempotent per line) rather than double-counting. |
| B8 | Migration runner continues on failure; dup prefixes | **[FIXED]** | `migrations/run-migrations.ts:111` `process.exit(1) // Fail-fast for Heroku release phase`; duplicate-prefix scan of `migrations/*.sql` → none remain. |
| B9 | Error handler re-throws after respond | **[FIXED]** | `index.ts:697-703` — responds then `reportError(...)`; no `throw`. |
| B10 | Boot-time silent zeroing of negative inventory | **[FIXED]** | No `SET variant_qty = 0` remains in `index.ts`; DB `CHECK qty >= 0 NOT VALID` added (WMS-INV C2 ☑) so negatives are blocked, not laundered. |
| B11 | Read-modify-write on `inventory_levels` without locks | **[FIXED]** | `lockInventoryLevel` (FOR UPDATE) in `inventory/infrastructure/inventory.repository.ts`, used by `inventory.use-cases.ts` and dropship acceptance; pick path re-checks order under `FOR UPDATE` (`picking.use-cases.ts:954-957,980`). Reservation dedup unique index (0577). |
| B12 | Stripe webhook signature broken on all paths | **[FIXED]** | Rebuilt provider: `dropship-stripe-funding.provider.ts:255` `stripe.webhooks.constructEvent(input.rawBody, …)`; no "trust the payload" branch; secret required. |
| B13 | WebSocket unauth + client-asserted userId | **[FIXED]** | `server/websocket.ts:21-50` — manual `upgrade` handler runs the express-session middleware, rejects `401` without a session, binds `__userId` from `session.user.id` (not client input). |
| B14 | 8 unauth warehouse/locations routes | **[FIXED]** | `warehouse/locations.routes.ts:17-294` — every listed route now has `requirePermission("inventory","view"/"edit")`. |
| B15 | Stripe mock/empty secret fallbacks | **[FIXED]** | `grep sk_test_mock\|whsec_mock server/` → 0 hits; old `webhook.controller.ts` deleted with the dropship rebuild. |

High/Medium (spot-checked subset; P1 tier of the fix plan):

| ID | Finding | Status | Evidence |
|---|---|---|---|
| H1/H2 | Ingestion race / bridge-vs-webhook dup IDs | **[FIXED]** | `oms.service.ts:173` ingest inside `db.transaction`; `(channel_id, external_order_id)` unique + line-item recovery (BACKFILL-SUMMARY); GID→numeric normalization noted at `oms-webhooks.ts:923-934` (per 05-28 audit). |
| H3 | `received_qty > order_qty` accepted | **[STILL OPEN]** | No `over_receipt`/tolerance logic in `receiving.service.ts` (grep 0 hits). |
| H4 | No `(vendor_id, invoice_number)` unique | **[FIXED]** | `procurement.schema.ts:764` `uniqueIndex("vendor_invoices_vendor_invoice_idx").on(vendorId, invoiceNumber)`. |
| H5 | 3-way match doesn't block payment | **[STILL OPEN]** | `ap-ledger.service.ts` `recordPayment` (:879) has no `matchStatus` guard/override path (grep 0 hits in body). |
| H6/H7 | Landed-cost retro-mutation / FX | **[UNVERIFIABLE]** (not spot-checked this pass) | `shipment-tracking.service.ts` not re-read; treat as open for the main audit. |
| H8 | Webhooks swallow failures, ACK 200 | **[FIXED]** (mechanism) | `webhook-inbox.service.ts` + `webhook-retry.worker.ts` (durable inbox/retry/dead-letter); refund cascade idempotency marker in-tx (`oms-webhooks.ts:2247-2266`). |
| H9 | ShipStation push no retry | **[PARTIALLY DONE]** | Durable push retry queue exists (`enqueueShipStationShipmentPushRetry`, used at `wms-sync.service.ts:643,1121`); 429-specific budget not verified. |
| H12 | 4k-line route files w/ business logic | **[PARTIALLY DONE]** | `ebay-channel.routes.ts` (was 4,228 lines) split into `server/routes/ebay/*` (8 files); `inventory.routes.ts` still ~2,800 lines. |
| H15 | Allocation ignores `is_listed` | **[FIXED]** | `allocation-engine.service.ts:314-340` loads product+variant `isListed` overrides and blocks allocation. |
| H16 | ATP excludes backorder | **[BY DESIGN]** | WMS-INVENTORY-REFACTOR Phase 3 M8: backorder = expected inbound; including it risks overselling; documented decision. |
| H17 | Hard-coded ShipStation webhook URL | **[FIXED]** | `index.ts:660-671` — reads `SHIPSTATION_WEBHOOK_URL`, skips registration when unset. |
| H18 | Backfill on every boot | **[FIXED]** | No `backfillShopifyOrders` call remains in `index.ts`; backfill scripts live under `scripts/backfill*`. |
| H19 | No default-deny auth posture / CI auth-audit | **[STILL OPEN]** | No `auth-audit` module or route-allowlist check anywhere (grep 0 hits). Individual holes were patched, but "new route forgets requireAuth" is still undetectable. |
| H21 | Audit logger stdout-only | **[FIXED]** | `infrastructure/auditLogger.ts:33` persists to `audit_events` (fire-and-forget by deliberate comment). |
| H25 | 13 test files / no CI | **[FIXED]** | 259 `*.test.ts` files; deep review recorded 1,723 passing units; `.github/workflows/ci.yml` exists (Phase 0 item 0 of the deep-review plan). |
| H20 | Vendor JWT in localStorage | **[UNVERIFIABLE]** | Dropship portal rebuilt; client not re-audited this pass. |

### 2.3 WMS-AUDIT-REPORT.md (2026-03-20) — "Tomorrow's Fix List"

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | 3 negative `inventory_levels` rows + `recordShipment()` guard | **[FIXED]** | Root cause was cycle count `allowNegative:true` (NEGATIVE-INVENTORY-INVESTIGATION); cycle-count now "NEVER uses allowNegative" (`cycle-count.use-cases.ts:277,338,911`); DB `CHECK` blocks new negatives (WMS-INV C2 ☑); `recordShipment` negative guard confirmed in WMS-INV cross-audit; historical drift retired by the Phase-1 backfill (429 ledgered adjustments, zero variance 2026-06-01). |
| 2 | PO status `"partial"` vs `"partially_received"` | **[FIXED]** (code) / **[UNVERIFIABLE]** (PO-68 data) | Code uses `partially_received` consistently (`purchasing.service.ts:7,150,1748,1764`); the stuck row itself is a prod-data question. |
| 3 | 60k Shopify 404 sync errors (stale channel_feeds) | **[UNVERIFIABLE]** | Ops/data condition; no code artifact to check. Reconciliation-from-Shopify job (P1 #13 of DEP audit) not found → likely still open operationally. |
| 4 | 269 Shopify orders stuck `confirmed` | **[FIXED]** (mechanism) | `oms/reconcilers/shopify.reconciler.ts` + `oms-flow-reconciliation.service.ts` + fulfillments webhooks now derive OMS from WMS; `scripts/backfill-oms-status.ts` exists for the backlog. |
| 5 | `reserveInventory()` bypasses ATP/location | **[FIXED]** | `oms.service.ts:390-432` — idempotency event check, delegates to `reservationService` (errors loudly if unwired); reservation excludes frozen bins and dedups (WMS-INV Phase 3 ☑, migration 0577). |
| 6–9 | Draft-receipt cleanup, putaway UI, 422s, zones | **[UNVERIFIABLE]** / low | Ops/UX items; not code-checkable this pass. |

### 2.4 SHIPMENT-STATE-MACHINE-DESIGN.md (2026-06-19) — migration phases

| Phase | Promise | Status | Evidence |
|---|---|---|---|
| 1 — Hold is a flag | held boolean + backfill + retire `on_hold` status | **[FIXED]** | `orders.schema.ts:467-480` (`held`, `heldAt`, `onHoldReason`); comments record Phases 1a–1d done and `on_hold` retired from the app (:420-424); LINE-ITEM-HOLD doc confirms "Phases 1a-1d done". |
| 2 — Ownership / single applier | Only engine-event applier writes shipped/voided; collapse V2+legacy inbound paths | **[PARTIALLY DONE]** | `order-status-core.ts` (guarded transitions) + `reconcile-derive.ts` exist; but legacy `processShipNotify` (V1) still present at `shipstation.service.ts:2988` alongside V2 — two inbound paths remain. |
| 3 — Re-key identity to engine *shipment* id | `engine_shipment_ref` = real SS shipment id; match webhooks by shipment id; one row per label | **[STILL OPEN]** | `engine_shipment_ref` is still populated with the **orderKey**: `shipstation.service.ts:3828` (`engine_shipment_ref = ${orderKey}`); `shipping/adapters/shipstation.adapter.ts:16` documents `engineShipmentRef = orderKey ("echelon-wms-shp-123")`. Splits still use `external_fulfillment_id = shipstation_shipment:<id>` side-channel. |
| 4 — Single push gate (retire pre-pick push) | Push at pick-ready gate; retire #658 fenced fallback | **[STILL OPEN]** | `wms-sync.service.ts:612-629` still pushes to ShipStation at WMS-sync (step 8, pre-pick); the fenced ship-before-pick fallback is still live and self-labels "removable once pick-before-push is enforced" (`shipstation.service.ts:1592`, `inventory.use-cases.ts:354`). |

### 2.5 LINE-ITEM-HOLD-DESIGN.md (2026-06-20) — phases P1–P6

| Phase | Status | Evidence |
|---|---|---|
| P1 hold/release UI+backend, `orders:hold` gated | **[FIXED]** | `picking.routes.ts:490-534` (hold, `requirePermission("orders","hold")`, #679), `:562-611` (release). Writes `order_items.on_hold`+`hold_reason` + picking-log audit. |
| P2 held line into own `held=true` shipment, not pushed | **[FIXED]** | `server/modules/wms/line-item-hold.ts` `holdLineItemWithSplit` (atomic split, held shipment `planned/held=true`, source `line_item_hold`); pushShipment refuses held (single chokepoint per header comment); unit tests exist. |
| P3 release → push → own fulfillment | **[FIXED]** | `releaseLineItemFromHold` + `enqueueShipStationShipmentPushRetry(heldShipmentId, "LineItemReleasedPush")` (`picking.routes.ts:582-609`). |
| P4 held line doesn't reserve/consume on-hand (backorder accounting) | **[STILL OPEN]** | No reservation/backorder logic in `line-item-hold.ts` or hold route; held lines still reserve normally. |
| P5 held-line aging report / all-held exception view | **[STILL OPEN]** | No held-aging metric in `ops-health.service.ts` / `flow-waterfall.service.ts` (grep 0 hits). |
| P6 auto-detect/auto-release | **[STILL OPEN]** (explicitly deferred in doc) | — |

### 2.6 REFUND_RESTOCK_DESIGN.md (2026-06-08) — phasing §7

| Phase | Status | Evidence |
|---|---|---|
| 1 SQL fix so cascade runs (#608) | **[FIXED]** (per doc, marked done) | — |
| 2 Schema: `wms.return_items` + `returns.status` | **[FIXED]** | `orders.schema.ts:585` `returnItems` table; comment ":583 refund flagged restock_type=return opens rows here with status='expected'". |
| 3 Cascade branches on `restock_policy` | **[FIXED]** | `oms-webhooks.ts:956-968` — only `return/restock` lines open `wms.return_items` rows with `status='expected'` (incl. `location_id`); cancel/no_restock take no inventory action. |
| 4 Reconcile physical receipt to expected returns (`processReturn` handoff) | **[STILL OPEN]** | `return_items` has **no reader/writer outside the webhook**: only `oms-webhooks.ts` and `db.ts` reference it; `orders/returns.service.ts` has zero `return_items`/`received_qty` references — receipts don't advance `expected → received`. |
| 5 Durability (retry queue for the inventory leg) | **[PARTIALLY DONE]** | Generic webhook retry/dead-letter exists; a dedicated inventory-leg dead-letter wasn't verified. |
| Backlog: ~10 shipped `return` refunds (~34 units) + 5 "cancel-but-shipped" anomalies | **[UNVERIFIABLE]** | Prod-data disposition; no artifact. |

### 2.7 ENGINE-CANCEL-DIVERGENCE-DESIGN.md (2026-06-23)

| Phase | Status | Evidence |
|---|---|---|
| P1 — reconciler gate on order intent + createorder cancelled-guard | **[FIXED]** | `shipping/reconcile-derive.ts:26-74` (`orderIsCancelled` gate; live order → `{kind:"review", reason:"engine_cancelled_order_active"}`); guards in `shipstation.service.ts:3275-3277` (sort-rank sync: "never let it resurrect a cancelled order") and `:3487-3495` (pushShipment refuses cancelled SS order). Merged as PR #687 (`473d95dc`). |
| P2 — operator "clear review + push" override | **[STILL OPEN]** | `POST /api/oms/orders/:id/push-to-shipstation` (`oms.routes.ts:318-`) does **not** clear `requires_review`; the only `requires_review=false` writer is a narrow self-heal for `inventory_deduction_missing_item_data` (`shipstation.service.ts:1666-1671`). A shipment flagged `engine_cancelled_order_active` has no one-step operator resolution. |
| Edge: flag auto-clears when channel cancel later arrives | **[UNVERIFIABLE]** | Not traced this pass. |

### 2.8 DB-ROLE-SEPARATION-RUNBOOK.md (post 2026-06-11 incident)

| Phase | Status | Evidence |
|---|---|---|
| 1 — Strip Echelon's membership.* DDL from startup | **[FIXED]** | `server/db.ts:944-953` — "Migration 052 REMOVED (Path A — no cross-schema DDL at startup) … NEVER reintroduce membership.* DDL". |
| 2–4 — create `shellz_club` credential, transfer ownership, attach, verify | **[UNVERIFIABLE]** | Heroku-side ops; no repo artifact can prove the flip happened. Must be verified with `heroku pg:psql` probes (runbook Phase 4). |
| Hardening: `RUN_DRIZZLE_PUSH_ON_RELEASE` off | **[FIXED]** (default) | `scripts/release.sh:11` — push only when env var explicitly `true`; SQL migrations (fail-fast) always run first. The `--force` push path remains a footgun if the var is ever set. |
| Hardening: `tablesFilter` in Echelon drizzle.config.ts | **[STILL OPEN]** | `drizzle.config.ts` has no `tablesFilter` (grep 0 hits) — an enabled release push would still consider all schemas. |
| Note: `runStartupMigrations` still runs ~149 DDL statements on every boot (`db.ts:46`, count via grep) — the ER4 "migrations shouldn't race app boot" concern remains open. |

### 2.9 Fulfillment ledger — `wms.line_fulfillments`

| Phase (per migration 103 header) | Status | Evidence |
|---|---|---|
| Phase 0 — inert append-only per-line ledger + per-line hold columns | **[FIXED]** | `migrations/103_line_fulfillments_ledger.sql` (+ reverse migration); mirrored in `shared/schema/orders.schema.ts` and `server/db.ts` startup fallback. |
| Phase 1 — backfill (`scripts/backfill-line-fulfillments.ts`) | **[STILL OPEN]** | Script does not exist (`ls scripts/` — no match). |
| Phase 2 — dual-write | **[STILL OPEN]** | Zero application writers/readers: only `server/db.ts` (DDL mirror) and the schema file reference the table. |
| **Governing design doc `FULFILLMENT_STATE_DESIGN.md` (§2.1, §7 cited by the migration) is MISSING from the repo** | **[STILL OPEN]** (doc gap) | `find` across repo → not found. The single source of truth for this redesign is unrecoverable from the codebase. |

### 2.10 ORDER_TO_SHIP_DEEP_REVIEW_2026-05-30.md — cores & defect register (deduped)

| Item | Status | Evidence |
|---|---|---|
| Phase 0.0 CI gate | **[FIXED]** | `.github/workflows/ci.yml` exists. |
| Phase 0 D-FORCECXL / D-SPAM (cancel oscillation) | **[FIXED]** | `index.ts:948,1273,1553` branch on `cancelResult?.alreadyInState`; terminal handling per Phase-1 regression tests (`phase1-regression.test.ts`). |
| Phase 0 2b observability foundation (E1/E3/E4) | **[FIXED]** (foundation) | `server/platform/observability/{log-context,logger,errors,report-error}.ts`; global handler uses `reportError` (`index.ts:697+`). The mass `console.*` rewrite is explicitly incremental — hot paths still use `console.warn` (e.g. `picking.routes.ts:534`). |
| C9 ShippingEngine port | **[FIXED]** | `server/modules/shipping/engine.ts` + `adapters/shipstation.adapter.ts`; CLAUDE.md records "C9 complete"; engine-agnostic columns exist (`orders.schema.ts:447-449`). Legacy-shadow retirement still open (§2.1). |
| C4 order-status core (D-NOSM, D-GETWRITE, D-SYNCSTATUS) | **[FIXED]** | `orders/order-status-core.ts`; `getPickQueueOrders` is now a pure SELECT (`orders.storage.ts:389-`), self-heal moved to schedulers. |
| C3 shipment core (D-DUP, D-SHOPFUL, D-PENDING) | **[FIXED]** | `wms/create-shipment.ts` single creator w/ advisory lock (per LINE-ITEM-HOLD verification table); partial unique index `uq_outbound_shipments_active_per_order` (migrations 0568/0569); external-fulfillment dedup (0579). |
| C1 transactional ingest (D-NOTX-INGEST) | **[FIXED]** | `oms.service.ts:173` order+lines+event in one `db.transaction`. |
| C2 reservation idempotency (S3-W1, M1/M2) | **[FIXED]** | `reserveOrder(wmsOrderId)` called with correct signature (`wms-sync.service.ts:180,572,1447`); reserve dedup unique index (0577); regression test `wms-sync-reservation-method.test.ts` (per doc). |
| C5 single inbound applier (D-NOTX-NOTIFY, D-DUPEVENT) | **[PARTIALLY DONE]** | Reconcile-derive + rollup consolidation exist; V1 `processShipNotify` retained (`shipstation.service.ts:2988`); latest commit `1fa0d303` still hardening SHIP_NOTIFY idempotency (work in-flight). |
| C6 D-PICKGUARD (pick re-checks order state) | **[FIXED]** | `picking.use-cases.ts:954-957` `SELECT warehouse_status, on_hold … FOR UPDATE` in the pick tx. |
| C6 D-RESTOCK (cancel/refund returns picked units) | **[PARTIALLY DONE]** | Refund side re-designed as expected-returns (no phantom restock — correct per REFUND_RESTOCK). But the physical receipt handoff is unbuilt (§2.6 Phase 4), and cancel-path `unpick` of picked-not-shipped units was not located. |
| C7 write-back idempotency (D-DUPFUL) | **[PARTIALLY DONE]** | Dropship tracking push has idempotency keys (`fulfillment-push.service.ts:268,421`); a Shopify `fulfillmentCreateV2` idempotency key/intent-marker was not found. |
| C8 cancel/refund core (D-CXLPARTIAL, D-REFUNDORDER) | **[PARTIALLY DONE]** | "Full order cancellation cascade — single path used by orders/cancelled" (`oms-webhooks.ts:339`); refund financial update + idempotency marker commit in one tx keyed by Shopify refund id (`oms-webhooks.ts:2247-2266` — also fixes S1-F6 cumulative-status). eBay cancel/refund parity not re-verified. |
| D-SHORTFALL / S3-W8 (shortfall → hold/backorder) | **[STILL OPEN]** | `reservation.service.ts:112-122` still returns `{reserved, shortfall}`; no `inventory_shortfall` hold or backorder writer in `wms-sync.service.ts` (grep 0 hits). Pickers can still be routed to empty bins. |
| D-LOSTNOTIFY (picked_qty reconciler) | **[PARTIALLY DONE]** | `alerts.service.ts:87` detects orphaned picked stock (alert); replay is manual (`server/scripts/fix_orphaned_picks.ts`), not an automated sweep through the applier. |
| D-NOCORRELATION / D-LOGSTRUCT | **[PARTIALLY DONE]** | ALS context + JSON logger shipped (platform/observability); adoption incremental — raw `console.*` still widespread. |
| Reconciler consolidation under one orchestrator (Phase 5) | **[PARTIALLY DONE]** | `infrastructure/scheduler-lock.ts` + `scheduler-config.ts` exist; reconcilers moved to `oms/reconcilers/*`; but many jobs still live in `index.ts` and full consolidation isn't evident. |

### 2.11 WMS-INVENTORY-REFACTOR.md (self-tracking; trust arc)

Doc is **self-consistent with code** (the most current doc in the repo). Verified samples:
C1/C2 constraints, C5 `voided_at` soft-delete, C7 `logTransaction`, dedup indexes
0570/0577/0578/0579 — all present.

| Item | Status | Evidence |
|---|---|---|
| Phases 0–6 + cross-system hardening | **[FIXED]** (☑ in doc, spot-checks pass) | See §2.2 B1/B10/B11 rows; case-break COGS per-unit fix; shipment idempotency index 0579. |
| C6 bucket-delta ledger (reserved/picked/packed replay) | **[STILL OPEN]** (explicitly deferred) | Doc: "tracked as its own unit of work"; no bucket-delta columns exist. |
| Phase 7 operational visibility | **[PARTIALLY DONE]** | Doc says ☐, but OMS-side Flow Monitor / ops-health / ops-alert webhook shipped (`flow-waterfall.service.ts`, `ops-health.service.ts`, `oms-ops-alert.service.ts`). WMS-side replen/sync dashboards not found. |
| Phase 8 exception management / Phase 9 ops intelligence | **[STILL OPEN]** | ☐ in doc; no exception-queue workflow tables found. |
| H3 `shortPickAction` dead config | **[STILL OPEN]** (acknowledged: enforcement deferred to Phase 7+) | — |
| Lot arc L0 (lot reconciler) | **[FIXED]** | `inventory/reconcile/lot-onhand-replay.ts` + `ledger-replay.ts`. |
| Lot arc L0.5 — remediate **232 drifted cells / 6,382 units** lot↔level | **[STILL OPEN]** | Baseline recorded 2026-06-20; no remediation backfill artifact since. This is a live known inventory-valuation drift. |
| Lot arc L1–L5 (`lot_location_quantities`, lineage, mills break) | **[STILL OPEN]** | No `lot_location_quantities` in schema/migrations (grep 0 hits). |

### 2.12 DEPENDENCY-ENTANGLEMENT-AUDIT.md + PROCESS-MAP.md (2026-03-20/21)

| Item | Status | Evidence |
|---|---|---|
| F1 OMS `reserveInventory` bypass | **[FIXED]** | §2.3 row 5. |
| F2–F6 `notifyChange` gaps in `core.service.ts` | **[SUPERSEDED]** | `core.service.ts` no longer exists; inventory rebuilt on use-cases with `onInventoryChange` (`inventory.use-cases.ts`, `break-assembly.use-cases.ts`); sync triggers now also explicit in reservation/receiving/cycle-count. Single-trigger consolidation (F14) not verifiable → treat as absorbed by the rebuild, re-audit sync coverage matrix fresh. |
| F7 `setInventoryLevel` bypass | **[FIXED]** | PROCESS-MAP Issue B marks it fixed (routes through `inventoryCore.adjustInventory()`). |
| F8 OMS orders never updated after ingest | **[FIXED]** | §2.3 row 4. |
| F9 legacy `sync.service.ts` fallback allocation engine | **[STILL OPEN]** (likely) | `channels/sync.service.ts` still exists with `queueSyncAfterInventoryChange`; the legacy-fallback removal was never recorded anywhere. Needs one targeted check by the channels auditor. |
| F13 no Shopify→Echelon feed reconciliation | **[STILL OPEN]** | No reconcile-from-Shopify job found; also the operational face of WMS-AUDIT #3 (60k 404s). |
| PROCESS-MAP P1 #16/#17 catalog archive/merge direct `inventory_levels` writes | **[FIXED]** (merge) / **[UNVERIFIABLE]** (archive) | Merge now routes through `convertSku` (WMS-INV M5 ☑); archive path not re-checked. |

### 2.13 GHOST-INVESTIGATION-2.md / NEGATIVE-INVENTORY-INVESTIGATION.md / BACKFILL-SUMMARY.md

| Item | Status | Evidence |
|---|---|---|
| Ghost #2: sync pushed per-variant ATP instead of fungible pool | **[FIXED]** | Orchestrator now records/pushes `a.allocatedUnits` from the allocation engine (`echelon-sync-orchestrator.service.ts:383-415`); `getDirectVariantAtpByWarehouse` remains only as an interface member (:91), no live call in the push path. |
| Negative inventory: cycle-count stale variance + `allowNegative:true` | **[FIXED]** | `cycle-count.use-cases.ts:277` "NEVER uses allowNegative"; guards at :338/:911; DB CHECK constraint; freeze enforcement extended to receive/adjust/transfer (Phase 4 H2 ☑). |
| Backfill 2026-03-28 (123 orders w/o lines) | **[FIXED]** (completed) | Ingest recovery now in `ingestOrder`; note left open: global unique on `external_line_item_id` "may need revisiting" — **[STILL OPEN]** as a schema question. |
| Startup `clear_neg.cjs` / script sprawl (ULTRAREVIEW §7) | **[STILL OPEN]** | 150+ one-off mutation scripts (`clear_neg.cjs`, `wipe-shopify.cjs`, `temp_drop_ghosts.ts`, …) remain at repo root, unguarded and in version control. |

### 2.14 SHIPSTATION-WMS-REFACTOR.md / PO-FLOW-AUDIT.md / implementation_plan.md

- **SHIPSTATION-WMS-REFACTOR**: delivered (WMS-first push/ship-notify; confirmed by current
  `wms-sync.service.ts:612` "Push to ShipStation via WMS-owned pushShipment path"). Its
  "untouched (intentional)" items — OMS `shipstation_order_id` retained, `echelon-oms-` orderKey
  back-compat — are the same debt tracked in §2.1. Superseded by the state-machine design.
- **PO-FLOW-AUDIT**: pure UX/solo-mode recommendations (quick-PO, submit+send, auto-navigate to
  receipt). **[UNVERIFIABLE]** this pass — none are financial-risk items; hand to a UX pass.
- **implementation_plan.md**: 1 line of UTF-16 garbage ("Allocation Engine Refactor") — dead file,
  delete.

### 2.15 DROPSHIP-* (skim only — dropship auditor owns the code)

Stated architecture: V2 CONSOLIDATED-DESIGN is the authoritative build design; IMPLEMENTATION-DELTA
records the decision to **start over** (prototype = reference only); Dropship is one OMS channel,
vendor stores are sources under it; acceptance = funded + reserved atomically, zero credit
exposure; Shellz Club plan is the entitlement source. PHASE1-ENGINEER-BRIEF scopes Phase 1 to data
model + constraints only. Observed in code: rebuilt module with clean layering
(`domain/application/infrastructure/interfaces`), Stripe funding provider with correct signature
verification, wallet ledger + tests. **Flag for the dropship auditor:** acceptance still increments
`inventory_levels.reserved_qty` via raw SQL (`dropship-order-acceptance.repository.ts:867`) —
locked and ledgered, but a standing `BOUNDARIES.md` reserveForOrder-only violation (see §1
contradiction 2). Phase status of product Phases 0–2 vs code: not assessed here.

### 2.16 Two-line notes on out-of-scope docs

- **SHELLZ-CLUB-AUDIT / -DEEP-DIVE / -UI-REVIEW** (2026-03-22/23): membership-system audits of the
  *separate* shellz-club-app codebase; relevant to Echelon only via the shared DB (see §2.8).
- **SUBSCRIPTION-APP-SPEC** (2026-03-22, DRAFT): spec for the Shopify subscription engine;
  subscription tables exist in `public.*` (artifact map) — ownership moved to shellz per runbook.
- **ops-portal-design-spec** (2026-04-26): cardshellz.io dropship portal UI spec; superseded in
  part by DROPSHIP-V2 portal UX scope.
- **replit.md**: agent-onboarding overview; states dev DB empty / always test on Heroku prod —
  operationally important, architecturally shallow; module list is stale like SYSTEM.md.

---

## 3. DOC HEALTH

**Current / trustworthy (keep as living docs):**
- `WMS-INVENTORY-REFACTOR.md` — actively maintained, statuses match code, self-corrects findings. Best doc in the repo.
- `BOUNDARIES.md` (2026-05-30) — matches deep-review §0.1; the boundary constitution. Keep.
- `SHIPMENT-STATE-MACHINE-DESIGN.md`, `LINE-ITEM-HOLD-DESIGN.md`, `ENGINE-CANCEL-DIVERGENCE-DESIGN.md`, `REFUND_RESTOCK_DESIGN.md` — accurate designs; phase-status headers need updating (each has shipped phases their "Status: proposed / no implementation" headers don't reflect).
- `DB-ROLE-SEPARATION-RUNBOOK.md` — current; execution state (Phases 2–4) unknown.
- `ORDER_TO_SHIP_DEEP_REVIEW_2026-05-30.md` — the master plan; largely executed through Phase 3–4; should get a status column, else its defect register will be re-reported forever.

**Stale / misleading (mark superseded or delete):**
- `SYSTEM.md` (2026-03-19) — wrong module map, wrong data flows, stale bug list. **Misleading; supersede.**
- `WMS_ARCHITECTURE.md` — describes a wave/tote/pack flow that has never existed. **Misleading; relabel "target vision" or delete.**
- `PROCESS-MAP.md` (2026-03-20/21) — pre-restructure paths (core.service.ts, replen.service.ts); some findings self-marked fixed; the rest superseded by the 05-28/05-30 audits. **Supersede.**
- `DEPENDENCY-ENTANGLEMENT-AUDIT.md` (2026-03-20) — same generation; keep only F9/F13 as open questions.
- `ORDER_FULFILLMENT_REVIEW.md` (05-22) and `ORDER_TO_SHIP_AUDIT_2026-05-28.md` — both explicitly superseded by the 05-30 deep review. Archive.
- `ULTRAREVIEW-echelon.md` / `ULTRAREVIEW-FIX-PLAN.md` (04-17) — P0 tiers essentially executed (see §2.2) but the docs carry no completion marks except a few `[COMPLETED]` in P3; a reader would wrongly believe 15 blockers are live. **Needs a disposition pass or archival with this reconciliation as the index.**
- `COGS-ENGINE-SPEC.md` — header "SPEC — no code" is false (engine implemented with naming drift). Update or archive.
- `SHIPSTATION-WMS-REFACTOR.md` — implemented and further superseded by C9/state-machine. Archive.
- `WMS-AUDIT-REPORT.md`, `PO-FLOW-AUDIT.md`, `NEGATIVE-INVENTORY-INVESTIGATION.md`, `GHOST-INVESTIGATION-2.md`, `BACKFILL-SUMMARY.md` — point-in-time investigations, all root causes since fixed; archive.
- `implementation_plan.md` — corrupt 1-liner; delete.
- `artifact-exhaustive-map.md` / `schema-map.md` — namespacing maps; many moves have since happened (wms/oms/inventory/channels schemas exist) but the docs still say "Pending Migration" for everything. Stale; regenerate from the live DB.

**Missing doc:** `FULFILLMENT_STATE_DESIGN.md` — cited as the governing design by migration 103
but absent from the repo. Either restore it or fold its content into a new doc before Phase 1/2 of
the line_fulfillments ledger proceeds.

---

## 4. UNKNOWNS

1. **Prod-side state** is unverifiable read-only from the repo: DB role-separation Phases 2–4
   actually executed? PO-68 `"partial"` row fixed? 232-cell lot drift remediated? channel_feeds
   404 storm resolved? The 10 expected physical returns received? All need live-DB probes.
2. **`FULFILLMENT_STATE_DESIGN.md` content** — the plan for deriving all order status from the
   `line_fulfillments` ledger is unrecoverable; only the migration header summarizes it.
3. **eBay non-happy-path parity** (D-EBAYCXL: cancel releases reservation? refund cascade?
   webhook signature verification on POST notifications beyond the GET challenge at
   `ebay-order-ingestion.ts:393-405`) — not re-verified this pass.
4. **H6/H7 landed-cost retro-mutation and FX** in `shipment-tracking.service.ts` — never
   re-audited since ULTRAREVIEW; the lot-lineage arc (L1–L5) would subsume part of it.
5. **Legacy channels sync engine** — is the `sync.service.ts` fallback allocation path still
   reachable when the orchestrator throws (DEP F9)?
6. **Whether "post-soak" for the shipstation shadow columns has an owner/date** — no exit
   criterion documented anywhere.
7. **Client-side items** (H20 vendor token storage, H26 claim-loop idempotency, M2 client money
   math) — client was not in scope for this pass.
8. **Test-suite health**: 259 test files and a CI workflow exist, but the suite was not executed
   (READ-ONLY mandate); the 3 known-red `link-child-to-parent` tests' disposition is unknown.
