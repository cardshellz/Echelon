# Current PO financial follow-up and invoice alerts

## Scope and evidence

This follows PR #1806 on main `c68a6a9a32547029fa8a39308a9b66d5ca6304cf`. It corrects consumers of legacy PO financial caches. It does not change the stored aggregate contract, rewrite historical payments or infer a shared invoice payment split. This is a bounded continuation of F19, not closure of the entire procurement review.

The previous `fetchAutoDraftPoAgingRows` filtered cached-paid closed POs before reading evidence and limited the scan to 500 rows. `buildPoAutoDraftActionPlan` used that cached status for AP completion. `detectPastDue` derived a deadline from a PO timestamp and current vendor terms; elapsed days participated in its payload hash. The old financial detectors returned when their condition stopped being true, leaving earlier alerts active. These paths are replaced below.

## Source and decision trace

1. `po-financial-evidence.repository.ts::readPoFinancialEvidenceSourcesWithClient` reads all requested POs, invoice header relationships, invoice associations proved by owned PO lines, and the complete relationship/line/payment footprint of each discovered invoice. A missing header link is retained as broken evidence, not treated as an unbilled PO. Duplicate actual relationships remain visible to validation. There are at most six source queries per batch.
2. `domain/po-financial-evidence.ts::buildPoFinancialEvidence` remains the exact-money and ownership projection. Its extracted `validatePoFinancialInvoiceFootprint` shares ownership/conservation validation with the invoice alert evaluator.
3. `domain/po-financial-workflow.ts::buildPoFinancialWorkflow` supplements exact evidence with active invoice approval/dispute/status. No active invoice means unbilled; received invoices require approval; disputes and ambiguous amounts require review; approved open invoices with known positive outstanding amounts require payment follow-up. Settled requires complete evidence, at least one active invoice, zero outstanding cents and every active invoice recorded paid. Approved zero-value documents still require explicit invoice closeout.
4. `auto-draft-po-aging.repository.ts::fetchAutoDraftPoAgingRows` traverses candidates by primary key in one read-only repeatable-read transaction. Page size bounds each query, not the total result. Raw PostgreSQL bigint cents are validated before conversion to safe integer cents. Closed rows are omitted only when physical completion, verified settlement and no open exceptions agree. Cancelled rows are omitted only when current evidence is unbilled or settled and no open exception remains. A cancelled PO with debt remains financially actionable without reopening physical work.
5. `purchase-order-lifecycle.service.ts::buildPoAutoDraftActionPlan` consumes the validated workflow assessment. Missing or inconsistent financial evidence requires review; cached paid never establishes completion. Existing physical progression and authorization stay with their existing owners.
6. `purchase-order.routes.ts::registerPurchaseOrderRoutes` includes the validated workflow in detail responses and action plans. Missing or failed evidence cannot produce a successful cached financial plan. The stale-PO route, health summary and escalation reader reuse the same snapshot reader; health diagnostics receive their caller's `asOf`.

The queue scans all candidates to avoid silently losing old unresolved work. Production cardinality, latency and global cost-graph lock contention have not been measured. The PostgreSQL regression traverses 501 settled candidates before finding an older unresolved PO; that is correctness evidence, not a production capacity benchmark.

## One invoice payment owner

`PurchaseOrderDetail.tsx` links financial follow-up to the invoices tab, where actual linked invoice records lead to `APInvoiceDetail.tsx`. The duplicate PO payment dialog, mutation and automatic selection of the first positive invoice balance are removed. AP invoice approval/payment permissions, eligibility, idempotency and recovery retain their existing owner. Add invoice remains available from the invoices tab under the existing creation permission and allowed PO states, independently of cached financial status.

Completion and financial guidance are withheld while required reads are pending, failed, malformed, mismatched to the PO or contradictory. Reload retries the required reads. The dashboard distinguishes recorded status from current financial review and sends AP follow-up directly to the invoices tab. Browser acceptance uses controlled HTTP fixtures; it does not establish production API behavior.

## Financial alert synchronization

