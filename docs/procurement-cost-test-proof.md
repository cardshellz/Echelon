# Procurement cost test proof

Evidence date: 2026-09-06. Audited business baseline: `d836adc228897ca16f0dbb2416d15a2f7e6a36db`. The separate invoice metadata regression was run with the local `updateInvoiceLine` preservation fix. No receipt, inventory, AP reconciliation, freight, or COGS business implementation was changed by the characterization work.

**These audit tests intentionally pass when the current costing defects occur. They do not certify correct accounting.** They require the additional `ECHELON_COST_AUDIT=true` flag and live outside the normal `unit` and `integration` path selections.

## Executed evidence

`server/modules/procurement/__tests__/audit/receiving-cost-application.audit.test.ts`: **9/9 passed** against disposable local PostgreSQL 17.

The fixture uses a synthetic PO for 200 base pieces, $200 product and $20 packaging, and a shipment of 100 pieces received as two cases of 50. The generated receiving lines retain factor 50 and exact shipment-line 11. The actual receipt inventory ledger points to the actual created lot; the actual post-close PO reconciliation records 100 base pieces. Freight is $50 for that shipment. Approved invoice evidence prices the product at $1.20 per base piece. The tests inspect integer mills: 10,000 mills = $1.

| Scenario actually executed | Observed result per received case | What the result proves |
| --- | --- | --- |
| Current product-only PO price -> generated receipt -> close | Product 500,000 mills; packaging 0; total 500,000 | The PO's separate packaging basis of 50,000 mills per case is absent from the lot. |
| Conditional older blended unit price of 11,000 mills -> generated receipt -> close | Product 550,000; packaging 50,000; total 600,000 | The receive-time AP fallback treats the blended price as product and adds the separately created packaging layer again. This case does not establish that any production row has this shape. |
| Receipt -> approved invoice reconciliation -> freight finalization/push | Product 600,000; freight 0; total 600,000; push reports zero candidates | Invoice recost clears the provisional flag; later freight application cannot find this lot. The consumed COGS row also remains at 600,000. |
| Freight finalized -> receipt -> approved invoice reconciliation | After close product 500,000 and freight 0; after invoice total 600,000 | Finalized freight used during receipt disappears during the real receive-time AP fallback. A subsequent push still reports zero candidates. |
| Receipt -> freight push -> approved invoice reconciliation | Product 600,000; freight 250,000; total 850,000 | The same supplied product/freight evidence has a different outcome when freight is applied first. The actual consumed COGS row is recosted to 850,000. Packaging is still omitted. |
| Receipt frozen at 50, catalog changed to 100, then approved invoice reconciliation | Receipt snapshot stays 50; lot product becomes 1,200,000 | AP's cost reader scales with the current catalog factor, not the frozen receipt factor. |
| AP reconciliation updates a lot but holds its transaction open while freight starts | PostgreSQL confirms freight blocked; after AP commit freight applies and total reaches 850,000 | Timing changes eligibility: overlapping AP/freight can preserve freight even though serial AP-before-freight skips it. This is an observed schedule, not exhaustive concurrency proof. |
| AP audit insertion fails during receipt close | All fixture receipt/inventory/lot/PO rows and audit rows equal their before-state | The physical receipt transaction rolls back when its real AP callback fails. |
| AP audit insertion fails after receiving and recording consumed COGS | Invoice evidence, lot layers, COGS rows, adjustment log, PO and audits equal their before-state | The actual AP reconciliation transaction rolls its downstream changes back together. |

`server/modules/procurement/__tests__/integration/ap-invoice-line-metadata.integration.test.ts`: **11/11 passed** with the metadata fix. This is a regular correctness regression, separate from defect characterizations. The fixture retains an imported-like $118 line total, 150 units and 6,667 mills product quote (67-cent mirror):

- Notes-only, description-only, an unchanged full economic form echo, and a cents-only echo preserve quantity, both price fields, exact total, match status, source links, and every related invoice/PO/header/link row.
- A legacy null mills value remains null during a notes edit or an equivalent mills form echo.
- Exact economic before/after snapshots are asserted in the successful metadata audit.
- Explicit null mills, false cents, and an empty quantity string reject before any business or audit mutation.
- A real PostgreSQL audit trigger failure rolls back the line, including its timestamp.
- A real blocked parent-row race rechecks invoice status after another transaction approves the invoice and rejects the stale metadata edit without a write.

## Reproduction

Run each suite sequentially in the worktree. The database must be explicitly disposable and separate from `DATABASE_URL` and `EXTERNAL_DATABASE_URL`. The audit additionally refuses a remote hostname. The named schemas must not already exist; setup refuses ownership instead of dropping existing schemas. Both new suites take the same session advisory fixture lease and remove only schemas they created.

PowerShell, using the task-owned local test database:

```powershell
$env:ECHELON_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55436/echelon_shipment_cost_test'
$env:ECHELON_TEST_DATABASE_DISPOSABLE='true'
$env:ECHELON_COST_AUDIT='true'
npx vitest run server/modules/procurement/__tests__/audit/receiving-cost-application.audit.test.ts --maxWorkers=1 --no-file-parallelism
```

