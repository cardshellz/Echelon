# Procurement reporting follow-up - 2026-09-11

## Confirmed code defect and fix

Dashboard.tsx's Finance query calls GET /api/finance/summary. registerFinanceAnalyticsRoutes logs failures and returns HTTP500. Live logs at 2026-09-11T18:38:20Z show PostgreSQL22P02: a Shopify gid://shopify/Order/... identifier cannot be cast to bigint.

finance-analytics.service.ts aggregateCogs and channelBreakdown cast wo.oms_fulfillment_order_id directly to bigint. This column is varchar128 in shared/schema/orders.schema.ts, and provider references coexist with internal references. wms-sync.service.ts syncOmsOrderToWmsInternal writes source=oms/internal OMS ids; legacy import paths also use source_table_id. The existing oms-wms-order-link.sql.ts wmsOmsOrderIdSql already defines guarded source-aware resolution used by the operations monitor.

All four finance cost views now use that resolver: summary, channel totals, order list and order detail. Numeric provider identifiers cannot accidentally match an internal order; oversized/GID references do not throw; a valid direct OMS reference wins over legacy fallback. Unsupported references remain unmatched, not guessed. Removed safeCogs' error-to-zero fallback so unavailable cost queries cannot publish inflated margins. Route-level logging/error handling remains in place. No schema or historical records changed.

## Validation

The existing PostgreSQL cost-report-read suite now has11 cases, all passing. Added real-SQL coverage for direct internal references, Shopify GID with legacy link, unlinked GID, numeric provider collision, oversized text, conflicting direct/legacy references and consistent costs across four views. Injected aggregate transport failure verifies error propagation rather than zero COGS. Full TypeScript passed. The disposable local cluster is independent of production; production inspection used READ ONLY transactions.

## Live historical data findings - not repriced

- Lot2760 / LOT-20260905-003 / GLV-MAG-35PT-P50 has units_per_variant50, unit/PO/total cost1 mill, landed0, source transformation, provisional0. Its notes identify Replen task1644 (case_break).
- No inventory.lot_cost_origins, lot_cost_contributions or cost_adjustment_log record was found for lot2760. Movement63970 consumed1 unit of variant112 from location1262; movement63971 added100 units of variant111 to location1211. Neither movement retains cost or lot identity. These facts establish the operation, not the exact historical consumed lot/cost. Repricing requires source evidence.
- Seven active positive-quantity provisional lots2553,2556,2578,2579,2580,2606,2608 all reference receiving order233 / shipment90. Each has landed_cost_mills0 and PO source cost. Five shipment charges125–129 total676274 USD cents; each is marked estimated and has no vendor_invoice_id. An actual_cents field alone is not proof of approval or historical allocation.

## Assumptions, risks and next checks

The fix follows the existing internal-link resolver rather than inventing provider matching rules. Unlinked historical costs are still outside OMS aggregation; this change does not certify completeness. A query failure now fails explicitly rather than understating COGS. Historical order-detail cent rounding and multi-currency policy are unchanged.

After deployment, retest Finance summary and compare its order/channel costs. Historical correction remains separate: obtain authoritative product/pack costs for task1644's source and validate shipment90 charge evidence, allocation and downstream sold COGS before any cost application. No payments, inventory, costs, permissions or provider settings were mutated.
