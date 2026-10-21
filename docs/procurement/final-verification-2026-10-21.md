# Procurement deployed verification and CSV recovery follow-up

## Release identity

PR1883 merged as `1facd7375a42fddf71edda767e78c9ce91b5e6b0` on October 21, 2026. GitHub deployment 7238566698 records successful Heroku deployment of that exact merge. The final PR head had 57 successful checks and two failed checks: one procurement browser shard and its dependent aggregate gate. Deployment is therefore not evidence that all PR checks passed.

The failed case was `procurement-receiving-import.spec.ts`, "receiving duplicate CSV rejection preserves rows and permits an explicit corrected retry," in [browser job 119489622769](https://github.com/cardshellz/Echelon/actions/runs/39677000401/job/119489622769). The shard passed 155 other cases. Its trace shows the error toast intercepting the corrected Import click for approximately five seconds; no second import request reached the mocked endpoint. This was not a workflow timeout.

Postmerge [Core CI 39684925725](https://github.com/cardshellz/Echelon/actions/runs/39684925725) subsequently completed successfully: all 19 jobs passed on the exact merge. This does not erase the separate browser regression above.

## Confirmed trace and bounded correction

`Receiving.tsx::bulkImportMutation.onError` displayed the same error in the persistent CSV dialog and a destructive toast. The toast viewport's z100 placement can cover the z50 dialog's Import action. The trace establishes that obstruction; it does not establish every browser event detail behind the final swallowed click or a production stock-posting failure.

The CSV workflow now keeps parsing and request failures inline, and partial results in the existing result dialog. Successful complete imports retain the completion notification after closing the dialog. The recovery path preserves the submitted CSV, binds drafts to their exact receipt, and protects pending work from dismissal or replacement. Drafts remain in memory within the Receiving page; full reload or leaving that page does not provide durable draft storage. Existing receipt-visit guards continue to reject late responses after navigation. No server quantity, inventory, custody, financial, or migration contract changes are required.

## Deployed readback

Read-only inspection used the existing administrator session. The sampled closed receipt, original PO and shipment agree on accepted quantities, and the PO receiving picker identifies that shipment as already received. The original multi-PO shipment displays recorded receive-unit multiplication separately from physical cartons and explicitly identifies its missing legacy receive-unit evidence.

A sampled reconciled shipment, its linked PO and the shipment overview agree that landed costs are posted while separate supplier product/packaging evidence remains unresolved. The PO explicitly distinguishes already-posted estimated charges from supplier confirmation. AP invoice and PO totals, cash and outstanding amounts agree for the sampled source. Navigation retains the original receipt or shipment return context.

RFQ, supplier-credit and supplier-return work lists load, but the unfiltered views supply no saved records with which to demonstrate their production command/recovery paths. The sampled receipt's custody view is empty; receipt headers have no custody counts and no global custody work list establishes population-wide absence. Real PostgreSQL lifecycle, permission and concurrency tests remain separate evidence from these live reads.

Other saved shipments still show cost exceptions, including allocation blockers and missing historical evidence. These require record-specific adjudication; this pass neither clears warnings nor infers missing values. Private record identifiers and amounts are retained only in local acceptance notes.

## Validation

The duplicate-error and cross-receipt-draft regressions both fail against the deployed baseline for their intended defects. With the correction, all 40 desktop/mobile CSV-import and procurement-navigation browser cases pass, along with 32 parser/result/navigation unit cases. Tests cover immediate corrected retry, exact request bodies/counts, partial results, malformed responses, strict CSV parsing, pending close/Escape/outside-click attempts, receipt-specific draft preservation, late callbacks, delayed file reads and file read errors/exceptions. Browser responses are mocked; these are UI/recovery tests, not another inventory-posting certification.

Application, client-test and affected-browser TypeScript checks and the production build passed. Before publication the branch fast-forwarded to fetched main `5423f956f0bf2ba4934252f043367f2e9a141a93` (unrelated eBay recovery PR1884); all three typechecks and the build passed again. The tested CSV component, browser spec and direct procurement dependencies were unchanged by that update. No server or SQL behavior changed in this patch; the earlier real-PostgreSQL acceptance evidence is unchanged and is not counted as a fresh database run for this UI patch. Independent review found no remaining actionable defect in the final diff.

## Remaining work and limits

The planned corrective feature batches and controlled combined lifecycle acceptance are complete. This locally validated CSV follow-up still requires hosted checks, release and deployed verification. Postmerge checks are tracked independently from PR and deployment status.

An administrator readback does not certify deployed non-admin grants, every historical record, or every migration. No production test receipt, stock adjustment, custody resolution, payment, supplier message or historical repair was performed. Active quantity-ledger cutover, mixed/transformed return provenance, cash refunds/writeoffs/claims and external GL integration remain explicit extensions, as documented in the lifecycle and supplier-return runbooks; they are not silently represented as implemented by this acceptance pass.
