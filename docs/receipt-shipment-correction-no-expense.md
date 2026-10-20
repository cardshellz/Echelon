# Shipment and receipt corrections without an expense decision

## Observed history: S260714003536

Read-only production trace on 2026-10-20. No live quantity, cost, stock, or approval was changed.

| Record | Verified state at the trace |
| --- | --- |
| Shipment 89, line 134 | `#S260714003536`, 20,000 pieces, 20 cartons, $1,298.38 allocated shipment charges |
| PO 124, line 191 | `PO-20260520-002`, SKU `EG-SLV-SLM` |
| Linked receipt 229, line 2703 | `RCV-20260723-001`, 20 received handling units; piece conversion and cost-origin link missing |
| Original lot 1926 | `LOT-20260723-014`, 20 received units, zero on hand; no cost-origin, contribution edge, or order-cost row |
| Historical expense approvals | None recorded for shipment line 134 |

The original receipt is **RCV-20260723-001**. It is not RCV-20261019-001, which was mentioned earlier in the discussion.

The recorded movements explain why zero on hand must not be treated as a sale:

1. Transaction 48317 received 20 units of variant 508 at location 1387 into lot 1926.
2. Transaction 48321 transferred 20 units to location 1275. Lot 1927 records the corresponding transferred receipt, but the transaction has no lot ID and there is no immutable cost contribution from lot 1926.
3. Transactions 48322/48323 record a case break: one case out and ten packs in. Lot 1928 records the resulting packs; its cost ancestry is missing.
4. Approved cycle count 421 contains transactions 48329/48330: +19 cases of variant 75 and -19 cases of variant 508. The count items have no explicit counterpart links.
5. Approved cycle count 423 adds 90 packs in transaction 48331. This changes ten packs to 100; lot 1930 records the added packs without a receipt cost link.
6. There are existing order-cost rows on lots 1928 and 1930. They prove recorded order consumption on those lots, but do not establish the missing cost path from receipt lot 1926. Later transformation edges from lot 1929 likewise do not repair the original missing transfer and count associations.

The current catalog now says variant 508 contains 10,000 pieces. A mutable catalog value cannot establish what a historical receipt or transformation meant. The approved correction explicitly records the administrator's receipt piece conversion instead.

**Unproven:** the exact cost attribution across those unlinked transfers, pack changes, and count-created lots. Matching product, date, or location is not sufficient authority to assign this receipt's charge to later sales. This change does not fabricate those links or declare the historical cost fully posted.

## Corrected behavior

In **Edit shipment**, select **Also correct received quantities**, enter 200,000 for the shipment and the linked receipt, and review one combined preview. One administrator approval commits the quantity correction, allocation recalculation, supported inventory/order cost updates, and immutable approval history in the same transaction.

| Item | Before | After approval |
| --- | ---: | ---: |
| Shipment pieces | 20,000 | 200,000 |
| Receipt pieces | 20,000 | 200,000 |
| Received handling units | 20 | 20 |
| Pieces per handling unit | 1,000 inferred from the old piece total | 10,000 explicitly approved |
| Shipping cartons | 20 | 20 |
| Shipment charge | $1,298.38 | $1,298.38 |
| Shipment charge per piece, display precision | $0.064919 | $0.006492 |
| Expense created by the correction | $0 | $0 |

Unassigned shipment costs remain visible separately from the successfully saved quantities. Where the exact remainder cannot be proved, the preview says it has not yet been calculated; it does not substitute zero. The full charge is not called unassigned when there are existing roots, lot costs, contribution links, or order-cost records that could already contain it.

Existing customer-order costs are updated only through the existing recorded lot/contribution/quantity-allocation graph. The correction neither inserts a new sale nor posts a historical COGS or inventory-expense adjustment. Earlier historical approvals and postings are preserved. If such a posting could overlap a proposed stock recost, the component stays in review rather than counting the same cost twice.

## Implementation and evidence

- `executeCorrection` in `server/modules/procurement/receipt-shipment-quantity-correction.service.ts` uses the same savepoint preview and locked approval transaction. Both purchase and shipment cost owners receive `historicalReconciliation: "preserve"`.
- `applyCostRevision` in `server/modules/inventory/application/apply-cost-revision.ts` separates quantity-edit authority from historical expense authority. Existing expense balances block overlapping component application; no historical posting or reversal runs under this policy.
- `quantityCorrectionInputSchema` and `shipmentQuantityEditInputSchema` in `shared/procurement/receipt-shipment-quantity-correction.ts` reject expense destinations. Older clients may still send `null`.
- `readQuantityCorrectionCostReview` reads the saved application and existing ledger; `summarizeQuantityCorrectionCostReview` computes exact, evidence-backed remaining amounts without writes.
- `cascadeRecostExactQuantities` in `server/modules/inventory/cogs.service.ts` updates existing linked order-cost rows and validates their lot and quantity allocations. It does not infer a sale from zero stock. The quantity edit does not change order dispatch or revenue-recognition authority.
- `ReceiptShipmentQuantityCorrection` presents the amount left for cost-history review before approval and in the saved receipt/shipment history, without expense radio buttons.

## Verification and limits

The disposable-PostgreSQL integration cases cover 20,000 to 200,000, unchanged physical movements and charges, existing linked inventory/order recost, missing origins, unrelated sales with the same SKU, existing approvals, idempotent retry, stale previews, concurrent edits, permission loss, and transactional rollback. Unit/HTTP cases reject both expense destinations and test exact remainders and uncertain attribution. Desktop/mobile browser journeys cover one combined approval, saved history, non-admin access, and lost-response retry.

The production trace is evidence of the existing data, not deployment acceptance of this code. After deployment, the administrator still needs to approve the preview. Any remaining historical cost links require evidence-backed reconstruction before those costs can be assigned to stock or individual customer orders.