`po-exceptions.service.ts::detectFinancialExceptions` delegates to `po-financial-exceptions.service.ts::createPoFinancialExceptionService().synchronize`. AP post-commit hooks call this owner once per affected PO. Existing physical-transition/cancellation hooks continue calling the past-due wrapper. This adds no scheduled sweep or external notification action.

The repository takes the canonical inventory-cost graph lock, then PO and exception row locks, in one read-committed transaction. It reads the canonical financial source plus invoice number/due date through that same transaction. `domain/po-financial-exceptions.ts::evaluatePoFinancialExceptions` is pure with an injected `asOf`.

Alerts describe the **entire linked invoice**, not a fabricated PO payment share. Completed allocations must reconcile with the invoice amount, paid balance and status. A verified legacy excess payment may produce an overpayment alert; inconsistent or malformed sources produce an unknown outcome. Actual invoice due dates are compared by UTC calendar date: the due date itself is not overdue. Missing due dates cannot clear an uncertain past-due alert. Current vendor terms and legacy first-invoiced/paid stamps do not establish a deadline or payment.

Alert identity is stable for PO, kind and invoice. Source fingerprints include financial evidence but exclude elapsed age and observation time. Repeated reads on later days leave an unchanged alert and audit unchanged. Changed source evidence retires the owned active alert and, when needed, creates a replacement. Unchanged manual resolutions/dismissals of invoice-owned alerts remain terminal. Historical terminal aggregate alerts also remain untouched, but their payload lacks invoice identity; they cannot suppress a newly verified invoice-specific alert. Recognized legacy system aggregate alerts are retired only after complete current evidence permits evaluation. Uncertain sources preserve existing alerts and emit structured diagnostics.

Every create/retire writes PO status history and an audit event in the same transaction. The audit records before/after exception state, the decision reason, observation time and verified invoice evidence. Failure of the final audit rolls back the exception and status history. Unlinking is recorded as loss of PO association, not a claim that the supplier debt was paid.

## Failure and recovery behavior

| Trigger | Result |
| --- | --- |
| Missing invoice/PO link, invalid money or ownership | Review or failed read; never invented zero/completed state |
| Shared partial payment | PO settlement stays unknown; linked invoice remains reachable |
| Cancelled PO with invoice debt | Physical cancellation preserved; AP follow-up remains visible |
| Due date missing/invalid or source inconsistent | Existing uncertain alerts retained with diagnostics |
| Repeated or concurrent detector call | Same unchanged active alert and history; graph/row locks serialize writes |
| Payment, payment void, invoice void, unlink or changed debt | Current verified condition synchronized with append-only transition evidence |
| Final audit insert fails | Transaction rollback; prior alert/history state preserved |
| Browser detail/evidence refresh fails or conflicts | Completion withheld; explicit reload and linked invoice review |
| Detector fails after an AP command commits | Existing best-effort hook logs failure; the committed financial command is not undone |

## Release, limits and retained work

No schema migration or historical repair is included. Deploy the API and client together. Existing legacy cache fields and timestamps remain compatible and are not backfilled. The new system alert payloads use an explicit owner marker; rollback does not erase their audit history. Rolling back detector code can resume the old duplicate/uncleared-alert behavior, so inspect retained alerts before any manual repair.

No production database, payment provider, queue, email transport or notification job was operated during this work. PR #1806 deployment is user-confirmed; independent live acceptance remains unverified. After deployment, inspect permitted examples of approval required, shared partial payment, settled, cancelled with debt and missing linkage, plus failed/refreshed reads. Confirm new alert history on an authorized subsequent financial command; deployment alone does not resynchronize every historical PO.

Still separate: legacy persisted financial totals/status/timestamps, manual financial transition authority, broader header/line mutation guards, cancellation-button visibility, historical repair, and a due-date scheduler/recovery sweep. Existing post-commit alert failures remain best-effort; no durable retry queue is added. The projection checks recorded payment applications, not bank settlement or payment-header conservation across unrelated invoices. These limits prevent claiming full F19 or whole-system completion.

See `PO-FINANCIAL-FOLLOWUP-VALIDATION.md` for actual validation results and release state.
