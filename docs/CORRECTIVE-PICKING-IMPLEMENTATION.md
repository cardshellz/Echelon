# Missing-pick confirmation and corrective picking

## Scope

This change implements missing **pick evidence**, not a new ATP engine, packing station, shipping engine, or historical inventory repair. No production operation is part of this implementation.

ShipStation's exact declared item IDs and quantities remain the authority for package contents. A package declaration is not an inventory pick movement. The canonical WMS shipment projection must not manufacture `picked_quantity` or `picked_at` from it.

## Operator workflow

1. When the existing authoritative package projection finds declared units without recorded picks, WMS saves a correction for that exact order item.
2. The gun displays “Was this item actually picked?” with **Yes / No only**. Corrections are read independently of the ordinary queue, so a shipped order cannot disappear with this work unresolved.
3. **Yes:** save the person's confirmation, then record only the missing quantity through the existing inventory-owning picker. This uses the recorded source bin in the order's warehouse. It does not infer a different source or synthesize stock from a retrospective confirmation.
4. **No:** save a corrective-pick task. No inventory moves on this answer. Scan that SKU/barcode and record the quantity actually picked now; partial quantities are supported. Already-picked lines and the original customer order/shipment remain intact.
5. The existing picker owns stock, lot, reservation, cost and WMS progress effects. Close the correction only from its committed pick progress. Labels, box changes and any additional package remain in ShipStation/the existing shipping workflows, not on the gun.

The gun does **not** resend the original order, create a duplicate customer fulfillment, or automatically create a new ShipStation follow-up order. The same operator finishes the box/label correction downstream. An automated, line-scoped follow-up exporter is not included in this change; do not describe the completion message as that exporter.

## Implementation map

| Concern | Owner / entry point |
| --- | --- |
| Stop label-to-pick inference; observe discrepancies atomically | `server/modules/wms/channel-fulfillment-projection.repository.ts`, `projectPhysicalShipmentToWms` |
| Workflow records, immutable evidence, exact-item fences | `server/modules/wms/pick-correction.repository.ts` |
| Durable answer, replay, corrective-pick orchestration | `server/modules/orders/pick-correction.service.ts`, `PickCorrectionService`, `createPickCorrectionService` |
| Existing legacy/canonical inventory posting | `server/modules/orders/picking.use-cases.ts`, `pickItem`, `applyLegacyPickProgressTransaction`, `applyCanonicalPickProgress` |
| Canonical authorization and cumulative custody checks | `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts`, `pickClaimLine`; `server/modules/wms/order-item-commands.ts`, `persistCanonicalWmsPickProgress` |
| Gun interstitial, reopened pick work, saved failure | `client/src/features/picking/PickCorrections.tsx`; `client/src/pages/Picking.tsx` |
| Actual-pick-only UI progress | `client/src/lib/picking-progress.ts`, `derivePickerLineProgress` |
| HTTP permission boundary | `server/modules/orders/pick-correction.routes.ts`, `registerPickCorrectionRoutes` |
| Dependency composition | `server/services/index.ts` |

## Integrity and failure behavior

- Migration `0702_corrective_picking.sql` creates workflow/audit tables only. There is no backfill, quantity adjustment or runtime ATP activation.
- `confirmation_required -> picking_required -> resolved`. An unchanged old shipment replay cannot erase No. A changed authoritative declaration requires a new answer; a withdrawn declaration can close unnecessary work without moving stock.
- The WMS owner is the sole writer of both correction tables. Audit events are append-only, protected by a database trigger. Command UUIDs have a unique constraint and are bound to a request hash and authenticated actor.
- Lock order for correction decisions: WMS order, item, correction. Existing inventory owners keep their authority/graph locks before the order and their inventory/lot locks afterward. No DB transaction remains open across a provider call.
- Answer and physical movement are deliberately separate transactions. A crash retains the answer; a retry uses cumulative committed pick progress instead of posting again. This is not an assertion that both transactions are one atomic write.
- Ordinary pick commands cannot bypass the question by promoting a declared-but-unpicked line. Corrective authorization is server-owned and limited to the exact item, assigned actor and declared quantity. It does not authorize unpicks or picking cancelled/held orders.
- The inventory owner rechecks the authorized correction revision under its lock. Withdrawal and reintroduction of the same quantity cannot make an old answer/scan valid again. Explicitly non-inventory-tracked physical items use the existing confirmation-only owner without requiring a stock bin or inventing inventory.
- Legacy shipment inventory and canonical claim dispatch wait while a correction is open. Already-posted idempotent receipts remain replayable. A stored carrier event uses the durable retry schedule after resolution; it does not require another webhook or exhaust the transport retry budget while awaiting a person.
- An already-posted or ambiguous historical shipment, absent/ambiguous source bin, inactive/missing claim, insufficient recorded stock for retrospective Yes, or concurrent state change leaves actionable review work. Do not guess quantities or debit stock again.
- Read access requires `picking:view`; actions require `picking:perform`. The actor comes from the authenticated session, not a body field.

## Verification and boundaries

Tests cover binary confirmation, refresh recovery, partial scans, wrong SKU, permission boundaries, duplicate commands, actor/revision conflicts, old shipment replay, withdrawal, immutable audit, transaction rollback and post-commit-response loss. Connected disposable PostgreSQL tests exercise the real correction service/repository, shipment projection and canonical shipment dispatch; inventory-owner tests exercise the existing posting fences. Workflow tests with a small movement journal are explicitly not full lot/cost migration proof.

Local validation on 2026-09-24, rebased onto `origin/main` at `cd6d306a8d4ba528d5b4dc348622087c359a0aa1`:

- Full Vitest run: **17,459 passed**, **0 failed**, **1,720 skipped** (including environment-gated database suites). This is not a claim that every database suite ran.
- Nine explicitly enabled disposable-PostgreSQL suites: **215 passed**, no skipped tests. These cover correction workflow, shipping projection, canonical dispatch/publication, raw ShipStation package allocation, carrier retry recovery, legacy shipment authority, lot parity and the procurement-to-sale cost flow.
- Shared shipment-fixture regression run: **124 passed**, no skipped tests, across eight connected database suites and one fixture guard. This overlaps some suites above; the counts are not additive. CI exposed a derived cleanup statement that omitted its operational-receipt dependencies after the new tables were added; its fix and guard preserve all base cleanup tables in the same transaction-safe truncate statement.
- Desktop/mobile corrective-pick and existing pick-inventory browser journeys: **56 passed**. The settled Yes/No screenshots were visually checked, and the dialog is asserted to fit both viewports.
- Application, server-test and client-test TypeScript checks passed; the production bundle build passed.
- `scripts/ci/postgres-test-manifest.ts` includes the new correction suite. Existing legacy shipment and procurement fixtures install the actual correction migration; the PostgreSQL manifest guard preserves every prior suite.

The Windows checkout needed LF normalization of eight unchanged source/SQL inputs for pre-existing literal-source tests; these produced no Git content changes and are not in this PR. Temporary local PostgreSQL files were excluded from Git enumeration during tests, not from product/test coverage. GitHub CI and live operator acceptance remain separate from these local results.

Production acceptance still needs a controlled operator test of a three-line order: record two picks, declare all three in ShipStation, answer No, pick only the missing line, finish the box/label downstream and verify one inventory movement for each real pick. Also test Yes for a missed recording. Do not use unknown historical strays as that test. Existing historical discrepancies require their own preview and explicit approval.

No production inventory, orders, reservations, channel quantities, configuration, or deployment was changed while building this branch.
