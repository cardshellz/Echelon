# Procurement cancellation and policy authority

This release closes cancellation permission aliases and replaces the per-key procurement settings writer with one transactional command. It does not complete approval-to-email dispatch or receiving quarantine.

## Behavior and owners

- `purchasing.service.ts::cancel` locks current identity evidence and the purchase order. Unissued draft/pending/approved orders require `purchasing:cancel`; issued or physically advanced orders require `purchasing:approve`. Both `/cancel` and `/void`, plus direct physical cancellation, use this owner. Existing physical-state restrictions still apply.
- `executeProcurementSettingsCommand` requires an active, unscoped `settings:edit` grant. It validates the entire request, locks the canonical global DEFAULT settings row, compares `expectedRevision`, and commits every setting, its before/after audit, and the durable command result together.
- The PATCH request needs `Idempotency-Key` and either `{key,value,expectedRevision}` or `{updates:[{key,value}],expectedRevision}`. Retrying an uncertain result must retain the exact key and body. Reusing a key with different input is rejected. A stale revision requires a fresh read and a newly reviewed command.
- Purchasing decisions read the same DEFAULT policy. Missing DEFAULT, a warehouse assignment on DEFAULT, or invalid stored values produce a configuration error; they do not select another warehouse or invent approval defaults.
- Generic warehouse writes reject procurement fields and the policy revision. DEFAULT cannot be renamed, assigned to a warehouse, deleted, or replaced by renaming another row. Ordinary warehouse settings remain editable.
- Migration `262_procurement_policy_revision.sql` adds the nonnegative revision and protects `procurement.settings.updated` audit records against UPDATE and DELETE. Once this history exists, TRUNCATE of the entire audit table is rejected because TRUNCATE cannot preserve selected rows. Unrelated audit rows retain their existing UPDATE/DELETE behavior. Database-owner privileges can disable triggers; these are application-write protections, not a claim of protection from a database administrator.

## Deployment and verification

1. Before deployment, inspect the existing canonical configuration with this read-only query. Require exactly one row, with `warehouse_id IS NULL`, and review the actual existing policy. Do not seed a guessed approval setting to make deployment pass.

   ```sql
   SELECT id, warehouse_code, warehouse_id, require_approval, auto_send_on_approve,
          require_acknowledge_before_receive, hide_incoterms_domestic,
          enable_shipment_tracking, auto_putaway_location, auto_close_on_reconcile,
          one_click_receive_start, use_new_po_editor, use_new_reorder_cockpit
   FROM inventory.warehouse_settings WHERE warehouse_code = 'DEFAULT';
   ```

2. Use the normal migration owner to apply migration262 before the matching application. The migration preserves all existing policy values and initializes revisions to zero. Drain old application instances before permitting policy edits; old code lacks the new command contract and generic-write guard.
3. Confirm GET `/api/settings/procurement` returns all ten booleans and a nonnegative `revision`. A purchasing viewer may read; a settings editor may edit. Existing `inventory:adjust` alone no longer grants policy-edit authority.
4. Validate migration, permission revocation, concurrent edits, audit rollback/immutability, cancellation aliases and ordinary warehouse compatibility in the disposable PostgreSQL suites listed in `scripts/ci/postgres-test-manifest.ts`. Browser fixtures cover desktop/mobile permission display and uncertain response recovery. These fixtures do not prove production acceptance.
5. For a deployment rollback, preserve the revision and audit history. Do not drop the guards or erase command results to restore legacy editing. Restore compatible application code and investigate the recorded error instead.

## Failure recovery and remaining scope

- An invalid settings batch writes no policy changes. An audit or transaction failure leaves no successful receipt and can be retried with the original key.
- `PROCUREMENT_SETTINGS_STALE` means someone changed the reviewed policy. Refresh and review before sending a new command.
- `PROCUREMENT_SETTINGS_CONFIGURATION_INVALID` or `PROCUREMENT_SETTINGS_SOURCE_INVALID` requires investigation of DEFAULT; there is no fallback warehouse policy.
- Cancellation has terminal-state protection against repeated effects, but does not yet have a durable response-replay receipt. After a lost response, reload the PO and its history to determine whether cancellation committed before attempting another action.
- Email authority, stale queued documents, provider ambiguity, truthful sent state and receiving quarantine remain separate corrective work. This release is not evidence that the entire procurement-to-receiving workflow is repaired.
