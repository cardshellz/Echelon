# Procurement document navigation

Opening a shipment, receipt or invoice from a purchase carries an explicit purchase origin and a bounded trail of visited documents. The shared URL helpers reconstruct the parent document and selected tab without depending on browser history. A separate purchase-context link returns directly to the originating purchase tab, including from a copied link in a new browser tab.

`tab` identifies the current section. `purchase` contains a validated purchase reference and repeated `via` parameters contain validated document references. These are navigation metadata only; existing record access checks and financial/inventory commands remain responsible for authority. A shared shipment keeps its original purchase context when the user follows another linked PO. Arbitrary external return URLs, unsupported record kinds/tabs and noncanonical IDs are rejected. The trail keeps the most recent 12 parents while retaining the purchase exit.

Existing `/receiving?open=ID` links remain supported and now stay in the address bar. The receipt loads by ID independently of the receiving list. Loading, invalid links, missing records and access errors retain an exit; recoverable request errors offer Retry. Late receipt responses cannot replace a different record or a later visit to the same URL. Existing variant-creation sibling updates finish against the initiating receipt even when the user navigates away.

## Purchase lifecycle workspace

Committed purchases without an explicit tab open on Lifecycle. Explicit bookmarks and the normal draft editor retain their behavior. The overview groups receipt documents beneath their recorded shipments and keeps invoices in a separate financial section. One read-only inspector switches records in place, with native links to existing full-record pages for actions. See `PurchaseLifecycleWorkspace`, `PurchaseLifecycleOverview` and `PurchaseRecordInspector` in `client/src/features/purchasing/`.

`inspect=shipment:42` selects a document, and repeated `inspectVia` values retain up to eight prior inspector selections. The existing purchase/parent references also encode this selection, so full-record navigation, Back/Forward, refresh and copied links can restore it. These values cannot authorize a record or create a relationship. The inspector only resolves records returned in the purchase workspace. PO command invalidations also refresh the mounted workspace through the query key prefix.

### Read model and evidence

`GET /api/purchase-orders/:id/workspace` requires the existing `purchasing.view` permission. `createPurchaseWorkspaceRepository` in `server/modules/procurement/purchase-workspace.repository.ts` reads a single read-only, repeatable-read PostgreSQL snapshot. Its eleven maximum SELECTs are parameterized and bounded at 2,000 document records and 10,000 line/link rows per section; exceeding a bound returns an explicit error rather than partial history. No schema migration or business write is introduced.

`createPurchaseWorkspaceService` constructs edges only from stored references. Direct receipts are the union of receiving headers, receipt-line PO references and posted PO receipt links. A bounded expansion includes other POs' receipt headers on already-discovered shared shipments, preserving their recorded PO identity. Drafts, cancelled records and legacy receipt evidence remain visible. Invoices are discovered through PO links, shipment headers and freight-cost invoice links. Another PO's unrelated graph is not recursively loaded.

The DTO validates safe integer cents and preserves missing amounts/dates. It does not infer purchase allocations from whole-document payments or a receipt's stock availability.

### Financial limitations discovered

- `recomputePoFinancialAggregates` in `server/modules/procurement/ap-ledger.service.ts` selects and sums whole linked invoices' amounts and payments, then derives PO financial status. It does not use the link's allocated amount. The workspace suppresses those monetary PO rollups and labels the status as recorded. Each invoice retains its own currency, whole-invoice amounts and separately stored allocation to this purchase.
- `recomputeShipmentTotals` in `server/modules/procurement/shipment-tracking.service.ts` sums recorded cost cents without currency conversion in that function. Shipment headers do not establish a reliable currency basis. The inspector withholds those monetary summaries and links to the source Costs tab. These observations establish a display limitation; live financial impact and remediation require separate investigation.

Production relationship completeness and query performance have not been measured by these fixture tests. Pre-PO sourcing/RFQ lineage, production-stage detail, landed-cost reconciliation, lot drill-through, payment-page context, planning recommendations and further automation remain subsequent work. Purchasing decisions and financial posting rules are outside this change.


## Verification

Run the focused unit and rendered component tests:

```sh
npx vitest run client/src/lib/__tests__/unit client/src/pages/__tests__/unit
npm run check
```

Run actual frontend browser journeys with fictional API responses:

```sh
npx playwright install chromium
npx playwright test --config playwright.procurement.config.ts
```

The browser suite starts Vite only, blocks service workers so API interception cannot be bypassed, and never starts the application server or connects to a database. Unexpected API mutations fail the tests; the delayed receipt test explicitly intercepts its one intended POST. Desktop/mobile cases cover native links and keyboard activation, browser Back/Forward, refresh, copied links, shared-shipment origins, receipts absent from the list, access-error retry, malformed IDs and delayed receipt actions. The Procurement navigation workflow runs these journeys on pull requests. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select a locally installed Chromium/Chrome binary instead of a downloaded test browser.

The lifecycle tests additionally cover inline inspector history, focus and mobile visibility, shared-delivery receipts, whole-invoice scope, invalid/missing selections, stale refresh recovery, and same-page PO cache invalidation. PostgreSQL hardening CI executes `server/modules/procurement/__tests__/integration/purchase-workspace.integration.test.ts` against its disposable service database. Locally that integration suite requires both `ECHELON_TEST_DATABASE_URL` and `ECHELON_TEST_DATABASE_DISPOSABLE=true`; it does not use the application database.
