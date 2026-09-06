# Procurement shipment line controls (W01 follow-up)

Baseline inspected: `deaec38fe6eb12aa0ccc217449446c3377f4fced`, after shipment charge controls PR #1380. This is a code and controlled-fixture evaluation. No production business records were inspected, exported, reconciled, or changed.

## Confirmed baseline defects

| Path and function at baseline | Confirmed behavior | Consequence |
| --- | --- | --- |
| `shipment-tracking.service.ts:addLinesFromPO` | Selected quantities receive product/status/capacity checks; legacy IDs/all-lines insert full ordered quantities. Totals and allocation run after the insertion transaction. | Different entry points can allocate different quantities; later failure can leave committed lines. |
| `shipment-tracking.service.ts:updateLineDimensions`, `removeLine`, `importPackingList`, `resolveDimensionsForShipment` | Writes and recalculation do not share one parent-locked transaction. PATCH accepts the request body without a strict DTO. | Terminal-state, allocation, or input failure can follow an earlier committed change. |
| `InboundShipmentDetail.tsx:handleSaveLineEdit` | Case items recalculate pieces from cartons times the current catalog factor. | A dimensions-only edit can change 501 recorded pieces into 550 (11 cartons at 50) or 750 (3 cartons at 250). |
| `InboundShipmentDetail.tsx:buildImportRows` and import success handler | CSV emits snake_case keys, while the service expects camelCase; returned row errors are discarded. | Mapped quantities fail server validation and the dialog hides the errors. |
| `purchasing.service.ts:createReceiptFromShipment` | Receipt source lines are read before the receipt transaction, which only takes a receipt-specific advisory lock. | A line edit can invalidate the precomputed receipt payload before insertion. |
| `procurement.schema.ts:inboundShipmentLines`, `landedCostSnapshots`, `landedCostAdjustments` | Exact line-dependent cost history uses cascading foreign keys; receipts have shipment-header plus PO-line links, not shipment-line IDs. | Per-line deletion needs both exact history protection and shipment-wide receipt protection. |

These paths prove possible failure modes, not their frequency in production.

## Operator behavior

Pieces and cartons are independent fields. Dimensions and carton edits preserve piece quantity unless the operator explicitly changes pieces. The catalog pack factor is reference information; it is never an authority for rewriting a saved shipment quantity.

Add from PO submits explicit quantities from the shippable-lines view. The command checks the current source under locks. Legacy `lineIds` and omitted-selection requests remain supported with the same source checks; implicit-all selects eligible product lines and skips exhausted quantities. Unknown or duplicate explicit selections are rejected.

Packing-list mapping produces the camelCase DTO. Up to 500 rows may be submitted. Each row needs a SKU, product variant, or PO-line reference and positive integer pieces. SKU-only rows remain unlinked; the system does not infer a PO from a SKU. PO-linked rows derive the PO and expected receive variant and reject conflicting supplied identities. Unsupported pallet/gross-volume import controls are removed.

Ordinary row validation, identity, and per-row capacity failures produce explicit numbered errors while valid rows commit together. The dialog retains only rejected rows for correction after a definitive partial-success result. A source-level inconsistency or concurrency conflict rejects the entire command; no subset is reported as committed. Database, allocation, audit, and command-result failures roll back the entire attempted subset.

Once any receipt header or finalized cost snapshot/adjustment exists, physical line changes are blocked through these endpoints. This includes cancelled receipt history because it is still evidence. Notes-only corrections remain possible on nonterminal shipments. Closed/cancelled shipments reject new line mutations. The empty-draft delete endpoint cannot bypass line/history protections; line-bearing drafts require individually audited removals before deleting an empty header.

## Command ownership and recovery

`shared/procurement/shipment-line-command.ts` defines strict input contracts for all five operations: add from PO, import, resolve dimensions, update, and delete. Pieces/IDs/cartons are bounded by PostgreSQL integer capacity. Decimal strings match actual dimension column precision; null and omission remain distinct. Parent/source identity, financial fields, derived totals, and timestamps cannot be patched.

`inbound-shipment.routes.ts:handleLineCommand` requires purchasing edit permission, an authenticated actor, canonical resource ID, and `Idempotency-Key`. `shipment-line-commands.ts:createShipmentLineCommands` binds each operation to method, route template, resource, and stable command principal. The actual human actor is recorded independently. The existing financial command ledger persists both successful responses and definitive rejections; exact delegated retries replay the recorded response, while changed payloads under the same key conflict.