```powershell
Remove-Item Env:ECHELON_COST_AUDIT -ErrorAction SilentlyContinue
npx vitest run server/modules/procurement/__tests__/integration/ap-invoice-line-metadata.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

Without `ECHELON_COST_AUDIT=true`, the characterization suite skips even if the two database environment variables are set. No failing expected-correctness assertions were added to normal CI for the unresolved cost defects.

## Owner wiring and exact lineage

The combined harness executes these real owners:

- `createPurchasingService(...).createReceiptFromShipment` creates the receipt and frozen source fields; `onReceivingOrderClosed` performs the separate post-close PO reconciliation. Source prices are copied at `purchasing.service.ts:4105–4125`; this audit seeds a current product-only normalized row and does not execute the private price normalizer.
- `ReceivingService.open`, `updateLine`, and `close` execute real receipt and inventory mutations. `close` calls the real approved-invoice reconciler at `receiving.service.ts:1485–1492`, matching production injection at `server/services/index.ts:266–287`.
- `InventoryUseCases`, `InventoryLotService`, and `createInventoryMethods` create the actual level, lot and receipt ledger. Receipt replay authority is the nonvoided transaction with `receiving_line_id` at `inventory.use-cases.ts:166–185`.
- `reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction` reads actual PO/invoice rows, selects approved evidence, computes its weighted price, calls actual COGS, and writes the real AP audit (`ap-ledger.service.ts:1475–1663`).
- `createShipmentTrackingService` performs actual allocation/finalization and `pushLandedCostsToLots`; actual `COGSService` revalues lots, updates `oms.order_item_costs`, and writes the adjustment log.

The lineage query used by the test is:

```text
receiving_lines.id
  <- inventory_transactions.receiving_line_id (receipt, nonvoided)
  -> inventory_transactions.inventory_lot_id
  -> inventory_lots.id

receiving_lines.inbound_shipment_line_id -> inbound_shipment_lines.id
receiving_lines.units_per_variant_snapshot -> immutable receipt unit factor
po_receipts.receiving_line_id -> original posted base quantity
```

This exact lot-ledger relation already exists in `InventoryUseCases.reverseReceiptInventory` (`inventory.use-cases.ts:326–338`). The cost readers currently use weaker evidence: COGS selects lots by PO header/line and reads `product_variants.units_per_variant` (`cogs.service.ts:568–606`); freight candidates are only `cost_provisional=1` for a shipment (`procurement.storage.ts:1283–1288`), grouped by PO line and scaled from a live variant (`shipment-tracking.service.ts:1593–1639`, `1680–1688`). The receipt-time snapshot storage lookup is PO-line-only with `LIMIT 1` (`procurement.storage.ts:1234–1236`). These are code findings; this new suite does not yet prove all ambiguous historical mappings.

## Why the older fixtures did not prove this combined path

- `receiving-unit-integrity.integration.test.ts:45–48` constructs Receiving with null purchasing, shipment tracking and AP callbacks. It uses actual inventory owners at line 159, but its linked 501-piece case intentionally verifies an unavailable post-close purchasing owner at lines 264–278. This is valid receiving-unit proof, not combined costing proof.
- `invoice-variance-cogs.integration.test.ts` uses direct synthetic lot/COGS inserts and `COGSService`; its four cases at lines 156, 227, 262 and 312 prove mills, PO-line isolation, live variant scaling and a second-lot rollback. It does not create receipts or execute the approved-invoice selector or shipment application.
- `shipment-cost-commands.integration.test.ts:128–160` builds procurement freight/snapshot tables without the inventory/OMS tables or a receipt-created lot population. It proves command/finalization integrity, not the receipt/AP/freight sequence.
- `shipment-line-fixture.ts:27–50` derives real column types/defaults and applicable foreign keys. It does not install all table checks/indexes. The new audit explicitly adds migration 221 and the receipt, inventory-level, freight-allocation and snapshot uniqueness constraints it uses. The adjustment-log columns follow `server/db.ts:997–1008` and money types follow migration `0576_align_money_columns_bigint.sql`.

## Limits and next proof

The tests use only synthetic business rows. They prove reachable code behavior, not the prevalence or value of affected production inventory. No production values were read or changed. Approval status is synthetic evidence setup; the test calls the real AP reconciliation owner but does not test the approval HTTP command, payments, or durable command replay. COGS rows are seeded as already consumed; the FIFO pick/fulfillment path itself is not exercised. Channel publication and advisory warning reporting are outside this accounting fixture. Legacy module-global DB transports are forwarded to the same isolated PostgreSQL pool; no business query results or financial owner results are mocked.

The metadata fixture seeds the imported-like line rather than running `importLinesFromPO`; it verifies the actual edit owner and all rows it must preserve. It does not certify the semantics of an intentional economic edit.

The next correctness suite should replace defect expectations after a cost-layer authority contract is approved, then add duplicate/split source lines, competing shipments on one PO line, missing legacy lineage, exact residual allocation, source-version/idempotent replay, partial and reversed receipts, and whole-batch freight rollback with multiple lots. The current audit does not settle manual receiving overrides versus invoice authority, packaging price policy, short/damaged freight allocation, signed credits, or historical corrections. Those are recorded decision boundaries in `procurement-receiving-cost-followup.md` and the proposed cost application design.
