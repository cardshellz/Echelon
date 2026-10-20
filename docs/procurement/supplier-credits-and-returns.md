# Supplier credits and return accounting

## Baseline and scope

Implementation starts at `00e18a2a07d4745adc131ed920be8af7a50e4791`, the tested PR1857 dependency. The operator reports deployment; GitHub reported PR1857 open at this review. Fetched `origin/main` was `356b9eaa1d54f340e8f037936ec26a8277a08011`. Neither the branch nor local tests establish production acceptance.

## Confirmed owners

- `ap-ledger.service.ts::recalculateInvoiceBalance` and `domain/invoice-financial-state.ts::deriveInvoiceFinancialState` previously derive payable balances exclusively from completed cash allocations. `domain/po-financial-evidence.ts::readSettlement` independently checks that equation. Supplier credit must be separate noncash settlement evidence, with gross invoice and cash paid preserved.
- `receiving-quarantine.service.ts::executeReceivingCustodyCommand` appends immutable physical return evidence for pending-recognition custody. It does not create a supplier entitlement, payable adjustment or inventory movement.
- `receipt-reversal.service.ts::applyLineReversal` corrects receipt and PO received authority. It is not a supplier collection document or a return of arbitrary moved/converted accepted stock.
- `domain/purchase-cost-source.ts::resolvePurchaseCostSource` and `shipment-cost-application.service.ts::prepareShipmentCostRevisions` derive inventory source evidence. Unsupported signed adjustments remain review-required. `inventory/application/apply-cost-revision.ts` owns exact inventory and sold COGS changes and protects nonnegative component balances.

## Implementation invariants

1. An explicit supplier-issued credit references one approved source invoice and positive exact-cent source lines. It never alters that invoice's gross amount or inserts a negative cash payment.
2. Draft, approval, application, application reversal and void preserve immutable history. Current authority, reviewed versions, same-vendor currency ownership, exact available credit and invoice balance are rechecked under transaction locks.
3. Cash paid, credit applied and remaining payable are distinct across invoice, PO, shipment and AP projections. Retried ambiguous commands retain actor, request, resource and key; malformed responses cannot establish success.
4. A voided credit can be replaced explicitly using the same supplier reference. Both documents and their predecessor/successor relationship remain visible; duplicate active references are rejected.
5. Credit source effects remain separate from liability settlement. Supported price reductions produce source revisions through the existing inventory/COGS owner; unsupported or insufficient evidence remains explicit review work.
6. Linking or voiding a credit never repeats or reverses physical return movement. Quarantine credit references must prove source ownership and cumulative quantity. Unknown custody cannot be assigned a supplier by inference.
7. Accepted-stock supplier return is a separate remaining inventory capability. Receipt correction cannot substitute for it. Supplier cash refunds, writeoffs and external journal posting are not implied by a recorded credit.

## Operator workflow

Open an approved invoice and choose **Supplier credit**, or open **Supplier credits** in purchasing. Select the original invoice and exact product, packaging or landed-cost component. A returned quarantine quantity must use its saved return disposition and collection evidence. Enter the supplier reference, calendar date, exact amount and reason, then review and approve.

Approval establishes the noncash document. Applying it reduces a same-supplier invoice balance; it does not record a cash payment. The document separately shows whether its inventory cost effect is posted, pending or requires review. A voided draft has no cost effect. Reverse each active application before voiding an approved credit. Replace a mistaken voided document through its explicit replacement action.

Unknown responses retain the submitted request and operator identity across reload. A successful receipt must match the command, actor, resource, request and economic result. A different operator cannot claim or clear that recovery request.

## Deployment and recovery

The pending SQL is an allocation artifact for the repository's PR-based migration numbering. It must be moved into `migrations/` using the repository allocation tool before publication is complete; SQL content must remain identical and test/runbook references must follow the final filename. Apply the migration before the code reads the new tables or invoice credit column. This is an additive forward migration; it does not infer historical credits or rewrite invoice/cash amounts.

Credit source snapshots and original credited invoice economics are protected. A current source mismatch remains review-required. Original invoice metadata can remain descriptive; original quantities, prices, source links and component evidence cannot be silently repurposed to explain a credit.

