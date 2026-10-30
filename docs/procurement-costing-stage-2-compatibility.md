# Stage 2: preserve unchanged recorded cost authority

Tracker: [purchase costing cleanup](procurement-costing-cleanup-plan.md). This is the first S2 integration slice, addressing audit F5 while the S1 receipt-allocation and supplier-tax policy answers remain pending. It reuses the existing source revision, application, reporting and status owners. It does not activate partial-invoice posting, invent a component split, rehash historical records or change recognized COGS behavior.

## Concrete defect and corrected behavior

The trace in [F5](procurement-costing-authority-audit-2026-10-30.md#f5--p1-settlement-only-changes-can-invalidate-unchanged-shipping-costs) identified two non-economic changes entering immutable cost fingerprints:

- Supplier source recording retained the entire PO quote after a complete approved invoice became authoritative. Changing only that unused quote produced a new fingerprint and made the prior application appear outdated.
- Shipment proposals retained raw invoice status in captured rows and invoice-line reference versions. Approved → partially paid → paid changed the fingerprint despite the same billed amount, quantity, currency, charge, allocation and cost authority.
- Closed-shipment health tests exposed another copy of PO price in the shipment snapshot/reference hashes, including volume, weight and line-count allocation. Those methods do not consume PO price, but a quote edit still made the shipment appear outdated. Four failing unit cases and the actual health warning reproduced it before the method-aware proof was added.

The new comparison proves equivalence before returning the original immutable proposal. The source recorder therefore reuses the same revision ID, contract, fingerprint and recorded evidence. The existing application owner can replay its existing application. Shared status readers use that same comparison, so they do not independently declare unchanged costs outdated.

| Event | Financial change that still happens | Cost records that remain unchanged when the proof succeeds |
| --- | --- | --- |
| An agreed PO quote changes after a full invoice replaced it | The edited PO values remain saved by their owner | The selected supplier cost and its original source revision/application/reporting/approval evidence |
| Pay $20 against a $50 freight invoice | AP records cash and changes the invoice to partially paid with a $30 balance | The $50 shipment cost, allocated share, inventory value and original posting |
| Pay the remaining $30 | AP records the second payment and a zero invoice balance | The same original $50 cost posting; payment does not create another charge or approval |
| Change the actual invoice amount or currency | The current source no longer matches the saved financial facts | No equivalence is accepted; the existing current-source/review and revision paths remain active |
| A lot's cost differs from its recorded application | The mismatch remains a real inventory-cost problem | Source equivalence does not suppress graph, component, reporting or history checks |

These are synthetic regression cases, not a statement about any live PO's current amounts.

## Source proof, step by step

1. [`verifiedStoredCostSource`](../server/modules/procurement/domain/cost-source-compatibility.ts) validates the saved contract and compares its fingerprint with both the stored fingerprint column and a fresh hash of the exact original input/evidence. Damaged or non-JSON captured evidence cannot establish equivalence.
2. [`retainEquivalentPurchaseCostSource`](../server/modules/procurement/domain/purchase-cost-source-identity.ts) supports fully confirmed USD product/packaging inputs only. It refuses provisional or partial sources, missing/unsupported component evidence, nonzero adjustments, manual overrides, actual supplier-credit effects and zero-inventory-effect dispositions. Those retain their existing owners and checks.
3. The supplier proof regenerates the legacy component contract from the captured rows and requires an exact match. It then maps the same invoice quantities and known components into [`projectPurchaseCostAuthority`](../server/modules/procurement/domain/purchase-cost-authority.ts), the S1 model, and verifies the selected component amount and economic identity.
4. No provisional quote amount is selected in this fully covered proof. Known quote quantity/status/price fields that no longer determine the selected invoice cost are excluded from comparison only after the regenerated scope and quantity denominator agree. PO IDs, line type, currency and unknown fields remain significant.
5. Historical aggregate multi-invoice postings can be compared without selecting a new receipt-allocation policy. The comparison preserves an existing monetary source; it does not assign actual costs to a different receipt or lot. New partial coverage/allocation remains deferred pending the policy and complete S2 adapter.
6. [`isApprovedCostInvoiceStatus`](../shared/procurement/purchase-cost-authority.ts) defines the common approved settlement class used by the S1 selection and compatibility proof. [`retainEquivalentShipmentCostSource`](../server/modules/procurement/shipment-cost-source-identity.ts) normalizes that class plus the already-supported absent/null product links, recomputing invoice reference versions from the exact captured rows.
7. [`normalizeUnselectedShipmentQuote`](../server/modules/procurement/domain/shipment-cost-selected-inputs.ts) proves the saved shipment/PO/line relationships, complete charge references, their exact original signatures and the selected allocation methods. Only then does it omit PO price/quantity/currency inputs that the physical/count methods do not consume. By-value allocation keeps those inputs significant. Charge amounts, actual allocations, applicable physical evidence, selected methods, issues, unknown fields and financial source links remain compared.
8. If comparison fails, the current proposal is kept. A real source change, unsupported evidence or a damaged saved record is never silently replaced by the old approval.

The comparison never overwrites the old captured status with a new status. The AP invoice itself shows the current settlement state; the immutable costing source retains the original state that was captured when posted.

## Connected owners

| Existing owner | Integration |
| --- | --- |
| [`recordCostRevision`](../server/modules/procurement/cost-source-revision.repository.ts) | Reads the original evidence with the latest component revision under the existing graph lock. An exact original-hash match follows the existing fast path; a proved equivalent supplier proposal returns that same revision rather than inserting another. |
| [`readPurchaseCostStatus`](../server/modules/procurement/purchase-cost-status.repository.ts) | Uses the same supplier comparison before evaluating currentness and reporting evidence. It retains the original application IDs, actor/time and reporting fingerprint while still checking current lots and their actual values. |
| [`buildShipmentCostRevisionProposals`](../server/modules/procurement/shipment-cost-revision-proposals.ts) | Already shared by shipment read and write preparation; its existing compatibility call now recognizes approved settlement progress. |
| [`reconcilePurchaseCostEvidence`](../server/modules/procurement/purchase-cost-application.service.ts) and [`applyShipmentCostRevisions`](../server/modules/procurement/shipment-cost-application.service.ts) | Existing financial application owners remain unchanged. No alternate writer, financial backfill or posting bypass was introduced. |
| PO/shipment/receipt/health readers | Existing readers that consume these shared status/proposal owners inherit the same financial-currentness result. Other independent monetary projections and DTO gaps from F1/F9 are still open for S4. |

The stored legacy fingerprint format is unchanged. Compatibility is proved against normalized facts, then the exact old contract/evidence is reused. Comparing a new hash format with an old fingerprint is not treated as an economic change.

## Validation and remaining limits

Unit proof cases are in [`purchase-cost-source-identity.test.ts`](../server/modules/procurement/__tests__/unit/purchase-cost-source-identity.test.ts) and [`shipment-cost-source-identity.test.ts`](../server/modules/procurement/__tests__/unit/shipment-cost-source-identity.test.ts). They cover unused quotes, still-used denominators, approved payment states, changed source amounts/links/currencies, missing components, unknown fields, zero amounts, malformed saved records and unsupported credit evidence.

[`cost-source-compatibility.cases.ts`](../server/modules/procurement/__tests__/integration/cost-source-compatibility.cases.ts) runs inside the existing [`receiving-cost-application.integration.test.ts`](../server/modules/procurement/__tests__/integration/receiving-cost-application.integration.test.ts) fixture with real PostgreSQL tables, migrations and owners. It adds AP payment tables and calls the actual AP payment owner for the partially-paid/paid transitions. It checks PO/shipment/shared status and health, repeated and concurrent supplier retries, genuine invoice changes, immutable source/application/reporting records and real lot/currency exceptions. Cost and physical rows are compared before/after; no query result or financial writer is mocked.

The full receipt/AP/freight suite also exercises receipts, exact costing, transfers/repacking, credits, returns, historical approvals, concurrent commands, idempotent retries and rollback failures. The final local candidate passed 558 focused tests, 50 related reader/cache tests, all 259 PostgreSQL cases, 455 guards and production/server-test TypeScript. The main tracker records commands, code head and hosted check results. Local tests use a newly initialized loopback-only disposable PostgreSQL cluster, never a live database.

Limits remain explicit:

- This slice does not connect every financial mutation to a reviewed cost preview; F3/F4/F8 remain open in S2.
- It does not choose the pending receipt-allocation or tax policies, migrate unknown supplier breakdowns, or activate new partial-invoice posting.
- It does not correct F6's descendant/inheritance completion rule or suppress real lot-history/value issues.
- It does not replace competing displayed monetary totals or complete F9's DTO/action navigation changes.
- It does not change ordinary order-cost basis, external accounting recognition or historical COGS/expense postings.
- A local SQL suite is not deployed/live acceptance or an HTTP/browser authorization test. S5/S6 remain required for the complete cleanup.

Before activation of the broader source-selection model, S2 must still prove the stored representation, financial command/preview binding, durable recovery, credit/header allocations and the appropriate verified-sale reporting boundary.
