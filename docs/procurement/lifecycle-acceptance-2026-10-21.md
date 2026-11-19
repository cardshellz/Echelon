# Combined procurement lifecycle acceptance

## Confirmed custody defect

Baseline: fetched main `b0edad6447da59f4aa1a8f4b2147c4fa48f874df`, including deployed RFQ PR1875. In a fresh disposable PostgreSQL database, `procurement-lifecycle-quarantine.integration.test.ts` creates an RFQ, converts its accepted quote to a PO, creates a shipment, then records and closes its actual receipt through the custody owner.

With 1,000 shipped pieces, 800 accepted and 200 held, the baseline shipment preview reported the held 200 as remaining to receive. Ordinary `createReceiptFromShipment` followed by `ReceivingService.close` posted those 200 into inventory and the PO while the original observation still held 200. The all-held variant also reproduced the bypass. Both regressions failed on the baseline; the separate explicit acceptance cases passed. Evidence is retained locally under `outputs/procurement-lifecycle-acceptance-2026-10-21/provisional-2026-10-21T19-10-56.635Z-df58b26b`.

The source trace was `purchasing.service.ts::summarizeShipmentReceiptCoverage` / `createReceiptFromShipment` -> `receiving-shipment-coverage.ts::readClosedShipmentReceivedBaseQtyByLine`. That reader correctly measures net accepted postings, including reversals. Treating that quantity as the entire physical shipment coverage omitted goods already held or returned through custody.

An additional real-database regression proved the alternate PO-direct route could post the same held 200 pieces after the shipment-only correction. `createReceiptFromPOUnlocked` used the remaining accepted PO quantity; its receipt had no shipment identity, so the shipment guard did not apply. Evidence is retained under `provisional-2026-10-21T19-30-48.542Z-2c2dfaa7`. A PO-wide quantity subtraction alone cannot fix the source gap: posting an unassigned PO receipt does not prove which shipment's fresh remainder it consumed.

## Correction

`domain/shipment-receipt-custody.ts` keeps accepted inventory and custody as separate facts. Custody coverage is `(observedQty - receivedQty) * frozen unitsPerVariant`: held, awaiting acceptance and returned quantities remain covered. A supplier return does not create a fresh arrival on the original shipment. A completed reviewed acceptance replaces custody coverage with its accepted receipt; it is not counted twice. Existing accepted-receipt reversal semantics remain intact.

`shipment-receipt-custody.repository.ts` reads accepted postings, reversals, observations and acceptance records in one bounded PostgreSQL statement. The domain validates exact purchase/shipment/source identities, frozen conversions, counter reconciliation and acceptance receipts. Invalid or truncated evidence requires review; unexpected database failures propagate. No live catalog ratio or SKU inference supplies custody authority.

The purchasing owner uses this projection for both receiving pickers, pack resolution and creation, rechecking inside its existing inventory graph lock. `ReceivingService.close` checks admission after exact source/unit/location resolution and before inventory or PO writes, under the shared graph/custody fence. Only the exact prepared acceptance line receives permission to release its held quantity. Over-receipt confirmation cannot release quarantine, and a previously saved ordinary draft cannot win against a legitimate acceptance close.

`domain/po-direct-receipt-custody.ts` and its repository enforce the alternate source boundary. A PO line with custody history cannot establish a new arrival through an ordinary PO-direct receipt. Creation excludes those exact lines, discloses the exclusions and original receipt links, and leaves unrelated eligible lines available. Existing drafts are checked again at close. The original identified intake can close its frozen accepted count, and an exact reviewed acceptance can post its approved quantity. Recording another intake on an older draft cannot manufacture that permission. Accepted or returned custody history remains source evidence; neither disposition proves that another delivery occurred. New arrivals for affected lines need their explicit shipment source.

The shared client coverage formatter distinguishes accepted inventory, held goods, returned goods and genuinely unarrived pieces. PO and shipment pickers and the single-PO pack dialog link to the exact original custody receipt. Full receipt requires matching accepted/shipped quantities with no remaining custody. A fresh remainder remains receivable.

## Connected financial and screen evidence

The existing persisted FLOW now continues from the same RFQ, two POs, multi-PO shipments, partial receipts, inventory sale and late freight into supplier return, cash, advance applications and supplier credit replacement. It compares the actual RFQ work list, purchase workspace/history, PO shipment-cost summary, shipment review/health/list, invoice list and later payment/credit/PO financial projections.

The controlled scenario conserves $4,610: after returning one unsold case, $4,130 remains in inventory, $240 in sold COGS and $240 in supplier-return value. Invoice settlement is $4,400 recorded cash plus $210 credit, with zero payable. Reversing/voiding/replacing the credit preserves the physical return and original application history. The separately invoiced $30 freight difference remains explicit, with a recorded supplier decision rather than an invented balancing adjustment. Original request keys replay without another stock movement or cash record.

The fixture uses real migrations and transactions in an exclusively owned disposable database. Only verified-empty credit/return read declarations are replaced by their production write schema; business records are not reseeded between checkpoints. Synthetic bank evidence records settlement but performs no bank transfer. FLOW proves the supported pre-opening quantity authority; it does not certify active-ledger cutover or external accounting integrations.

## Validation and operational limits

The branch incorporated current main `1b7910d9223c7253a44f252be726d60b93ae7b42` (including shipment cost-link repair PR1878 and order-edit inventory finalization PR1880) before final validation. Final validation passed against frozen application and test source:

- 4,920 unit/guard cases, including 353 early CI guards. Seven pre-existing skips in `po-exceptions.service.test.ts` remain unchanged.
- 331 PostgreSQL cases in seven independently created disposable databases: lifecycle custody 17, connected FLOW 4, quarantine 22, shipment allocation 15, receipt cost application 194, receive-unit integrity 57 and close integrity 22. Every suite verified the same source identity before and after execution.
- 186 desktop/mobile Chrome cases across receiving units, receiving integrity, quarantine and cost agreement. The new custody controls were also visually inspected on mobile.
- Application, server-test, client-test and affected-browser TypeScript checks, plus the production build.

Database evidence is retained locally in `outputs/procurement-lifecycle-acceptance-2026-10-21/final-2026-10-21T19-46-57.588Z-3184565f`; unit, browser, typecheck and build logs are adjacent. All generated databases were removed, no other test clients remained, and the local cluster was stopped. No SQL migration is required. Browser scenarios use mocked API responses and prove rendering/navigation; PostgreSQL scenarios exercise actual owners, locks, constraints and rollback. Those are separate evidence categories. Hosted CI and deployment of this correction are separate release steps.

Read-only deployed inspection successfully loaded the RFQ work list under the existing administrator session. It contained no saved RFQs, so production quote/conversion recovery cannot be certified from those records. Existing shipment and purchase pages are inspected without creating receipts, changing status, posting costs or applying historical repairs. Deployment status and this limited readback do not certify all migrations, non-admin permissions or all historical records.

The sampled closed shipment, its linked PO and the shipment overview agreed that landed costs were posted while separate supplier product/packaging review remained outstanding. The PO also identified posted estimated charges without presenting them as unposted. The user's previously reported multi-PO shipment loaded with recorded receive-unit conversions and a clearly unresolved legacy unit. These are observations of saved records, not permission to repair missing evidence or certify every historical transaction. Private record identifiers and values remain in local acceptance notes rather than this public runbook.
