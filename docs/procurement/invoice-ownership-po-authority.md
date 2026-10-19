# Invoice ownership and PO financial authority

This batch addresses AP-A1 and F19 on base `06ae53c6118b316ae120e9b1b17a25ac0d5dbf5c` (PR1843). It does not repair historical records or change supplier balances, payment allocation, or payment-date policy.

## Ownership and correction

`resolveShipmentBillingOwnership` is the shared billing decision used by candidates, shipment charge enrichment, payment totals, invoice summaries, cost posting evidence, and invoice action capabilities. It reads invoice lines and the charge association together. An existing association or source line cannot be treated as unbilled merely because another reference is missing.

- An unbilled charge has no invoice association and no recorded source line.
- A billed charge has one active invoice owner whose supplier, shipment, supported currency and source agree. Multiple distinct lines on that same invoice remain supported. Replacement preserves every line and requires their exact sum per charge to reconcile; repeated source-record identities remain invalid.
- Voided source lines remain evidence. Only the explicit replacement chain can transfer current ownership to a successor.
- Missing, competing or mixed product/freight ownership requires review. No latest-document winner, payment split, exchange rate or missing amount is inferred.

Generic unlinking and source-line deletion cannot erase a recorded liability association. The existing-invoice link endpoint now requires an explicit `invoiceLineId` for a new binding. The chosen untouched line must account for the whole charge, the invoice total must reconcile, and supplier/shipment/currency must agree. Binding preserves amounts and writes line, association and audit together. An already verified identical assignment is a no-op.

`readInvoiceSourceCapabilities` prevents approval/payment on ambiguous ownership and prevents PO link/import/unlink operations from changing a shipment invoice's economic source. Voiding remains subject to the existing payment-history and eligibility checks; it retains the source evidence. An unresolved historical association may need a separately reviewed data correction; this change does not perform one.

The pending SQL in `shipment-invoice-ownership-guard.pending.sql` adds statement-level graph locks, immutable source and association guards, and deferred final-graph checks. Deferred checks permit atomic creation and replacement intermediate states. The migration performs no data rewrite and does not reject deployment merely because existing records need review. It prevents new inconsistent owners, source deletion, association erasure and truncation. Pricing updates remain separate from ownership validation.

## Creation and recovery

`shipment-invoice.commands.ts` replaces legacy HTTP idempotency for shipment invoice creation. The durable key identifies the exact raw request, authenticated operator and shipment in one namespace. Explicit charge selection is required. The work, financial rows, audit and saved successful reply share a transaction; business rejection is also durable. Unknown failures retain retry identity.

The HTTP response preserves the legacy flat invoice fields and adds `invoiceId`, `shipmentId`, `actorId`, `idempotencyKey`, `costRowIds` and `totalCents`. Both new and replayed replies are validated. Only a matching durable rejection contains `commandOutcome: rejected`; authentication, transport and uncertain failures cannot clear recovery.

The shipment invoice form stores the original selection and exact reviewed amounts in session storage before sending. It uses integer-cent parsing, sends all reviewed line amounts, reuses the same request after reload or response loss, and validates result identity and total before clearing recovery. Storage failure, malformed responses, operator changes and missing permissions do not authorize a replacement request.

Shipment detail keeps original charge evidence visible when only payment totals require ownership review. Totals remain unavailable. Supplier, charge and invoice read failures show a retry path rather than an empty or paid result. Desktop/mobile PO lists consume canonical financial workflow status and filtering.

## PO authority

`readPoInvoiceHistory` detects retained header associations and invoice-line sources, including zero-value, voided and missing-header-link history. Draft header, full replacement and direct line commands use that evidence under the shared graph lock followed by the PO lock. Cached totals cannot permit or prevent these mutations by themselves.

`transitionFinancial` retains its existing signature but rejects manual financial status changes with `PO_FINANCIAL_LEDGER_OWNED`. No HTTP writer was found for that method in the base source; this removes an internal competing writer.

`buildPoFinancialMilestonePatch` establishes future invoice/payment/settled milestones only from the canonical, complete PO evidence and injected command time. Existing stamps remain unchanged. The legacy nonnullable financial fields are retained as whole-linked-invoice compatibility caches; they do not claim exact PO payment attribution and do not authorize draft edits or mark the operational workflow complete. Shared partial invoice payments remain unknown where the ledger cannot attribute them exactly. Canonical list filtering evaluates matching rows in bounded database batches before pagination; production-volume latency has not been measured by this local validation.

## Verification and release

The focused suites cover malformed input/results, exact-key replay, actor/resource mismatch, real PostgreSQL rollback, held-lock races, duplicate ownership, immutable history, legacy ambiguity, explicit replacement, zero-value and voided PO history, stale caches, and desktop/mobile recovery/action states. New PostgreSQL suites are registered in the sharded CI manifest and its independent inventory guard. Browser coverage is selected by the existing `procurement-*.spec.ts` configuration.

Local validation passed 4,024 distinct unit/guard cases (seven existing skips), 293 PostgreSQL cases across 14 fresh-database suites, and 220 distinct desktop/mobile cases. The full procurement unit run passed 3,777 cases; the final replacement refinement then passed all 88 selected domain cases, including six added cases. The three required typechecks, changed-browser typecheck, build, migration policy and diff checks also passed. Exact commands and logs are retained in outputs/procurement-invoice-po-authority-2026-10-19/validation.json. Browser cases use mocked HTTP. Local tests do not establish hosted CI, merge, migration application or production acceptance.

Before release, allocate this pending SQL under the draft PR's generated migration identity, preserve its exact SQL bytes, update both integration-suite references, and rerun migration guards plus the actual SQL suites. Deploy application and migration together. Readbacks should confirm that affected historical records show review, valid same-owner bills remain usable, creation recovery retains one invoice, and canonical PO decisions agree across list/detail/workspace. Any production repair requires its own concrete reviewed payload.

## Assumptions and remaining work

No production incidence or historical repair need is inferred from fixtures. The existing USD-only write boundary is preserved; no currency conversion is introduced. Supplier balance completion and payment dates (AP-A5/AP-A6/AP-A7) are the next planned implementation group. Combined cross-workflow acceptance and independent deployed-state readback remain after that group.