`shipment-line-mutations.service.ts:executeLineCommandInTransaction` holds the shipment row through source validation, line writes, totals, allocations, before/after audit, and durable response persistence. PO capacity writes lock PO headers and lines in ascending ID order. PATCH/DELETE use `shipment-line-version.ts:shipmentLineVersion`, calculated from raw stored values before display enrichment. Conflicting versions require refresh and review. The command clock supplies the line/allocation/header/audit timestamps on this path.

`shipment-line-physical-values.ts` calculates physical totals with decimal arithmetic and explicit column-bound checks. Clearing a dimension recalculates using null rather than the old value. Invalid stored physical values fail with an actionable correction error. Resolve dimensions fills missing fields individually and can explicitly rebuild inconsistent derived totals; it preserves entered dimensions and pieces. Physical redistribution also requires the same verified USD currency basis as the shipment charge owner.

`client/src/lib/shipment-line-command.ts` retains the original command body and key in authenticated-user/shipment-scoped session storage before dispatch. Recovery is manual and uses that exact intent, including after reload or a terminal transition. Changed commands remain blocked while an earlier outcome is uncertain. The server's durable result survives independently; this slice does not add cross-device recovery discovery. Clearing tab storage ends local recovery discovery.

## Quantity evidence and receiving

`shipment-source-capacity.ts:computeShipmentSourceCapacity` uses base-piece evidence:

`available = ordered - cancelled - active shipment commitments - proven direct PO receipts`

Shipment-linked receipts overlap their shipment commitment and are not subtracted twice. Receipt and reversal base-unit snapshots must reconcile to PO received counters. Missing postings, unassigned receipt evidence, contradictory ownership, ambiguous allocations, or incomplete reversal units require review rather than guessed overlap. Pending direct-PO receipts also require completion/cancellation before new shipment allocations because receiving posts inventory before PO reconciliation finishes.

The shippable-lines read projection uses the same evidence rules and exposes review-required lines separately. It is an indicative read; the command revalidates current evidence under locks when saving.

`purchasing.service.ts:createReceiptFromShipment` now takes the shipment lock before its existing receipt advisory lock. It compares the precomputed header/line source fingerprint with fresh transaction reads before inserting a receipt. A changed source returns `SHIPMENT_RECEIPT_SOURCE_CHANGED`; the caller must refresh and review. This prevents a stale precomputed receipt from silently committing after a competing line change.

## Deliberate boundaries and next work

- Partial-carton receiving remains a confirmed W02 gap. From-PO creation retains the existing recorded-pack preference and ceiling carton default. Receiving's `inspectShipmentCartonReceivePack` / `deriveShipmentCartonReceivePack` still interprets pieces divided by cartons as a pack conversion. This slice prevents piece inflation during editing; it does not claim that every partial carton can be received correctly.
- The receiving owner can still create a new direct PO receipt after shipment allocation. Its ordering/quantity policy, inventory posting, post-commit PO reconciliation, and receipt-reversal lock order require separate receiving work. No global serializability claim is made across all procurement and inventory writers.
- Shipment header creation/history atomicity and an archive policy for empty drafts remain separate work. Existing empty-draft deletion is retained; recorded line changes and linked receiving/cost history are protected here.
- Shipment costing, signed credits, FX, cost propagation to lots, reporting, and Archon export retain their existing owners and limitations. These line controls do not reconcile historical COGS or prove production cost completeness.
- No new approval ceremony, carrier integration, automatic purchasing activation, migration, or historical backfill is included.

## Verification

Unit and HTTP suites cover strict fields, precision/quantity limits, null clearing, version conflicts, route/actor/key scope, source arithmetic, failure classification, and receipt source changes. Previous add-from-PO bypass mocks are replaced by source-domain tests and actual PostgreSQL command tests.

`shipment-line-commands.integration.test.ts` runs production command/service/storage code against a disposable PostgreSQL fixture built from actual schema columns/defaults and relevant foreign keys. It exercises real lock contention between competing shipments and closure, exact durable replay, partial imports, receipt/reversal evidence, and rollback after line, totals, allocation, and audit failures. The cost-command and financial-command PostgreSQL suites run separately so their schema fixtures cannot race.

Browser tests run the React UI against fictional API fixtures, covering independent pieces/cartons, CSV errors/corrections, exact uncertain recovery, navigation, stale versions, and multi-line dimension progress. These tests establish behavior in controlled fixtures, not the deployed incidence or historical-data compatibility rate.

## Subsequent receiving follow-up

[W02a receiving unit and source integrity](procurement-receiving-unit-integrity.md) follows this baseline and corrects the partial-pack creation/conversion and exact receiving-source gaps described above. [The separate financial trace](procurement-receiving-cost-followup.md) records the remaining cost-component and propagation defects. The baseline observations in this document remain historical evidence.
