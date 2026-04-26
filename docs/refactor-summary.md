# ShipStation / OMS / WMS Refactor — Summary

**Completed:** 2026-04-26
**Plan reference:** `shipstation-flow-refactor-plan.md`
**Branch:** `refactor/ss-wms-oms`
**Commits:** C1–C38 (38 total)

---

## 1. What this refactor accomplished

### Core outcomes

- **Disconnected Shopify-native ShipStation integration potential.** Echelon now fully replaces Shopify's built-in ShipStation app — push, reconcile, and fulfillment all flow through Echelon.
- **WMS is the source of truth for fulfillment.** ShipStation push reads from `wms.orders` + `wms.outbound_shipments` instead of OMS. Financial snapshot populates WMS with order totals, tax, shipping cost.
- **Multi-shipment-native SHIP_NOTIFY.** The v2 handler supports cancel, void, re-label, address-change, and mid-flight cancel-after-label. Each shipment is tracked independently in `wms.outbound_shipments`.
- **Per-shipment Shopify fulfillment push with combined-orders fan-out.** Each `outbound_shipment` produces a Shopify fulfillment. Combined orders (multiple OMS orders → one SS order) fan out correctly.
- **Inbound reconciliation.** Shopify → OMS → WMS → ShipStation cascade for fulfillments, orders/cancellations, and refunds. Every Shopify webhook that modifies fulfillment state is handled.
- **Data hygiene.** 53k+ legacy NULL rows backfilled, dedup constraints enforced, retry + dead-letter queue (DLQ) on every async path.
- **Observability.** Structured events + metrics on every failure surface: push, reconcile, SHIP_NOTIFY, Shopify fulfillment push, inbound reconciliation.

### What changed in the data flow

**Before:**
- Shopify native SS app handles push + fulfillment
- Echelon reconciles in a fragile, best-effort way
- OMS is the only source of truth for order data
- SHIP_NOTIFY is single-shipment, no void/re-label support

**After:**
- Echelon handles everything: OMS → WMS → SS push → Shopify fulfillment
- WMS is source of truth for fulfillment + financial data
- Multi-shipment SHIP_NOTIFY with full lifecycle support
- Inbound webhooks (Shopify → Echelon) for orders, fulfillments, refunds
- Reconcile runs on `wms.outbound_shipments` (not legacy path)

---

## 2. Commits delivered

| Group | Commits | Description |
|-------|---------|-------------|
| **A: Foundation** | C1–C6 | Schema, types, migrations (058–062). New WMS tables + columns. No behavior change. |
| **B: OMS→WMS sync** | C7–C10 | Financial snapshot at sync, shipment row at sync, factory invariant, eBay consolidation. |
| **C: Push from WMS** | C11–C14 | `pushShipment` function, wiring into webhook handler, dual `orderKey` support (GID + external), combined-orders link table. |
| **D: SHIP_NOTIFY** | C15–C20 | V2 multi-shipment handler, recompute-only writer, void/relabel history tracking, cancel cascade, retry + DLQ. |
| **E: Shopify push** | C21–C28 | Push scaffolding, ingest population, push upgrade, wire into SHIP_NOTIFY, cancel handling, tracking-update handling, combined-orders fan-out. |
| **F: Inbound reconciliation** | C29–C33 | `fulfillments/create`, `fulfillments/update`, `orders/cancelled`, `refunds/create`, Shopify retry mechanism. |
| **G: Data recovery** | C34–C36 | Backfill scripts (`dedup-oms-orders`, `backfill-wms-oms-link`), NOT VALID constraint (064), unique index + dedup (065), metrics (36). |
| **H: Monitoring + cutover** | C37–C38 | Parity check script, this runbook + summary doc. |

**Total: 38 commits across 8 groups.**

---

## 3. Key feature flags

All flags are Heroku env vars. Default is `false` (OFF). After cutover, all should be `true` (ON) in production.

| Flag | Commit | Effect when ON |
|------|--------|----------------|
| `WMS_SHIPMENT_AT_SYNC` | C8 | Creates `wms.outbound_shipments` row at OMS→WMS sync time |
| `WMS_FINANCIAL_SNAPSHOT` | C7 | Populates WMS financial columns (`total_cents`, `tax_cents`, `shipping_cents`, etc.) |
| `PUSH_FROM_WMS` | C12 | ShipStation push reads from WMS data model instead of OMS |
| `SHIP_NOTIFY_V2` | C15 | SHIP_NOTIFY webhook routes to shipment-centric v2 handler |
| `RECONCILE_V2` | C35 | Hourly reconcile reads from `wms.outbound_shipments` |
| `INBOUND_RECONCILE_V2` | C29 | Shopify webhooks (fulfillments, orders, refunds) trigger OMS→WMS→SS cascade |
| `SHOPIFY_FULFILLMENT_PUSH_ENABLED` | C22 | Echelon pushes fulfillments to Shopify (replaces native SS app) |

### Flag dependency order

```
WMS_SHIPMENT_AT_SYNC ──┐
WMS_FINANCIAL_SNAPSHOT ─┤
                        ├── PUSH_FROM_WMS ── SHIP_NOTIFY_V2 ── RECONCILE_V2
                        │                                      INBOUND_RECONCILE_V2
                        │                                      SHOPIFY_FULFILLMENT_PUSH_ENABLED
```

Flags 1–2 are write-only (additive). Flags 3–7 change read/write behavior. See `docs/cutover-runbook.md` §3 for the exact flip sequence.

---

## 4. Known limitations (not in scope)

### 4.1 3PL inventory tracking

Pre-shipment refunds for 3PL fulfillments don't decrement Echelon inventory. The Group F inbound reconciliation sweep partially covers shipment state but does not handle inventory adjustments.

**Status:** TODO. Needs a follow-up task to wire refund webhooks into the inventory system.

### 4.2 Legacy orphan WMS rows

~33,813 legacy `wms.orders` rows have no matching `oms.orders` parent. These are truly orphaned — the OMS records were deleted or never existed in Echelon. They cannot be backfilled.

**Status:** Accepted. The NOT VALID constraint (migration 064) exempts these rows from FK enforcement. They remain as historical data. Any new rows will be fully constrained.

### 4.3 Shopify-native SS race window

During the final cutover (disconnecting Shopify's ShipStation app), there's a ~15-minute window where both systems could theoretically push fulfillments for the same order. The cutover runbook specifies running this during a low-volume window.

**Mitigation:** `SHOPIFY_FULFILLMENT_PUSH_ENABLED` should be on for 48 hours before disconnect, proving Echelon's push works. If a race occurs, the second fulfillment push will get a Shopify 422 (already fulfilled) which is handled gracefully.

---

## 5. Reference

| Document | Location |
|----------|----------|
| Full implementation plan | `shipstation-flow-refactor-plan.md` |
| Original audit | `shipstation-sync-audit.md` |
| Diagnostic queries | `shipstation-diagnostic-queries.sql` |
| Cutover runbook | `docs/cutover-runbook.md` |
| Coding standards | `memory/coding-standards.md` |
| Process map | `PROCESS-MAP.md` |
