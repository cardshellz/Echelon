# Procurement cancellation and policy authority

This release closes cancellation permission aliases and replaces the per-key procurement settings writer with one transactional command. It does not complete approval-to-email dispatch or receiving quarantine.

## Behavior and owners

- `purchasing.service.ts::cancel` locks current identity evidence and the purchase order. Unissued draft/pending/approved orders require `purchasing:cancel`; issued or physically advanced orders require `purchasing:approve`. Both `/cancel` and `/void`, plus direct physical cancellation, use this owner. Existing physical-state restrictions still apply.
- `executeProcurementSettingsCommand` requires an active, unscoped `settings:edit` grant. It validates the entire request, locks the canonical global DEFAULT settings row, compares `expectedRevision`, and commits every setting, its before/after audit, and the durable command result together.
- The PATCH request needs `Idempotency-Key` and either `{key,value,expectedRevision}` or `{updates:[{key,value}],expectedRevision}`. Retrying an uncertain result must retain the exact key and body. Reusing a key with different input is rejected. A stale revision requires a fresh read and a newly reviewed command.
- Purchasing decisions read the same DEFAULT policy. Missing DEFAULT, a warehouse assignment on DEFAULT, or invalid stored values produce a configuration error; they do not select another warehouse or invent approval defaults.
- Generic warehouse writes reject procurement fields and the policy revision. DEFAULT cannot be renamed, assigned to a warehouse, deleted, or replaced by renaming another row. Ordinary warehouse settings remain editable.
- Migration `900000003000017710001_procurement_policy_revision.sql` adds the nonnegative revision and protects `procurement.settings.updated` audit records against UPDATE and DELETE. Once this history exists, TRUNCATE of the entire audit table is rejected because TRUNCATE cannot preserve selected rows. Unrelated audit rows retain their existing UPDATE/DELETE behavior. Database-owner privileges can disable triggers; these are application-write protections, not a claim of protection from a database administrator.

## Deployment and verification

1. Before deployment, inspect the existing canonical configuration with this read-only query. Require exactly one row, with `warehouse_id IS NULL`, and review the actual existing policy. Do not seed a guessed approval setting to make deployment pass.

   ```sql
   SELECT id, warehouse_code, warehouse_id, require_approval, auto_send_on_approve,
          require_acknowledge_before_receive, hide_incoterms_domestic,
          enable_shipment_tracking, auto_putaway_location, auto_close_on_reconcile,
          one_click_receive_start, use_new_po_editor, use_new_reorder_cockpit
   FROM inventory.warehouse_settings WHERE warehouse_code = 'DEFAULT';
   ```

2. Use the normal migration owner to apply `900000003000017710001_procurement_policy_revision.sql` before the matching application. The migration preserves all existing policy values and initializes revisions to zero. Drain old application instances before permitting policy edits; old code lacks the new command contract and generic-write guard.
3. Confirm GET `/api/settings/procurement` returns all ten booleans and a nonnegative `revision`. A purchasing viewer may read; a settings editor may edit. Existing `inventory:adjust` alone no longer grants policy-edit authority.
4. Validate migration, permission revocation, concurrent edits, audit rollback/immutability, cancellation aliases and ordinary warehouse compatibility in the disposable PostgreSQL suites listed in `scripts/ci/postgres-test-manifest.ts`. Browser fixtures cover desktop/mobile permission display and uncertain response recovery. These fixtures do not prove production acceptance.
5. For a deployment rollback, preserve the revision and audit history. Do not drop the guards or erase command results to restore legacy editing. Restore compatible application code and investigate the recorded error instead.

## Failure recovery and remaining scope

- An invalid settings batch writes no policy changes. An audit or transaction failure leaves no successful receipt and can be retried with the original key.
- `PROCUREMENT_SETTINGS_STALE` means someone changed the reviewed policy. Refresh and review before sending a new command.
- `PROCUREMENT_SETTINGS_CONFIGURATION_INVALID` or `PROCUREMENT_SETTINGS_SOURCE_INVALID` requires investigation of DEFAULT; there is no fallback warehouse policy.
- Cancellation has terminal-state protection against repeated effects, but does not yet have a durable response-replay receipt. After a lost response, reload the PO and its history to determine whether cancellation committed before attempting another action.
- Email authority, stale queued documents, provider ambiguity, truthful sent state and receiving quarantine remain separate corrective work. This release is not evidence that the entire procurement-to-receiving workflow is repaired.


## Sourcing, reviewed imports and operator-recorded dispatch (2026-10-18)

This corrective batch covers F01/F02/F07/F15/F25. No SQL migration, production repair, provider configuration or automatic email send is included. Existing historical sent records are preserved; an old record is not new proof of provider delivery.

