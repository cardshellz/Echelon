# Recover obsolete publication attempts before ATP cutover

## What this fixes

The existing publisher refuses conservative cutover writes while a legacy quantity request is still recorded as running or uncertain (`PUBLICATION_LEGACY_DRAIN_UNRESOLVED`). An old request may have lost its response or its local completion record. Neither its age nor a new inventory read proves how that old request ended.

This change adds an explicit, permission-gated handoff: retire **local request ownership** as `superseded_unknown`, retain its original record, then use the existing outbox to send and verify **current quantities**. It does not introduce a new ATP engine, change allocation formulas, or report an unknown request as successful.

Installing the migration does not recover attempts, publish inventory, switch authority, change orders, or activate a warehouse.

## Operational sequence

Use the existing controlled cutover window and the deployed authenticated application. Keep automatic publication workers paused while preparing and reviewing recovery; the exclusive publication lock independently rejects any still-active admitted provider owner.

1. Prepare a **fresh** cutover run using the existing preparation command. Do not reuse a failed/aborted run. Authority remains `legacy`; its configuration freeze and publication suppression must be owned by that run. Its conservative outbox must still be queued, with no provider write attempted.
2. POST `/api/inventory-planning/admin/publication-recovery/review-reconciliation` with `{ "activationRunId": "<prepared run ID>" }`.
3. Review the returned destinations, complete attempt list and `reviewHash`. The server derives destination identities and quantities from the persisted preparation; the caller cannot supply replacement accounts, SKUs, or quantities.
4. POST `/api/inventory-planning/admin/publication-recovery/reconcile-current` with:

   ```json
   {
     "activationRunId": "<same prepared run ID>",
     "expectedReviewHash": "<reviewHash from step 2>",
     "acceptUnknownRemoteOutcomes": true,
     "reason": "Retire obsolete local request ownership and publish verified current quantities.",
     "idempotencyKey": "<unique command key; reuse exactly on retries>"
   }
   ```

5. Run the **existing** conservative publication worker. Every required row still needs a newly admitted absolute-quantity write and a matching readback. Recovery itself never acknowledges an outbox row.
6. Use the existing cutover preview/commit and full-publication verification/completion commands. Recovery is not permission to skip these steps. An aborted preparation retains its audit history; existing catch-up replans current quantities rather than replaying old request payloads.

Both endpoints require `inventory_planning.activate`. The actor comes from the authenticated session. Retry keys are bound to that actor and the exact reviewed command. Replays return the original receipt even after cutover releases the freeze.

## Scope and retained evidence

- Only prior-epoch **legacy** attempts for Shopify/eBay destinations in this preparation can be superseded. Both channel connections and dropship store connections are supported through their existing quantity identities.
- Every member of a grouped write must belong to exactly one selected destination. Other accounts/locations remain untouched. Current-epoch, outbox and asynchronous initial-listing owners are not eligible.
- Requests/results, error codes, start times and original attempt fields remain unchanged. The only attempt-field change is `state = 'superseded_unknown'`. `completed_at` and `resolution_basis` remain unset for these unknown outcomes.
- `inventory.quantity_publication_reconciliations` stores the actor, reason, reviewed manifest, request/review/result hashes and immutable receipt. `inventory.quantity_publication_reconciliation_attempts` stores each complete original PostgreSQL row without JavaScript bigint conversion.
- A cutover event ties the receipt to its preparation. Receipt, before-images and all transitions commit together. Database guards reject unaudited supersession, later rewrites, partial receipts and deletion of this evidence.
- Recovery does not edit physical balances, reservations, held orders, picked/shipped flags, recipes, channel settings or runtime authority.

## Concurrency, failure and remaining uncertainty

Lock order is command retry lock → inventory/authority fence → **try-only** exclusive publication lock. Review also requires the publication lock. A live local owner, changed review, incomplete scope or changed preparation causes rejection without recovery writes. Failures roll back the entire operation; identical concurrent retries produce one receipt.

An old timed-out remote request cannot be proven cancelled by this mechanism. The operator explicitly accepts that historical uncertainty. A fresh matching readback proves the newly observed quantity, **not** termination of every earlier remote request. This recovery neither weakens normal provider readback checks nor automatically clears new uncertain requests. Existing current-state publication/catch-up remains responsible for later quantity updates.

Unrelated unresolved owners may still be reported by the existing global drain guard; this command does not silently retire them. This is a bounded legacy Shopify/eBay recovery, not a force-cutover endpoint.

## Implementation and verification

- Contract: `shared/types/inventory-publication-reconciliation.ts`.
- Selection/hash rules: `reviewPublicationReconciliation` in `server/modules/inventory-planning/domain/quantity-publication-reconciliation.ts`.
- Transaction, replay and scope recapture: `PostgresQuantityPublicationReconciliationRepository` in the corresponding `infrastructure` file.
- Permission/validation boundary: `registerQuantityPublicationReconciliationRoutes` in the corresponding `interfaces/http` file; registered in `server/routes.ts`.
- Database guarantees: `migrations/0716_inventory_publication_reconciliation.sql`.
- Unit/HTTP coverage: `quantity-publication-reconciliation.test.ts` and `quantity-publication-reconciliation.routes.test.ts`.
- Real PostgreSQL lifecycle coverage: `inventory-cutover-composition.integration.test.ts`, including active-owner rejection, stale review, rollback after audit failure, concurrent retry, immutable history, incomplete-receipt rejection, no recovery inventory changes, rejected mismatched readback, and full cutover with fresh verification. Scenarios cover historical provider quantities above, below and at zero ATP, plus negative provider stock.

Local disposable-database proof is not deployment or production proof. After merge/deploy, review the actual prepared run and record the new publication receipts before reporting cutover complete.
