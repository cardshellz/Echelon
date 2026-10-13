# Receiving close and destination integrity

Implementation baseline: `f2aec4ceb961061e9c149509439acb15b0c62348`. This is the bounded F13/F14/F17 corrective slice after the procurement workflow audit. Local test evidence is separate from deployment or production repair.

## Summary of changes

`ReceivingService.close` now commits persisted source links, inventory, original PO receipt evidence and counters, receipt closure, and durable cost requests in one database transaction. An unmatched or ambiguous PO-linked line is rejected before physical posting. A uniquely provable source is persisted on the receiving line before the inventory owner records the lot and immutable cost origin. PO reconciliation no longer invents a source in a temporary object after stock has posted.

Warehouse and active-location ownership are checked under database locks on location assignment, import, destination change and close. Both receipt builders obtain primary-location defaults with a scoped query through their transaction. A primary location in another warehouse cannot become the receipt default.

The header command accepts `applyDefaultToUnassigned: true` only with an explicit non-null `receivingLocationId` and an authenticated actor. It changes the default and only still-unassigned line locations in one transaction with before/after audit evidence. Assigned lines remain unchanged. Repeating the same completed request without any remaining assignments is a no-op.

## What the code definitely does

| File and function | Evidence and behavior |
| --- | --- |
| `server/modules/procurement/receiving.service.ts` — `close` | Acquires the inventory cost-graph lock, receipt header/line locks, ordered PO rows, variant rows and source/location locks before posting. Checks the prepared receipt snapshot again under the receipt lock. Existing frozen-unit and exact shipment-link errors retain their public error codes. |
| `receiving-close-integrity.domain.ts` — `resolveReceivingSources` | Requires one valid source per counted PO-linked line. An explicit source is validated without reassignment. Unlinked lines need one remaining matching product source; shipment receipts additionally need one exact shipment-line source. Blind receipts remain supported. Missing/cancelled purchase sources are blocked; shipment readiness uses the same policy as creation. |
| `receiving-close-integrity.repository.ts` — `readReceivingSourceResolution`, `validateReceivingLocations`, `readPrimaryReceivingLocations` | Parses actual SQL rows and locks source, warehouse, location and relevant primary assignments through the caller's executor. Defaults are restricted by receiving variant IDs, destination warehouse and active state. Multiple legacy primary slots in that warehouse use deterministic location-ID ordering. |
| `receiving.service.ts` — `updateOrderDetails`, `addLine`, `updateLine`, `bulkImportLines` | Rejects incompatible destination/location changes. Unassigned drafts can still be imported before a warehouse is chosen. Applying a default reads the current locked line set, preserves assigned lines and rolls all changes back if audit insertion fails. |
| `receiving-orchestration.service.ts` — `reconcileLinkedPurchaseOrder` | Requires the transaction-aware purchasing entry point during a new close; it fails closed if that owner is unavailable. It does not publish a separate PO exception while the physical transaction is uncommitted. |
| `purchasing.service.ts` — `onReceivingOrderClosedInTransaction`, `afterReceivingOrderClosed` | Runs PO receipt reconciliation on the supplied physical transaction. Quantity-variance detection is deferred until commit. The existing public recovery entry point retains its own transaction for already-closed receipts. |
| `purchase-order-receipt-reconciliation.service.ts` — `reconcilePurchaseOrderReceipt` | Uses persisted links and frozen receipt units. Existing original receipt identities avoid duplicate PO quantity writes. A replay with no new receipt skips total recomputation and leaves unchanged PO timestamps alone; genuine status repair remains available. |
| `migrations/0750_receiving_integrity_audit_guard.sql` | Prevents update/delete of `procurement.receiving.source_resolved` and `procurement.receiving.default_location_applied` audit rows, including rewriting another action into either protected action. It prevents table truncation once protected rows exist. |

Channel-sync enqueue, receive warnings, quantity-variance detection and AP/cost application occur after the physical/PO transaction commits. AP/cost failure retains the durable receipt cost request and its existing retry controls; it does not trigger another stock receipt.

## Operator recovery and compatibility