### Decision and write owners

- `recommendation-po-handoff.service.ts::createAutomaticHandoff` checks pending product demand under the graph/product locks before creating a draft. `rfq-sourcing-reservation.repository.ts::loadPendingPurchaseSourcingReservations` is shared with the RFQ owner. Unfinished draft/pending PO quantities and active unconverted RFQs prevent a second automatic obligation. Converted RFQs are represented by their linked PO, not counted twice. A partial reservation produces a visible review skip with exact quantities and recovery links; it does not silently resize or reprice a purchase.
- The `release` branch in `rfq-workflow.service.ts::executeInTransaction` uses the existing durable RFQ command transaction with a required reason and reviewed version. It releases only active, unconverted request lines and records before/after evidence. Linked purchase obligations and quote history remain. Legacy ordered lines without verified PO linkage block release for review. Stale review requires reload; an uncertain response retries the same command key and input.
- `purchasing.service.ts::sendPurchaseOrder` and `sendToVendor` now prepare approved terms or submit for required approval. Preparation never sets sent status, a sent timestamp or a sent event. Both PO creation screens say Save/Create & Review; the existing supplier document preview remains the document owner.
- `purchasing.service.ts::send` is the explicit external-send recording owner. It requires an authenticated actor, `confirmedSentExternally: true` and the reviewed `expectedUpdatedAt`. That version is checked before and under the lock. Approval policy/economics are rechecked; renewed approval returns pending approval without dispatch. The header, history and `sent_to_vendor` event commit together, with `method: operator_recorded`, `delivery_verified: false` and the source version. This is an operator attestation, not an email delivery or supplier acknowledgement. Generic physical transitions cannot bypass it. The detail dialog is bound to the initiating PO/version and ignores late responses after navigation.
- `ReceivingService.bulkImportLines` resolves normalized SKU/location identities before its existing locked write. Repeated incoming identities or multiple matching existing physical lines reject the whole import before any writes, with data-row errors. Separate physical lines are preserved. A unique line retains replacement-total semantics: a retry does not add quantities again. The CSV parser preserves numeric text for whole-count validation and rejects duplicate logical header aliases or mismatched row widths before posting. Optional blank cells must remain explicit. Ordinary invalid rows retain the existing explicit partial-acceptance behavior; review the returned errors and saved counts before correcting them.
- `supplier-evidence-import.service.ts` and `purchasing.service.ts::applyReviewedSupplierEvidenceImport` use one catalog-state fingerprint. Apply locks products, variants and existing catalog rows, compares the reviewed state, and only then changes quotes/preferences/audit. A changed quote, preferred competitor or newly created mapping rejects the entire batch. Refresh the preview and approve the newly displayed changes; never reuse an old approval hash after a stale conflict.

### Compatibility and recovery

Both PO editors retain the same request key and body for an unchanged uncertain save, and require validated response evidence before clearing that intent.

Legacy `advance_to_sent` and `/send-pdf` requests are retained as preparation-only aliases and explicitly report that no dispatch was recorded. Clients that record an external send must provide the reviewed-version attestation. Deploy the matching frontend and backend together; stale clients fail closed. There is no backfill of historical sent statuses or duplicate draft cleanup in this release.

A lost external-send response requires reloading PO history before trying again. Concurrent confirmations can produce only one sent transition, but this legacy lifecycle endpoint does not provide a durable identical-response replay receipt. RFQ release uses the existing durable command result and same-key recovery. Import failures preserve the CSV; a stale reviewed supplier import requires a fresh review, while an unchanged transient failure retains the reviewed intent.

### Verification boundary

Unit/HTTP tests cover validation and response contracts. Disposable PostgreSQL suites cover actual locks, both sourcing creation orders, concurrency, stale evidence, audit rollback and whole-batch import safety. Desktop/mobile browser fixtures cover the affected operator paths and navigation/late response recovery. The supplier import database suite and existing RFQ schema guarantees are registered in `scripts/ci/postgres-test-manifest.ts`; new client helper tests use the normal unit selection and browser specs use the procurement glob. Local tests are not production acceptance. Shipment recovery, receipt reversal identity, invoice/PO financial ownership and supplier balance/payment-date work remain in the recorded plan.

Local validation for this batch: 3,432 unit/contract checks (7 existing skips), 182 additional CI guards, 169 PostgreSQL cases across seven suites, and 160 unique desktop/mobile browser cases. Browser evidence includes corrected fixture/selector reruns; these are not represented as a single uninterrupted run. Application, server-test, client-test and changed-browser typechecks passed, plus the production build. No production acceptance or data repair is established.
