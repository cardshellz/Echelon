# AP financial history safeguards

Generic invoice edits, line changes, PO links/imports and shipment charge links require an invoice in received or disputed state with no approval marker, recorded paid amount or payment allocation history. A voided payment remains history. The shared edit policy is projected in invoice detail and checked again under the cost-graph and invoice locks at mutation time. UI capabilities are advisory; HTTP permission middleware and the locked owner checks remain authoritative.

The reviewed invoice quantity correction and cost-component review remain separate owners. They retain their permission, source-version, financial reconciliation and audit requirements. Attachment evidence and match refresh are still available to authorized editors; blocking generic financial edits does not delete records or invent credit corrections.

Record payment means a completed payment. An omitted status defaults to completed; any other supplied status is rejected. Settlement aggregation counts only completed payments. Voided payments remain visible in history but do not settle balances. Unsupported historical payment statuses remain recorded and require review: invoice balance recalculation, voiding that payment and reviewed economic correction reject them instead of rewriting history.

Disputed balances remain outstanding and appear in aging. The dashboard separately labels the disputed amount and count as on hold for review. Disputed invoices remain ineligible for payment allocation.

## Migration 0751 and preflight

Run these read-only checks in the intended environment before rollout. Record counts and affected record IDs securely; do not publish vendor/payment details in CI logs.

```sql
SELECT status, COUNT(*) AS payment_count
FROM procurement.ap_payments
GROUP BY status ORDER BY status;

SELECT p.id AS payment_id, p.status, a.vendor_invoice_id
FROM procurement.ap_payments p
LEFT JOIN procurement.ap_payment_allocations a ON a.ap_payment_id = p.id
WHERE p.status NOT IN ('completed', 'voided')
ORDER BY p.id, a.vendor_invoice_id;

SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = 'procurement.ap_payments'::regclass
  AND conname = 'ap_payments_recorded_status_check';
```

Migration 0751 adds a `NOT VALID` check permitting completed and voided statuses. PostgreSQL enforces it on new and updated payment rows while leaving existing unsupported rows intact. It performs no payment, allocation, invoice or balance updates. Do not validate the constraint or relabel legacy statuses merely to make validation pass. Each legacy exception needs an explicitly reviewed owning correction based on its evidence; that workflow is outside this protective batch.

Deploy the service and UI together. The UI fails closed for generic editing if its server capability is absent or malformed. A denied stale edit refreshes invoice data and disables resubmission while preserving the draft on screen. Existing durable payment command receipts retain their replay behavior; this change does not claim durable receipts for legacy generic edit routes.

## Scope and verification limits

The PostgreSQL regression suite installs the actual 0620 money-precision migration and 0751 status check, actual participating table column definitions, relevant foreign keys and unique indexes. It verifies approved/disputed history across every generic edit owner, paid/disputed deletion and amount reduction, voided payment history, unsupported-state rollback, disputed summaries and concurrent payment/dispute/edit requests. It does not install the complete production schema or reconstruct missing historical approval markers.

Shared multi-PO attribution, charge unlink/rebilling, credits and date-only display contracts remain separate corrective batches. Existing recorded balances with unsupported historical payment states may differ from completed-only settlement summaries until their evidence receives explicit review. No repair is automatic.
