# Supplier credits and return accounting

## Baseline and scope

The original supplier-credit batch started at `00e18a2a07d4745adc131ed920be8af7a50e4791`, the tested PR1857 dependency. The operator reports deployment; GitHub reported PR1857 open at this review. Fetched `origin/main` was `356b9eaa1d54f340e8f037936ec26a8277a08011`. Neither the branch nor local tests establish production acceptance.

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
7. Accepted-stock supplier return has a separate inventory owner, described in the later-stage section below. Receipt correction cannot substitute for it. Supplier cash refunds, writeoffs and external journal posting are not implied by a recorded credit.

## Operator workflow

Open an approved invoice and choose **Supplier credit**, or open **Supplier credits** in purchasing. Select the original invoice and exact product, packaging or landed-cost component. A returned quarantine quantity must use its saved return disposition and collection evidence. Enter the supplier reference, calendar date, exact amount and reason, then review and approve.

Approval establishes the noncash document. Applying it reduces a same-supplier invoice balance; it does not record a cash payment. The document separately shows whether its inventory cost effect is posted, pending or requires review. A voided draft has no cost effect. Reverse each active application before voiding an approved credit. Replace a mistaken voided document through its explicit replacement action.

Unknown responses retain the submitted request and operator identity across reload. A successful receipt must match the command, actor, resource, request and economic result. A different operator cannot claim or clear that recovery request.

## Deployment and recovery

PR1861 allocates the approved SQL as `migrations/900000017000018610001_supplier_credit_completion.sql` using the repository allocation tool, with PR1857's graph-lock migration declared as its dependency. SQL content is unchanged, and the integration fixture uses the allocated filename. Apply the migration before the code reads the new tables or invoice credit column. This is an additive forward migration; it does not infer historical credits or rewrite invoice/cash amounts.

Credit source snapshots and original credited invoice economics are protected. A current source mismatch remains review-required. Original invoice metadata can remain descriptive; original quantities, prices, source links and component evidence cannot be silently repurposed to explain a credit.

## Explicit remaining boundaries

- Full quarantine returns are supported only under the exact no-inventory-effect proof described below. Accepted quantities, any relevant inventory history, prior product/packaging postings, open receiving work, incomplete custody, nonmatching credit values or changed source evidence remain review-required. Landed costs retain their separate owner; a fully credited goods line does not settle a freight charge.
- Accepted-stock returns use the separate physical collection and returned-value owners described below. Mixed or transformed lot lineage remains unsupported until its exact supplier provenance and conversion can be proved.
- A supplier cash refund, short-credit/writeoff difference, and external GL journal are separate operations. Recording or applying a credit does not assert that any of them occurred.
- Legacy negative freight charges remain retained source evidence. They are not automatically copied into new supplier credit entitlement; that would risk counting the same credit twice. Unsupported historical signed-charge posting still requires explicit source review.
- A mixed cash/credit shared invoice does not prove each PO's separate cash/credit share. Whole-invoice settlement remains available; ambiguous PO attribution remains visibly under review.

## Original supplier-credit batch validation

These results belong to the original supplier-credit batch. Later full-quarantine and accepted-stock return validation is recorded separately below.

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

The allocated SQL SHA-256 (Git-normalized LF content) is `592aa570b14b6160894b9968e1ee4a5c6f12adb720c76aa5faee56e5b4e707ab`, identical to the approved pending SQL. Allocation also preserves the working-file bytes (CRLF SHA-256 `9c8de61aae0ee0c182069b24c9d66618789ee080569a930aef65d086bfff7c64`). The metadata declares PR1857's `900000016000018570001_ap_payment_balance_completion.sql` graph-lock owner. Hosted CI and production acceptance remain separate from local validation.

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

## Full quarantine return correction

This correction starts from local merge `44782172fefe65731cfc4856437993b9513325f1`, incorporating supplier-credit dependency head `7a770574ce4e50dde93ae788c541e0780a786a3e` and fetched main `dd29f502fb89c6706847e8407cf53a2299fd263d`. The operator reports PR1861 deployed. These Git identities and local tests do not identify the running production release.

### Exact supported outcome

