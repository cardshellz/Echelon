# Purchase pipeline and supplier production evidence

This increment adds a bounded read model and an explicit supplier-report command to the integrated procurement candidate. It does not change production data, inventory, AP, vendor communications or external reporting.

## What the code definitely does

`PurchasePipeline` is mounted on the Procurement Dashboard in `client/src/pages/PurchasingDashboard.tsx`. It loads independently from the older dashboard metrics. The older “In Transit” tile is relabeled “Sent / Acknowledged”; `procurement.storage.ts:getDashboardData` counts those legacy PO states, which do not prove carrier possession.

`purchase-pipeline.repository.ts:createPurchasePipelineRepository` reads active committed product purchase lines, exact shipment lines, closed receipt lines, original PO postings, reversals, current supplier reports and latest component revisions in one read-only repeatable-read transaction. It bounds each evidence set at 10,000 rows and fails visibly if the bound is exceeded. No partial result is silently presented as a complete total.

`purchase-pipeline.service.ts:projectPurchasePipeline` excludes draft, pending-approval, cancelled, closed and fully received purchases. It computes remaining base pieces from ordered less cancelled less proven physically received quantities. `resolvePipelineReceiptQuantities` uses the receipt owner's frozen-unit resolver and exact reversal evidence. When physical receiving has committed and PO/AP synchronization is still pending, those pieces are already excluded. A PO tally ahead of provable receipts makes the remaining quantity unknown until its history is reviewed.

Exact shipment-line links distinguish one purchase across several deliveries and several purchases in one shipment. Shared shipment/header totals are never repeated as a purchase's inventory value. Excess shipment coverage, missing source links, receipt/source conflicts and unsupported stages produce review cases. The reader does not join by SKU or reinterpret historical receipts using current catalog pack sizes.

Supplier-held quantities are divided by cumulative supplier reports: completed minus already dispatched/directly received is ready to ship; started minus completed is reported in production; the remainder is unconfirmed. Actual dispatched quantities are independently assigned to transit, port/customs or delivered-awaiting-receipt. A booked shipment is a logistics plan, not proof that production or dispatch occurred. Production progress must fit the current net ordered quantity and must cover independently proven dispatch. Contradictory reports stay visible but cannot assert production/ready stage quantities. Older report dates remain visible with their age; age alone is not an invented supplier SLA and does not erase historical evidence.

`pipelineIntervalMills` uses cumulative BigInt interval allocation. Known product quote amounts retain the vendor's original per-piece, purchase-unit or extended-total basis; packaging is separate. The preview never multiplies a rounded per-piece display to reconstruct a quote total. Latest recorded component revisions require their exact immutable fingerprint, component, purchase/shipment scope, currency and full captured quantity denominator. Partial or unresolved source coverage is not extrapolated to the full open purchase. Source IDs and recorded dates remain visible. Confirmed, estimated and unknown component amounts stay separate, and currencies are never combined through an assumed exchange rate.

The arrival filters cover 30 or 90 days, overdue, later, delivered and unknown dates. Shipment ETA is explicitly a shipment-destination date; it is not labeled as a confirmed warehouse landing. Otherwise exact line promise/expected dates precede purchase confirmation/requested dates. Source records link to the existing purchase lifecycle workspace and shipment inspector.

## Operator flow

1. Open **Procurement → Dashboard → Purchases before warehouse receipt**. Review the stage/currency summaries and the incomplete-component counts before using a value for planning.
2. Use the arrival horizon and filters to inspect what is coming, what is overdue and which dates are unknown. Open the exact PO or shipment link for its full lifecycle and cost evidence.
3. Choose **Record supplier progress** on a line. Enter cumulative started and completed base pieces, the supplier report's UTC timestamp, an evidence reference and notes. Completed pieces are part of started pieces. This is an operator report, not a stock receipt or payment approval.
4. Save once. The command creates an immutable revision with actor, time and before/after report. Corrections create another revision; they never overwrite history. A competing edit requires an explicit reload. If the response is uncertain, the editor locks the unchanged intent and offers **Retry saved progress** with the same key.
5. View-only users can open **Supplier report history**; the mutation controls remain unavailable. The server independently requires `purchasing:edit` for reporting and `purchasing:view` for reads.

