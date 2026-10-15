# Shipment invoice replacement

Reproduction base: `079d4274b2c8ed42ae3f1e8a6b6eb7dc9acf01af` on 2026-10-15. Refreshed implementation base: `9e09d41dad4dbee0575d0bc7db10d692ebb9e61c` (the incoming PR1795 has no procurement changes). This is the bounded correction for procurement finding F21. PR1792 (exact shipment value allocation) is merged; deployment is not established by that fact.

## Reproduced defect

`ap-ledger.service.ts::voidInvoiceInTransaction` preserves the original invoice lines and shipment-charge foreign keys. `getCostVendorsForShipment` and `listCostsForInvoiceCreation` select only charges with no invoice foreign key. `unlinkCostFromInvoice` rejects a voided invoice through the existing terminal edit policy. The supplier-number unique index also prevents creating another invoice with that number.

A disposable PostgreSQL reproduction exercised actual shipment-invoice creation, durable void and replay, picker reads, attempted recreation and unlink. All three characterization cases reproduced the dead end. Clearing only the charge foreign key is insufficient: `resolveShipmentChargeEvidence` still sees the original voided freight lines and correctly requires review.

The normal shipment detail GET also returned raw costs while its separate costs GET used invoice enrichment. Consequently, the main page could fall back to Unbilled even for a linked invoice. Both reads must supply the same enriched and versioned cost contract.

## Explicit recovery

The supported recovery creates a new received invoice, using the original supplier invoice number, and transfers the complete shipment-charge assignment in one transaction. It retains the voided original and its invoice lines, PO links, attachments and audit history. The new invoice remains subject to ordinary review, correction and approval; replacement creation neither pays it nor posts inventory costs.

Eligibility requires a voided shipment invoice with no payment allocation history, complete and reconciled freight lines, and charges still assigned to that original supplier and shipment. A cancelled shipment, a prior successor, mixed/unmapped sources, partial ownership, malformed amounts, or any payment history requires explicit review. A voided payment does not erase payment history. This feature does not invent a recovery policy for those unsupported records.

The operator supplies a reason and the version read from current evidence. The command revalidates under the existing cost-graph lock and database transaction. Its durable command key returns the committed result after a lost response; a changed request or stale version cannot silently create another invoice. The client saves the exact intent in session storage before sending, retains it across reload after an unknown outcome, and retries with the same key.

The schema records an immutable predecessor reference, permits one successor per predecessor and one active invoice per supplier number, and reserves the original root identity. Generic invoice creation cannot silently reuse a voided number. Repeated void/replacement generations remain linked history. The original document is never restored by changing its status.

## Cost authority and audit

`recordShipmentCostRevisions` retains complete original and replacement documents in immutable source evidence. `resolveShipmentChargeEvidence` excludes a historical document from current authority only when it is a proven voided ancestor of the charge's currently assigned invoice, with the same supplier, invoice number, shipment and currency. Missing ancestors, cycles, competing successors, unrelated voided documents and conflicting headers remain review-required.

Received replacement lines do not establish approved cost authority. Existing independently finalized charge evidence can retain its authority under its existing rules; otherwise approval and exact amount reconciliation remain necessary. Existing source revisions and inventory/COGS history are preserved. This change does not automatically repair historical inventory values.

## Deployment and operator checks

The forward migration is staged as `migrations/pending/invoice_replacement_lineage.sql` until PR-based allocation. It adds lineage and guards, replaces the old unconditional supplier-number index with active/root indexes, and does not rewrite existing invoice or charge rows. Drain old AP writers, apply the allocated migration, then use the compatible application version. A database migration alone does not establish successful deployment or live acceptance.

For an eligible affected invoice, open its AP detail, review the recorded original, enter the recovery reason, and create the replacement. Follow the returned replacement link, correct the received document through its existing editor and review/approve normally. Inspect shipment cost status and cost-review results separately. If the request outcome is unknown, retry the saved request; do not create a new supplier number or manually unlink/delete evidence.

Keep lineage columns, indexes and history guards during rollback. Old application code does not understand replacement lineage or cost evidence; keep affected AP and cost writes paused until a compatible version is restored. Preserve the original attachments rather than copying multiple rows that share a deletable physical file.

## Remaining scope

Shared-invoice PO attribution (F19) remains separately reproduced: whole invoice totals and payment applications are repeated on each linked PO. No PO payment split was inferred here. F23 has partial coverage from the separately merged PO cost-review read/retry UI; shipment-detail reload and standalone finalize recovery still need their own correction. This batch does not close those findings or constitute full procurement acceptance.
