# Purchase order financial evidence and shared-invoice refresh

## Problem and scope

A vendor invoice can cover several purchase orders. The legacy `recomputePoFinancialAggregates` cache adds the whole invoice amount and whole invoice payments to every linked PO. Those fields are linked-invoice context, not a PO remittance ledger. In addition, link, unlink and line-import commands previously refreshed only the named PO after changing the shared invoice total.

This change refreshes every affected PO and adds a separate, read-only PO financial evidence view. It does not rewrite historical payments, change the legacy cache contract, or introduce a payment-allocation policy. It is a bounded correction to review finding F19, not closure of every financial lifecycle, aging or exception consumer.

## Execution path

1. `registerPoFinancialEvidenceRoutes` checks purchasing view permission and a positive PostgreSQL integer ID. Invalid IDs return 400; a missing PO returns 404.
2. `createPoFinancialEvidenceService.read` loads the source snapshot and invokes the pure domain projection.
3. `readPoFinancialEvidenceSource` uses one read-only, repeatable-read transaction. It reads the PO, every linked invoice, every relationship and line belonging to those invoices, and all payment-allocation history, including voided payments. Left joins retain incomplete ownership evidence rather than silently dropping it.
4. `buildPoFinancialEvidence` validates identities, vendor/currency, line ownership, exact amounts and completed payment evidence. It computes integer cents with BigInt and validates the response contract before returning it.
5. `PoFinancialEvidence` validates the API response and PO identity. Known amounts, unknown amounts, loading and failed reads have distinct rendering. The query uses the existing PO key prefix for mutation invalidation.

Database failures return a classified 503 and structured error metadata. They never return invented zero balances. Reading this endpoint does not update invoice, payment, PO or audit rows.

## Amount rules

- USD is the currently supported attribution currency. Other currencies require review, without conversion or fabricated amounts.
- Invoice lines must map to an existing, linked PO line owner with consistent vendor and currency. All mapped signed line amounts must conserve the nonnegative invoice header amount. A missing owner, freight ambiguity or residual header amount makes billing unknown.
- Signed line adjustments are retained. A negative net PO bucket requires settlement review; no credit-payment allocation is invented.
- Completed payment allocations must reconcile with the invoice's paid amount, balance and status. Voided payment history remains available but does not settle the invoice.
- Zero payment, complete settlement, or a sole nonzero PO owner can establish exact PO settlement. A partially paid invoice with multiple nonzero owners has known mapped billing but unknown PO paid and outstanding amounts.
- Optional invoice-link `allocatedAmountCents` remains recorded metadata. It is not used as authoritative billing or payment ownership.
- Voided invoices do not contribute current amounts. No active invoices produces zero current recorded amounts; that does not prove a PO is financially closed.

## Write correction

`linkPoToInvoice` and `importLinesFromPO` now recompute every linked PO within the existing AP transaction. `unlinkPoFromInvoice` recomputes the union of the removed PO and remaining linked POs. Audit events include affected PO IDs; post-commit detection runs for each affected PO.

A link command with neither optional metadata field supplied is a valid first call or retry. The existing invoice lock serializes lookup/insert/update. Omitted metadata is preserved, explicit zero is retained, and an empty Drizzle update is never emitted. Failure of the final transactional audit rolls back the invoice, relationships, imported lines, PO caches and status history together.

## Interface contract

The PO detail view displays evidence attributable to that PO. Linked-invoice and payment lists explicitly describe entire-invoice amounts. Cached financial status is labeled as recorded linked-invoice status. The purchasing list no longer derives a past-due warning from a fixed 30-day estimate of the first-invoiced timestamp; invoice aging remains owned by the existing AP detection path.

The workspace's nullable link amount is labeled recorded metadata. Operators can open the linked invoices to investigate incomplete attribution. No workflow asks an operator to invent a PO payment split.

## Release and recovery

No schema migration, data repair, worker drain or external email setup is required. Deploy the additive API and client changes together. Rollback restores the prior code; this change introduces no persistent format that needs reversal. Existing whole-invoice caches remain compatible.

After deployment, use a permitted read to verify a single-PO invoice, a shared unpaid invoice, and a shared partially paid invoice. Check a missing/failed evidence request and confirm that the UI offers reload rather than showing cached PO money. Local fixtures and browser mocks are not proof of live production data quality or deployment.

## Validation

Validation results are recorded in `PO-FINANCIAL-EVIDENCE-VALIDATION.md`. The PostgreSQL fixtures are disposable and local; no production financial records are changed. The invoice-void read case uses a canonical non-product fee path. Direct product-invoice void reconciliation is not exercised by this batch; that existing mutation path is unchanged.

## Follow-up consumers

The subsequent workflow and financial-alert correction is documented in `PO-FINANCIAL-FOLLOWUP.md`. It reuses this projection, adds batched reads and line-owned invoice discovery, and replaces selected cache-dependent consumers without rewriting legacy financial history.