`supplier-progress.service.ts:createSupplierProgressService.update` validates strict input, actor, integer quantities and nonfuture report time. It takes the shared inventory-cost graph lock before purchase/header/line/progress locks, checks replay evidence before optimistic-version conflict, and appends history and current state in one transaction. It posts no physical or financial transaction. A replay after a later correction returns the original result; reusing its key with a changed payload or actor is rejected.

## What is not proven

- Supplier report accuracy, quote validity, carrier tracking and production readiness depend on actual operator/supplier evidence. Existing purchases receive no fabricated production history.
- The value shown is a procurement planning component preview, not a GL recognition conclusion, cash forecast, complete landed-cost certificate or availability-for-sale number. Taxes, discounts, fees and unknown/unallocated freight require their existing explicit cost allocation workflow.
- A recorded confirmed source is the latest persisted source revision, not proof that every external invoice or freight bill has arrived. Exact source dates and unknown components remain visible.
- Shipment ETA may refer to a port or other shipment destination. No carrier API or warehouse arrival guarantee is created.
- Bookings without physical dispatch remain supplier-held; their shipment ETA is not assigned to a production quantity through an inferred match. Product-line/PO dates remain available until physical shipment evidence establishes the narrower arrival scope.
- Synthetic tests prove source joins and command behavior; they do not reconcile production purchases or supplier reports.

## Migration and recovery

Apply `226_purchase_supplier_progress.sql` before this application increment. It adds current progress and immutable revision tables with exact purchase-line references, unique command identities and unique line/revision identities. Reapplying the migration is tested. Required missing storage fails visibly; there is no silent neutral fallback for a broken database.

Migration 222's component revision storage and the integrated receipt-unit/lineage migrations are read dependencies. A compatible older application can ignore the new additive tables; retain them and their history during code rollback. Historical report corrections remain normal audited commands. No automated backfill, supplier send or financial correction runs during deployment.

## Verification

- Domain tests cover exact partial shipment/receipt accounting, full production completion before partial dispatch, booked-vs-dispatched distinctions, conflicting/old reports, excluded PO states, missing/reversed receipt evidence, shared/split sources, overcoverage, missing links, 30/90 day and unknown arrivals, separate currencies, BigInt limits, quote-UOM extensions, signed residuals and immutable source fingerprints.
- HTTP boundary tests verify read/write capabilities, strict horizon/identity validation and rejected input before database access.
- The real PostgreSQL suite applies migration 226 twice and runs the actual report owner/read repository. It proves audit/replay/changed-key rejection, concurrent one-winner revisions, late-write rollback, immutability, physical-receipt-before-PO-sync exclusion, shared/split exact links, and actual `recordCostRevision` fingerprint consumption. It uses only the separate local disposable pipeline database and removes its owned fixture schema.
- Desktop and 390px mobile browser scenarios cover the full dashboard insertion, independence from unrelated dashboard failures, exact shipment-inspector links, horizon/unknown filters, report validation, retained history, safe uncertain-response retry, view-only controls and malformed/failed reads. Screenshots were inspected; no horizontal overflow was observed.

Final scoped evidence on this candidate: **34 unit/route tests, 8 real PostgreSQL tests and 8 desktop/mobile browser cases passed; TypeScript passed with no errors**. The PostgreSQL fixture uses the separate local `echelon_procurement_pipeline_20260907` database and has removed its owned schema. All browser API calls were intercepted, including progress writes; no production API or supplier action ran.

The writer-ratchet increment contains only the two new supplier-progress tables. The private base predates the integrated branch's two RFQ baseline entries; the root integration owns those existing RFQ entries and its final combined writer-ratchet run. This increment does not claim an independent green full-repository suite from that older private base.