When every invoiced piece was held and returned before acceptance, and the approved supplier credits exactly cover its product and packaging source values, the source may explicitly have zero remaining pieces and zero remaining cost. It does not use a made-up unit denominator. Inventory independently proves that the line has no recognized receipt quantity, lot origin or associated legacy stock, physical movement or prior product/packaging cost posting, and that all related receiving work is closed or cancelled. The live invoice, credit and immutable return identities must match the saved source.

The source contract carries an explicit full-quarantine-return disposition. `inventory/application/apply-no-inventory-effect.ts::applyNoInventoryEffect` records a zero-effect application and reporting event only after `inventory/domain/no-inventory-effect.ts::proveNoInventoryEffect` succeeds. It does not allocate stock, update a lot, adjust sold COGS or change the supplier credit's settlement. Existing positive-quantity sources retain their original representation and fingerprints.

Current PO, shipment, receipt and supplier-credit projections revalidate that same proof. Their completion label is **Fully returned before acceptance; no inventory or sold-cost change**. Purchase history retains each original attempt and verifies its retained source/proof/reporting snapshot. A later approval never rewrites an earlier review attempt. Void or later contradictory evidence removes current completion while preserving the historical record.

### Recovery for existing approved credits

1. Resolve the actual held custody and close the receipt with zero accepted units.
2. Open the existing approved supplier credit. An authorized purchasing approver can use **Recheck cost disposition** when its current cost status still needs work.
3. Review the current evidence and submit a reason. The command checks current authority, source and version under the inventory graph and document locks. It appends audit/cost evidence; it does not change the credit amount/version, apply credit to an invoice, create a payment or repeat the return.
4. If evidence is still insufficient, the result remains review-required with its blocker. A successful command response does not imply successful cost completion. A response lost after commit retains the same actor-bound request/key for recovery.

The HTTP owner is `POST /api/supplier-credits/:id/reconcile_costs` with the existing expected-version/reason contract. Exact replay returns the retained receipt; changed actor, resource or payload cannot reuse its key. Stale evidence and revoked authority reject before side effects. Cost/report/audit failures roll the command back together. Counts and import mutations join the existing inventory graph fence so a no-stock proof cannot race a receipt count change.

No migration or historical backfill is required. No existing credit is automatically reapproved. Reporting payloads carry the explicit zero-effect proof; external delivery remains subject to the separately configured receiver's contract and acceptance, which local Echelon tests do not establish.

### Evidence and remaining work

The real PostgreSQL full-return case in `server/modules/procurement/__tests__/integration/supplier-credit-cost.cases.ts` exercises approval while receiving remains open, later completion of that same approved credit, late reporting failure/rollback, concurrent retries, an actual waiting receipt writer, legacy stock ambiguity, current evidence drift and void. It asserts unchanged physical inventory, sold cost, gross invoice and credit settlement. HTTP recovery tests exercise current permission revocation, stale and terminal documents, payload/key mismatch, exact replay and audit rollback. UI/render tests exercise the shared completion label and desktop/mobile recovery against mocked HTTP.

Accepted-stock supplier returns and credit differences are the next authorized stages. Their physical movement and loss/claim classifications are not implemented by this zero-effect correction.

Local correction validation: 4,721 unit/guard cases passed (seven existing database-dependent cases skipped); 103 focused client/contract cases also passed, with overlaps not added to the broad count. All 169 PostgreSQL cases across receiving cost application, supplier-credit commands and reporting passed. The two affected browser suites plus new recovery regressions cover 132 distinct desktop/mobile cases, with no skips or failures. Application, server-test, client-test and scoped browser TypeScript checks passed, as did the production build. PostgreSQL source tracking recorded a later test-comment-only change during the final two suites; their production code was unchanged. No hosted CI or production acceptance is claimed.

## Accepted-stock collections and credit differences

This later stage incorporates fetched main `0429b4ec02ddbf7eaf1c7953caae1982ff2d3d35` through local merge `3adf67d27` and adds a separate physical return record. It does not reinterpret the original accepted receipt as a receiving error. The first full-quarantine correction remains independently committed at `ce84c0254783f738b9ed96a3f891df35527d7fe4`.

### Physical collection authority

