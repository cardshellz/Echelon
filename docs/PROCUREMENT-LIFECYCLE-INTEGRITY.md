# Procurement lifecycle integrity

Baseline: `8c42b2c63aa76ab24f932a4c33d4c665f68bb95e` (2026-10-16). This batch addresses original audit F09, F11 and F16. PR1810 is merged; the operator confirms deployment. No independent production acceptance is claimed.

## Changes and command trace

### Purchase order close

`purchase-order-close.service.ts::buildPoCloseChange` requires received legacy and resolved physical states and complete locked active product-line counters. The established legacy physical fallback, nullable counters, explicit cancellations and overreceipts remain supported. Unknown types/statuses and invalid counters require review. `purchasing.service.ts::close` locks the graph, header and lines before this proof, then retains current three-way matching and approved invoice-cost reconciliation. A rejected physical close cannot write financial reconciliation evidence. This proves the persisted receipt counters under their writer locks; it is not a new reconstruction of the entire receipt/reversal ledger.

`purchase-order-lifecycle.service.ts` no longer advertises ordinary close for partially received POs. Incomplete delivery uses the separate approve-authorized close-short route and a nonblank reason. That command retains its line disposition and audit trail. The injected command clock is shared across close/header/line/history/events and supplier purchase evidence. `PurchaseOrderDetail.tsx` now renders a working close-short dialog from the canonical server action and current approval permission. Conflicts retain the reason; lost responses reload the saved state before another attempt.

### Shipment cancellation

`shipment-tracking.service.ts::cancel/transitionTo` validates the request and acquires the existing inventory graph and shipment locks. `shipment-cancellation.repository.ts::readShipmentCancellationEvidence` reads retained receipt header/line links, inventory lots/origins, cost snapshots/adjustments/revisions, actual or paid costs, legacy invoice markers, and invoice header/line ownership. The pure `shipmentCancellationBlockers` policy rejects cancellation when any of these exist.

- `409 SHIPMENT_CANCELLATION_HISTORY_PROTECTED`: retain the shipment and finish the receipt/cost/invoice correction workflow. Reversed receipts, depleted lots, zero actual cost and voided invoices remain evidence.
- `503 SHIPMENT_CANCELLATION_UNAVAILABLE`: proof could not be read or validated; no cancellation is performed. Retry after the evidence reader is available.
- A genuinely unreceived shipment with only estimates remains cancellable, with actor/reason/time history. Its estimate/line records are retained.

`InboundShipmentDetail.tsx` keeps a blocked cancellation in its dialog with the entered reason and a plain inline explanation. Success requires the originating shipment identity and a confirmed cancelled state; late responses cannot complete another shipment screen.

The receipt-creation and shipment-invoice writers use the compatible graph-to-shipment lock protocol and revalidate status. New concurrency cases exercise the actual cancellation owner against real PostgreSQL writers using that protocol; they do not claim to execute the entire AP/receiving writer in each race.

### Receipt discard

`ReceivingService.deleteOrder` delegates to `discardDraftReceivingOrder`; both HTTP paths now share draft-only, custody, count and putaway safeguards. Header locking serializes open/count/close against discard. Nonzero or malformed received/damaged/putaway evidence blocks deletion. An unused draft is deleted together with a full before-state audit; linked PO history uses the same injected timestamp. Failed audit/history writes roll back deletion.

Both list layouts offer discard only for drafts and call the same command as receipt detail. A concurrent-start rejection preserves the row and shows its reason. The detail action requires loaded lines with no recorded activity.

The forward-only audit migration extends the existing receiving-integrity guard to `procurement.receiving.discard`. It preserves previous protected actions and existing snapshots and rejects update, delete, relabel and truncate. No deployed migration is edited. The SQL is allocated to PR #1820 at `migrations/900000010000018200001_receiving_discard_audit_guard.sql`; its SHA256 remains `6aeac60c85ceb7ad039d6278ee0fa9637e1de5a10d9ed21ab1380414e8769498`, byte-for-byte identical to the approved and tested SQL. Apply this migration before deploying the application change.

## Assumptions and limits

No historical repair, inferred financial ownership, email connection or production mutation is included. Existing incomplete/contradictory PO counters are blocked for review rather than automatically rewritten. Cancellation intentionally preserves physical/financial history even when current quantities or balances are zero. A deleted draft's second deletion returns 404; it cannot create a second audit. Broader receipt-reversal replay defects and source/payment recovery remain separate tracked work.

## Validation

- Procurement unit/HTTP regressions: 3,272 passed across 218 files; seven existing skips.
- PostgreSQL: 232 passed across six existing registered suites: purchase approval/close 71, receipt audit 12, receipt integrity 18, quarantine 20, shipment cost/cancellation 59, shipment lines 52. Each suite ran in a fresh disposable local database with production URLs removed.
- Desktop/mobile: 64 passed across cancellation authority, receiving integrity and shipment cost/cancellation workflows.
- Early CI guards: 202 passed. The final allocation is checked against the base inventory; no existing migration bytes changed.
- Application/server-test/client-test typechecks and production build: all passed on the final code.

Initial failures were corrected and the affected full suites rerun: a shipment fixture leaked line associations, a BigInt literal conflicted with the configured TS target, and raw timestamp binding shifted PO discard history in a non-UTC host. The final receipt case checks the actual persisted timestamp using the application schema mapping. Audit tests cover upgrade of an existing snapshot, mutation/relabel/truncate rejection, and transaction rollback.

Local checks are distinct from hosted CI, merge, deployment and production acceptance. No live acceptance or historical repair was performed. Local validation evidence is retained under `outputs/procurement-remaining-2026-10-16` in the primary workspace; it is not a production data export.
