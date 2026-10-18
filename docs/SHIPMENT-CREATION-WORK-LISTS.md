# Shipment creation recovery and procurement work lists

Scope: original review F10/F12 and AP follow-ups AP-A3/AP-A4. Implemented from current main `d5a04cb66dbf1aa8ddb1f6d8931d66fbf32ba538` (2026-10-18). This document records code behavior and local acceptance; hosted CI, deployment and live production acceptance are separate states.

## Creation command

`inbound-shipment.routes.ts` registers the authenticated, create-authorized `POST /api/inbound-shipments`. It requires `Idempotency-Key` and rejects query parameters. The header body remains compatible; optional `purchaseOrder` carries an explicit purchase order and reviewed line quantities. Callers may still create an empty draft without that selection.

`shipment-create.commands.ts::createShipmentCreateCommands` reserves the existing financial-command ledger identity, hashing the exact HTTP body. `shipment-create.service.ts::executeCreateShipmentInTransaction` owns orchestration: validate actor/input/clock, acquire the inventory cost graph lock, allocate a number, insert header and initial history, invoke the existing shipment line owner, verify the selection, and insert audit evidence. The header, selected lines, totals, history, audit and successful command response commit together. Failure rolls all business writes back. The existing line owner remains responsible for PO capacity, receive packs, dimensions and allocations.

`shipment-create.repository.ts::allocateShipmentNumber` serializes both automatic and manual numbers and reads numeric suffixes, including cancelled numbers. Explicit PostgreSQL integer casting selects the substring-position overload; the real database tests caught the otherwise incorrect regex overload. The active-number unique constraint remains the final guard. Deterministic 30-character sequence exhaustion records an actionable 409 rejection; both creation dialogs permit a reviewed manual number under a new intent. The obsolete uncoordinated storage create/number functions have no callers and were removed.

An identical key/body replays the original result even after the shipment changes. Changed bodies cannot reuse the original key. Definite domain rejection is durably recorded; infrastructure failures retain the command for its established retry/recovery process. The service principal permits the same delegated recovery supported by the other shipment commands; the original actor/history are retained.

## Browser recovery

`shipment-create-command.ts` persists the exact body and key in session storage before dispatch, shared by both creation screens and scoped to the authenticated operator. Only one unresolved create intent may exist in that browser session. It validates the returned identity, draft creation snapshot, actor, requested number and selected-line count before navigation. It retains the request after response loss, unreadable/malformed results, authorization failures and uncertain infrastructure errors. Only a verified success or matching durable rejection clears it.

`use-shipment-creation.ts`, `ShipmentCreateRecovery.tsx`, `PurchaseOrderDetail.tsx` and `InboundShipments.tsx` expose explicit recovery and storage-read retry. Offline mutations dispatch immediately into recoverable failure rather than silently queueing after navigation. Captured operator/view identity is checked before dispatch and completion. A response from an earlier visit cannot redirect a later purchase. A stale recovery card pins its original key even if an earlier response has just cleared storage.

PO creation submits header and selected lines once. It requires at least one reviewed line; empty drafts remain available from the shipment list. Malformed source quantities, cross-PO identities and malformed warehouse options become retryable read errors instead of empty results or component crashes. These reads use separate cache keys when the projected DTO differs from another consumer. Both creation dialogs scroll within the mobile viewport, keeping their title and close control reachable.

Session recovery is not cross-device business deduplication. A different intent key may intentionally create another shipment. Do not clear an uncertain saved request or invent a new key to work around it. Restore access and retry the saved request. If saved evidence is corrupt or the command is dead, use the established command-recovery investigation before starting another intent; this batch does not perform production repair.

## Complete work lists

`shipment-work-list.repository.ts` shares one predicate between list and count, applies literal search/status/mode/warehouse filters before paging, and orders by creation time plus ID. `shipment-tracking.service.ts::getShipmentPage` reads each response in one repeatable-read, read-only snapshot. Cost filtering evaluates every matching candidate with the existing canonical costing/reconciliation evidence and retains only the requested page. `getLandedCostHealth` scans all eligible shipments; its limit controls displayed issues, not health totals. No posting or reconciliation formula is duplicated.

`ap-work-list.repository.ts` applies invoice/payment filters and literal search before paging, with count, rows and invoice PO labels from the same snapshot. Dedicated `/api/vendor-invoices/work-list` and `/api/ap-payments/work-list` endpoints preserve legacy array endpoints. Vendor-scoped payment invoice selection can reach older eligible invoices. The existing overdue classification and financial mutation rules are retained.

`purchase-order-work-list.service.ts` and its repository provide complete PO selectors. Invoice creation preserves its existing exclusion of cancelled/voided/closed POs; invoice detail linking preserves its broader existing scope and excludes already linked IDs before count/paging. Shipment line selection searches the complete PO population and preserves the existing line command's capacity authority.

`ap-work-list-query.ts` centralizes invoice-family invalidation for payment record/void, invoice changes/replacement and invoice creation from shipment costs. List/selector queries revalidate when operators revisit cached filters or pages. The screens distinguish loading, failure, empty results and an out-of-range page; failed reads do not present stale rows/counts as current evidence. Shipment money/stat cards explicitly describe only the displayed page and format integer amounts exactly.

## Validation and release boundaries

The accompanying validation record lists exact executed checks and their outcomes. New PostgreSQL suites are explicitly registered in `scripts/ci/postgres-test-manifest.ts` and guarded by `postgres-ci-shards.test.ts`; browser suites match the existing procurement CI selector. Test exclusion counts were not increased.

Coverage includes transaction rollback after history/audit/response-record failures; lost responses and changed-key payloads; same-key and distinct-key concurrency; numbering beyond 999; competing PO quantities; complete lists beyond former 100/200 limits; tied timestamps; literal searches; vendor/excluded-ID filters; deletion between count/page reads; malformed money/response contracts; payment record/void refresh; cached-page return; and desktop/mobile recovery, offline/storage errors and navigation boundaries.

No SQL migration is required. Deploy API and frontend together; an older cached client without a creation key must reload. Existing legacy list API contracts remain available. No external email, production database, production queue or production repair was used.

Remaining limits: offset paging is consistent within a response, not a frozen multi-request export under concurrent edits. Cost-follow-up membership scans all candidate evidence in bounded header pages; production-scale latency has not been measured. Local browser tests use controlled API responses, while PostgreSQL tests exercise the real command/read owners on disposable data. Neither proves production deployment or owner acceptance.

Remaining audit groups after this batch: receipt reversal retry identity; invoice ownership and PO financial authority; supplier balances/payment dates. Combined acceptance and deployed readback remain separate final work.