- A new close rejected with `RECEIVING_CLOSE_INTEGRITY_REVIEW_REQUIRED` leaves stock, receipt closure and PO receipt counters unposted. Inspect `details.issues` for the affected line or destination. Resolve the actual source/destination before retrying; do not convert an unexpected PO-linked line into a guessed purchase source.
- Existing `RECEIVING_SHIPMENT_SOURCE_MISMATCH`, unit-confirmation and unit-source errors remain in use. Incomplete exact shipment provenance cannot be silently repaired by inference.
- A failed warehouse change leaves the header and lines unchanged. Review existing assignments before changing warehouses. Clearing the default does not clear assigned line locations.
- Once a receipt is closed, retrying close uses existing physical evidence and may retry outstanding cost work. It does not receive the same stock twice.
- Historical closed receipts with missing/ambiguous source links now require evidence review; this change does not backfill provenance. The historical reconciliation path cannot fabricate a PO link to make a previously posted receipt appear valid.
- Unmatched or ambiguous goods remain blocked in this slice. The user's requested quarantine custody and explicit release workflow is a separate canonical inventory change; no quarantine bucket or location convention is introduced here.

## Deployment and audit retention

Apply migration0749 before the application version begins writing the two protected audit actions. It changes no receipt quantities, source links, warehouse assignments or historical prices. Migration numbering must be checked against current main before publication.

The truncate guard affects the entire `public.audit_events` table once either protected action exists. Audit cleanup must preserve protected records; deleting unrelated rows remains permitted. As with other database guards, a privileged owner capable of disabling triggers is outside this application's immutability boundary. Do not disable these guards for production cleanup. Disposable test fixtures may destroy their own database after use.

An application rollback does not require deleting audit history. Retain the guard and all source evidence. No production data repair is authorized or supplied by this release.

## Assumptions, risks and remaining failure modes

- Source identity is proven by current locked records; no missing historical business intent is inferred. A single matching product line with remaining quantity is the only automatic PO source assignment. Multiple candidates require a separate reviewed resolution path.
- This slice preserves the existing shipment readiness policy and does not impose the direct-PO creation allowlist on shipment receipts. The receipt builders and close share the shipment status constant.
- It does not change damaged-goods disposition, cross-receipt overage capacity, reversal idempotency middleware, or the capped receiving list. It does not establish complete procurement correctness or financial readiness.
- The cost-graph lock serializes physical/cost graph writers. The longer atomic close transaction now includes PO reconciliation; contention and failures are explicit rollback outcomes. Queue and advisory work remain outside that transaction.
- Existing historical partial commits are retained for review. No production count, affected value or remediation prevalence is asserted.
- A post-commit advisory/cost failure is a distinct outcome from failure of physical receipt. Use the persisted receipt and cost state to distinguish them; do not manually re-receive stock after an uncertain client response.

## Test coverage and evidence boundary

`receiving-close-integrity.test.ts` covers pure source/warehouse decisions, including explicit wrong ownership, no/ambiguous candidates, shipment source identity, supported lifecycle compatibility and inactive/mismatched destinations. Existing receiving units, import, route, builder and reconciliation tests cover preserved error contracts and frozen-unit behavior.

`receiving-close-integrity.integration.test.ts` uses the actual reviewed inventory opening, canonical authority activation, quantity journal and admission guards. It invokes the production receiving, inventory and purchasing owners. The fixture replaces the cutover fixture's empty cost-origin prerequisite with migration222's actual origin schema and reinstalls admission/immutability triggers before opening. It tests canonical stock/source/PO atomic rollback, source-to-lot provenance, retry, warehouse rejection, default assignment/audit rollback, and real lock-observed concurrent closes and location edits. AP revision application is deliberately outside this fixture; its durable pending queue is preserved.

`receiving-unit-integrity.integration.test.ts` separately retains pre-opening/frozen-unit and reversal coverage, including the changed assertion that an unavailable PO owner rolls all new physical writes back. `receiving-cost-application.integration.test.ts` exercises actual AP/freight cost owners, durable post-commit cost recovery and both receipt builders' warehouse-scoped defaults. `receiving-audit-immutability.integration.test.ts` covers migration0749's protected actions and unrelated-row compatibility.

Browser fixtures exercise the client under controlled responses; they do not prove production authentication, live data or release execution. Final local results are recorded in the implementation report. Hosted CI and deployment remain separate checks.
