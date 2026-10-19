# Shipment unit entry and receiving continuity

Base inspected: `0f89ef36706e5a4ded6bf7261fa01a3e9f36b2c4`. This correction follows the operator report for shipment S260727001564. Screenshots and source establish the UI gap; no production shipment records have been read or changed for this work.

## Problem and authority

The shipment line editor accepted base pieces and physical cartons independently. Its table labelled cartons as cases, while receiving already supported selected catalog units, frozen pack factors and exact conversions. Operators therefore had to perform conversions themselves when adding or editing shipment lines. A live catalog reference was not evidence of the recorded unit, and could default to one when no variant was found.

Base pieces remain the quantity used for PO capacity, shipment coverage and cost allocation. An explicit selected unit is a way to enter that quantity and establish the receive unit. A shipping carton is a physical package; its count never defines the stock conversion.

The shared exact quantity functions in `shared/procurement/unit-quantity.ts` serve shipment entry and existing receiving conversion. They use integer arithmetic, reject inexact conversion and enforce supported count bounds. The existing receipt planner still preserves every piece: where the preferred pack cannot represent a remainder exactly, it requires an actual active piece variant rather than rounding or inferring a carton factor.

## Entry-point inventory

| Entry point | Owner and expected behavior |
| --- | --- |
| Shipment detail, Add from PO | `use-shipment-line-actions.tsx`; choose a configured unit and count, review derived pieces, submit the selected variant and reviewed factor to the shared line owner. |
| Purchase detail, Create Shipment | `PurchaseOrderDetail.tsx`, `shipment-create-command.ts`; same quantity selection, inside the existing atomic header/line creation command and durable recovery. |
| Shipments overview, Create Shipment | `InboundShipments.tsx`; header creation remains the shared creation command. Subsequent Add from PO uses the same line controls. |
| Shipment detail, Edit line | `use-shipment-line-actions.tsx`, `shipment-line-command.ts`; the existing line version and selected unit evidence are reviewed together. Physical packaging edits preserve stock quantities. |
| Shipment packing-list CSV | `shipment-packing-list.ts`, `PackingListPreview.tsx`; explicit unit fields and converted piece totals, with numbered row errors and exact saved-request recovery. A SKU is not guessed into a PO source. The bounded, purchasing-scoped unit-options lookup uses only the preview rows' identities. |
| Direct add/import/update API callers | `shipment-line-command.ts`, `shipment-line-mutations.service.ts`; strict optional unit-selection contract, server-validated arithmetic, source ownership/capacity and current catalog factor under locks. Raw-piece contracts remain supported. |
| Shipment receipt preflight and creation | `purchasing.service.ts`; prefer the shipment's recorded unit snapshot, check catalog drift, and pass the exact remaining base pieces through the existing receipt planner. |
| PO receipt creation | `purchasing.service.ts`; retains the recorded PO receive configuration and the same receipt planner. |
| Receiving unit changes and manual count entry | `ReceivingUnitControl.tsx`, `receiving-units.ts`, `receiving.service.ts`; shared selection presentation and exact conversion, preserving existing receipt versions, source checks and immutable received/damaged evidence. |
| Receiving CSV and bulk completion | Existing receiving mutation owner; counts retain the meaning of the confirmed receiving unit. They cannot reinterpret a shipment's expected pieces. |
| Receipt close, reconciliation and reversal | Existing inventory and receipt owners; consume frozen receipt factors and original posting evidence. A shipment selection does not post inventory. |

The legacy local `purchasing.service.ts:updateLine` contains a downstream variant/carton cascade, but the public service exports `hardenedUpdateLine` instead. This correction does not reconnect that obsolete implementation.

## Command and storage contract

`unitSelection` carries `productVariantId`, `unitsPerVariant` and `quantity`. When a base-piece quantity is also supplied, it must equal the exact product. The server verifies an active variant of the source product and compares the reviewed factor with the locked catalog row. Unavailable source identity, catalog drift and capacity conflicts reject the attempted mutation; no fallback guesses a unit from a SKU suffix or carton ratio.

The selected identity uses the existing shipment `productVariantId`. Nullable `unitsPerVariantSnapshot` records its validated factor. Existing line versions cover the snapshot and measurement basis. The transaction still owns source capacity, line writes, allocation recalculation, audit and durable command result; changed payloads do not reuse a previously submitted recovery key. Only a matching terminal rejection from the durable command ledger clears a failed request. Authentication or permission failures during retry retain the original key and payload. Successful responses must account for every requested quantity, source and selected unit before recovery clears.

The read-only `POST /api/inbound-shipments/:id/lines/unit-options` accepts at most 500 row identities under `purchasing:view`, rather than loading the entire catalog or requiring inventory permission. It returns row-specific identity conflicts and active configured options. A PO's recorded factor is attached only to that same selected variant; selecting another valid pack does not inherit an unrelated factor.

Physical measurements have an explicit `dimensionBasis`: `piece` or `carton`. A carton basis requires a positive physical carton count. A piece basis uses base pieces even if carton count is also recorded. Legacy null retains its prior calculation until reviewed, so deployment does not silently revalue historical shipment weights or volumes. Catalog pack dimensions alone do not prove the contents of shipping cartons.

## Migration and compatibility

The additive migration adds nullable shipment unit-factor and measurement-basis columns and constraints. It does not backfill quantities, infer historical factors or rewrite receipts. Deploy the migration before application code that reads the new columns. Migration `migrations/900000015000018550001_shipment_unit_selection.sql` is allocated to PR #1855. Its SQL is byte-identical to the approved SQL in commit `9b5718920`.

Raw-piece commands remain valid for existing integrations. An explicit Add from PO selection for an already attached line returns actionable conflict guidance to edit that line; an exact retry of an applied command still replays its saved success. New unit-aware controls explicitly carry their reviewed factor. Existing receipts, cost history, terminal shipment restrictions, source-capacity protections and exact saved-request replay remain in force.

## Validation and limits

Validation results are recorded separately under `outputs/procurement-shipment-units-2026-10-19`. Required coverage includes exact and partial packs, invalid/cross-product/inactive variants, changed catalog factors, multiple POs, capacity contention, stale edits, import partial success, lost-response replay, audit rollback, explicit measurement bases, desktop/mobile entry and receipt posting exactly once.

Local controlled tests establish the implemented contracts, not deployment or production data repair. The actual catalog alternatives and PO snapshots for S260727001564 remain unverified. No assumption is made that its first line should use a particular case size.

The broad unit run passed 5,125 cases (seven existing skips). The final unit-options HTTP suite passed 34 cases, including 13 added after that broad run, for 5,138 distinct passing unit cases. The separate early CI guards passed 207 cases. Six disposable PostgreSQL suites passed 269 cases; the migration was applied twice over a legacy-shaped table and preserves historical rows. All three typechecks (application, server tests and client tests) and the production build passed. Browser acceptance verified 120 unique desktop/mobile cases across shipment lines, shipment creation and receiving units. Two initial assertions matched multiple alerts; the assertions were scoped and the affected cases passed on rerun. Screenshots of configured-unit edit, CSV and creation were visually reviewed, and the tests assert no horizontal overflow.