## Explicit remaining boundaries

- An exact quarantine return credit covering every invoiced unit has zero remaining source quantity. The inventory cost contract requires a positive denominator, so this case remains `CREDIT_FULL_QUARANTINE_RETURN_COST_REVIEW`; it does not post stock or sold-cost adjustments, claim completion, or offer an automatic retry. Retain the physical return and credit evidence for an explicit zero-quantity accounting disposition. A financial credit can still be approved and applied independently; that does not establish inventory cost completion.
- Returning already accepted stock needs its own physical return owner for lot/variant/location movements and the corresponding financial disposition. This batch supports immutable pending-recognition quarantine returns only.
- A supplier cash refund, short-credit/writeoff difference, and external GL journal are separate operations. Recording or applying a credit does not assert that any of them occurred.
- Legacy negative freight charges remain retained source evidence. They are not automatically copied into new supplier credit entitlement; that would risk counting the same credit twice. Unsupported historical signed-charge posting still requires explicit source review.
- A mixed cash/credit shared invoice does not prove each PO's separate cash/credit share. Whole-invoice settlement remains available; ambiguous PO attribution remains visibly under review.

## Validation ledger

The bounded supplier-credit implementation is locally validated. The remaining return-accounting capabilities above are not claimed complete.

| Validation | Result |
| --- | --- |
| Procurement unit suite | 4,085 passed; seven pre-existing database-dependent unit cases skipped |
| Client command/navigation/read helpers | 196 passed |
| CI registration, migration and typecheck guards | 207 passed |
| Actual disposable PostgreSQL | 749 distinct cases across 23 suites passed |
| Desktop/mobile browser | 262 distinct cases across seven files passed; no remaining failures or skips |
| TypeScript | Application, server tests, client tests and the affected strict browser configuration passed |
| Build | Client and server production build passed |

Repeated runs are not added to the case totals. The PostgreSQL and browser ledgers retain the latest executed result for each case. The final return test corrected only the expected representation of raw PostgreSQL bigint values; its complete custody, credit, inventory and COGS assertions passed on the targeted rerun. All other receiving/cost cases had passed on the frozen product code. Browser tests exercise the actual client against mocked HTTP; PostgreSQL tests exercise real owners, transactions, permissions and migrations in freshly created disposable databases.

Independent financial, cost-source and client reviews were completed. Confirmed issues corrected during validation included legacy payment error compatibility, immutable invoice source history, invoice-to-credit navigation, actor-bound recovery, historical settlement display and full-return review guidance. No historical credit, loss, refund or cost attribution was inferred.

The tested pending SQL SHA-256 (Git-normalized LF content) is `592aa570b14b6160894b9968e1ee4a5c6f12adb720c76aa5faee56e5b4e707ab`. Its allocation into the PR migration identity must preserve those bytes. It depends on PR1857's `900000016000018570001_ap_payment_balance_completion.sql` graph-lock owner. Migration allocation and hosted CI remain publication steps.

Local evidence reports are `verified-unit.json`, `verified-guards.json`, `pg-case-ledger.json`, `client-validation.json` and `browser-case-ledger.json` in the task's supplier-credit output directory. They are validation artifacts, not production data or repository migrations.

Covered failure modes and invariants:

- Exact-cent draft/approval/apply/reversal/void; unchanged original invoices and cash records.
- Over-credit, overapplication, stale source, cross-vendor, inactive/revoked authority and unknown-source rejection.
- Credit versus payment races, repeated request, changed request with same key, rollback and lost-response recovery.
- Quarantine disposition linkage, cumulative credited quantities and no repeated physical movement.
- Product/packaging/landed source effects where supported; inventory and sold COGS conservation, over-credit and unsupported evidence review.
- Invoice, PO, shipment, aging, work list and detail agreement; desktop/mobile recovery and explicit cost status.
- Real PostgreSQL migration constraints and immutable audit history; affected existing fixture suites; typechecks and build.

No production data repair, financial transfer, merge or deployment is part of local validation.
