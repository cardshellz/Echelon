# Procurement acceptance repairs — 2026-09-10

The live walkthrough reproduced six defects in purchasing priorities, cost reporting, shipment links, schedule dates, forecast explanations, and supplier summaries. This batch addresses those defects together. Deployment and another live acceptance pass are still required.

## Changes and evidence

| Defect | Corrected behavior | Implementation |
|---|---|---|
| COST-READ-001 | Valuation and lot reads use the canonical product SKU. A failed or malformed response produces an error with retry; it cannot impersonate empty inventory or leave stale totals labeled current. Signed values, zero, and missing values retain their distinct meanings. | `getInventoryValuation` / `getAllCostLots` in [cogs.service.ts](../server/modules/inventory/cogs.service.ts); [response contracts](../shared/inventory/cost-report-read.ts); `ValuationSection` / `CostExplorer` in [CostDashboard.tsx](../client/src/pages/CostDashboard.tsx). |
| PRIORITY-001 | Dashboard, KPI counts, filters, displayed quantities, and suggested spend share purchasing dispositions. No-demand/no-target products do not become purchasing stockouts. Supplier work stays visible. Upcoming alerts remain visible before a quantity is due. Unresolved receipts remain review work even if fallback arithmetic produces a positive quantity. Explicit non-stock catalog policies exclude products from purchasing. | [purchaseBuyingDisposition](../shared/procurement/purchase-buying-review.ts); [inventory eligibility](../shared/procurement/purchase-inventory-eligibility.ts); [recommendation engine](../server/modules/procurement/purchasing-recommendation.engine.ts); `getDashboardData` in [storage](../server/modules/procurement/procurement.storage.ts); [ReorderEngine](../client/src/pages/ReorderEngine.tsx). |
| SHIPMENT-NAV-001 | Shipment lists and details show actual PO numbers. One batch query projects both persisted associations on shipment lines without multiplying list rows or changing pagination. Links retain shipment return context. | [readShipmentPurchaseOrders](../server/modules/procurement/shipment-purchase-orders.repository.ts); [ShipmentPurchaseOrderLinks](../client/src/features/purchasing/ShipmentPurchaseOrderLinks.tsx). |
| SCHEDULE-DATE-001 | Requested/expected/confirmed PO delivery dates use one calendar-date formatter across list, header, lifecycle, and inspector. Recorded event timestamps keep their existing timezone behavior. | [procurementScheduleDateInput / formatProcurementScheduleDate](../client/src/lib/procurement-schedule-date.ts). |
| EXPLAIN-001 | Normalized forecast weights display as percentages. The engine captures the actual order increment and its source; Explain, RFQ evidence, and run details preserve that evidence. Old captures without it remain explicitly unknown. Seasonal notes depend on the actual forecast method and missing-history evidence. | [order-rounding contract](../shared/procurement/purchase-order-rounding.ts); [formatForecastWeight / formatOrderRounding](../client/src/features/purchasing/reorder-explanation-format.ts); `MathDrawerBody` in [ReorderEngine](../client/src/pages/ReorderEngine.tsx). |
| SUPPLIER-SUMMARY-001 | Mapping counts name the expanded supplier and show loading/unavailable states. They no longer imply an aggregate across all suppliers. | [Suppliers](../client/src/pages/Suppliers.tsx). |

The open-PO skip check also uses the forecast-adjusted target. With a baseline target of 370 pieces, 300 available, 100 incoming, and a 100-piece forecast overlay, the target is 470 and the shortfall is 70. The dashboard and manual analysis must not disagree because one compares incoming supply to the older baseline. Existing quality and approval gates continue to govern automated drafting.

## Assumptions and compatibility

- Catalog eligibility uses active variants' explicit `requiresShipping` and `trackInventory` policies. No SKU-name heuristics or historical catalog changes are introduced. Missing legacy policy evidence retains prior behavior.
- The schedule display follows the existing PO header's UTC calendar-day convention. Stored schedule values and audit timestamps are not changed.
- Old recommendation snapshots remain readable without rounding provenance. New captures include it; historical provenance is not reconstructed from today's supplier mapping.
- Cost-lot count and page are independent reads. Validation checks their individual shapes without imposing a false cross-query count invariant during concurrent receiving.
- No database migration, production data repair, financial posting, carrier refresh, or saved setting change is part of this patch.

## Validation and remaining acceptance

Regression coverage includes no demand, essential stock floors, supplier gaps, forecast overlays with incoming stock, upcoming alerts, unresolved receipts with positive and zero fallback quantities, real canonical-schema cost and shipment queries, concurrent lot creation, invalid cost responses, retry/stale states, split/consolidated links, timezone differences, forecast weights, and supplier count scope. New shared/client and PostgreSQL fixtures are included in CI. Browser coverage runs on desktop and mobile against mocked APIs.

Local validation passed:

- Broad unit suite: 12,280 passed, 39 existing skips. After the last buying edge-case changes, the 183 affected engine, route, forecast, shared, and client tests passed again.
- Full procurement browser suite: 258 passed across desktop and mobile. After the last buying changes, all 18 buying/planning browser cases passed again.
- Canonical PostgreSQL cost reads and shipment associations: seven integration tests passed together in a disposable local database.
- Final production build and TypeScript checks passed, including all 20 changed test files.

The broad suites began before the final buying edge-case edits; the affected reruns, final build/typecheck, and PR CI validate the completed batch. Detailed command results are retained in the local acceptance repair artifact.

Passing these checks does not establish production valuation, forecast-policy suitability, or unattended purchasing readiness. After deployment, repeat the original live examples and reconcile a known cost amount. RFQ creation, split receiving/putaway, invoice/payment posting, and late-cost propagation still require the controlled acceptance fixture.