`inventory/application/supplier-return-stock.ts::executeSupplierReturnStock` admits the active quantity authority, takes the inventory graph fence and current location/level/lot locks, checks current purchasing approval, and verifies the reviewed source fingerprint. Only available, unreserved stock with an original receipt or proven one-to-one transfer lineage is eligible. The frozen lot unit conversion is used by preview and execution. Mixed/transformed provenance, missing cost allocation evidence, unapproved conversion drift, frozen locations and stale previews require review. New returns use approved effective origin conversions; their physical snapshot remains frozen after collection.

Procurement creates the immutable supplier collection header and source lines only after those locks. Inventory owns the physical decrease, exact cost-quantity allocation and three initial returned-value entries. The receipt, original PO received quantity, invoice and retained lot cost basis remain historical facts. A returned unit cannot also be allocated to sale or another return. The collection, stock posting, cost entries, physical reporting evidence, audit event, durable command response and availability follow-up commit together. An unavailable publication owner leaves retryable work for the existing inventory-change publication path.

The collection requires its supplier, calendar date, evidence reference, reason and explicit lot quantities. A supplier RMA/reference is optional; it is not used as a substitute for the durable command key. Exact replay retains the original response. Unknown database, transport or evidence failures retain recovery; only classified input/authority/source refusals issue a terminal rejection.

`receipt-reversal.service.ts` reads retained supplier-return lineage under the same graph lock before a new reversal. A source line with returned stock cannot be reversed. The whole receipt is blocked if any of its sources has a return; other individual lines retain their existing reversal path. The receiving screen consumes the same per-line and whole-receipt capability. A saved reversal response remains recoverable. Receipt/shipment conversion corrections include existing return history in their reviewed source and refuse to reinterpret a PO line after a recorded collection; returned goods cannot acquire a different physical piece count through that separate command.

### Returned value and credit ownership

Returned value stays in an immutable inventory-owned component ledger. Later product, packaging or landed-cost revisions append the exact difference for the original returned intervals. The original cost basis is preserved, and returned value is accounted for separately from retained stock and sold COGS. Cost application reporting includes those returned-value adjustments with their retained entry identities. PO quantity-amendment previews and approved history show the actual returned-value changes alongside inventory and sold COGS. Preview identity uses stable collection/allocation identities and exact before/after values; generated posting IDs remain in the committed application evidence because preview savepoints roll back.

An `accepted_stock_return` supplier credit links money to an already recorded physical return. It does not reduce the gross purchase cost source or remove stock again. Immutable quantity entitlements identify a specific returned slice once; product and packaging lines on one reviewed note may share that slice. A later short-credit top-up or replacement explicitly selects the existing entitlement. An independent competing draft cannot silently join another approved entitlement. Voiding a credit preserves the return and its quantity entitlement.

Goods and freight credits require their corresponding approved source invoice and supplier/receipt lineage. A combined goods note may retain an unassigned component amount until the operator records an exact product/packaging attribution. The attribution must sum to the original note amount; this review cannot turn goods credit into unsupported freight reimbursement.

### Difference review and limits

`GET /api/supplier-return-entitlements/:id/review` projects current returned component values, actual credit links, differences and retained reviews. The corresponding durable POST appends an operator's evidence and exact attribution under current authority and the inventory graph fence. Its version binds the returned value entries, active credit notes and prior review. Late cost, void or top-up makes an earlier review stale; original review history remains visible.

The available dispositions are attribution only, awaiting supplier note and supplier declined. None writes off an amount or creates a receivable. A financially unresolved difference stays unresolved even after the supplier declines it. The codebase provides no verified supplier-return loss/claim posting destination to invoke in this stage. An actual expense/write-off, reimbursement claim, cash refund or external GL journal requires its own approved accounting owner and policy; no such event is inferred from review evidence.

### Local validation state

Validation for this later stage is in progress. New command/API and domain tests are passing, and initial desktop/mobile accepted-stock return/reversal cases have passed. Real PostgreSQL acceptance, affected-suite regression, final typechecks and the build must complete before this stage is declared ready. The SQL remains in `migrations/pending/supplier_return_completion.sql` until a real PR migration ID can be allocated. It has not been applied to production. Local checks, hosted CI, merge and production acceptance remain separate.
