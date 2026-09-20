# Carrier tracking recovery - September 2026

## Scope and evidence

This change repairs three independent blockers reproduced during the investigation
of order 63029. It does not manually fulfill an order or change a provider account.

- `normalizeTrackingSnapshot` (file-local helper in
  `server/modules/shipping/carrier-tracking.service.ts`) rejected a response from
  an exact ShipStation label endpoint when the saved account code was
  `ups_walleted` and the response said `ups`, even when tracking matched.
- `finalizeLabelTrackingPollAttempt` in
  `server/modules/shipping/carrier-tracking.repository.ts` used an untyped
  timestamp/NULL `CASE`. PostgreSQL inferred text and rejected the `confirmed_at`
  update. This rolled back attempt finalization and left the processing lease
  eligible for later recovery.
- `markEventReconciled` already scheduled a 30-minute retry for a matched outbound
  label with no shipment links. Migration 154's retry-shape constraint prohibited
  that state. The failed transaction left the oldest events unprocessed, so the
  bounded event scan repeatedly selected them instead of advancing.

The new PostgreSQL suite reproduces the finalization and retry-constraint failures
with the old implementation. Provider HTTP responses are mocked; tracking tables,
constraints, immutable-ledger triggers, repositories and transactions are real.

## Changed behavior and retained checks

Exact-label requests use the provider label endpoint plus normalized tracking
identity. A different returned label ID or tracking number still fails. The
response need not repeat a label ID when the request already targeted that exact
label endpoint. Raw account and carrier values remain unchanged in their evidence
records. Generic tracking requests, which have no exact-label endpoint, retain
the carrier comparison.

Poll finalization explicitly casts its `CASE` branches to `timestamptz`.
Migration 0686 permits matched events to schedule a retry strictly after their
last reconciliation; completed matches and voided labels retain null retries.
The application schema carries the same constraint. No historical records are
rewritten and no immutable evidence is removed.

Existing package-content, canceled-quantity, return-label, voided-label and
duplicate-command protections are not bypassed. Carrier possession remains
separate from sales-channel fulfillment at label creation. This fix does not
change email policy or grant item fulfillment authority from tracking alone.

## Validation

- Unit regressions cover `ups_walleted` / `ups`, `stamps_com` / `usps`, mismatched
  tracking, mismatched returned label IDs and generic lookup carrier mismatch.
- The PostgreSQL recovery suite covers all four poll outcomes, expired leases,
  stale-worker rejection, transactional rollback, concurrent claims and duplicate
  prevention, advancing past unlinked labels, retry after linkage, return/void
  exclusion and invalid retry states.
- The existing package-allocation PostgreSQL suite remains part of acceptance.
- The new suite is included in the PostgreSQL CI manifest, not just local tests.

Local verification on 2026-09-20:

- Recovery PostgreSQL suite: 10 passed; existing package-allocation PostgreSQL
  suite: 106 passed. No integration test above was skipped.
- Full unit run: 13,805 passed / 39 skipped. After adding the schema-parity test,
  the final run passed 13,805 tests, skipped 39 and hit one unrelated `fetch:
  bad port` failure in `po-create-send.routes.test.ts`. Its unchanged 31-test file
  passed on rerun. That helper binds port 0 and then uses native fetch; no shipping
  code participates in that test.
- Application and server-test TypeScript checks passed; production build passed.
- Existing migration-text tests require LF text. The local full-suite runs used
  LF for migrations 0678 and 0683, matching the committed content and Linux CI.
  There is no content change to either migration in this fix.
- Publication preflight caught main claiming 0684 and 0685 after local validation.
  This migration and its test references were renumbered to 0686 against fetched
  main `a06e994a3`. Recheck again before merge if main advances.

## Deployment, risks and completion checks

1. Deploy code and migration 0686 together through the normal migration runner.
   Recheck the numeric prefix against current main before publishing.
2. The constraint replacement validates existing reconciliation rows and takes a
   table lock. It expands the previously accepted states, so previously valid
   rows remain valid. This is not a bulk event replay or an inventory adjustment.
3. Existing workers resume expired polling leases and pending event batches.
   Do not increase batch sizes or start an unbounded backfill to catch up.
   Polls already in `review` are not automatically reset by this migration;
   inspect and explicitly reprocess a proven case through the existing workflow.
4. Confirm finalization no longer logs the `confirmed_at` type error and matched
   unlinked events no longer fail `carrier_tracking_reconciliation_state_retry_shape_chk`.
   Verify new reconciliation progress rather than only counting stored events.
5. For 63029, follow the exact label through its event, unique dispatch command,
   package allocation and channel command, then read back Shopify line quantities
   and tracking. Do not call the customer order repaired based solely on tests or
   a successful carrier poll. Any scoped production replay requires approval.

Code rollback may leave the expanded constraint in place. Do not restore the old
constraint while valid matched retries exist, and do not delete their audit
history to force a rollback. Production queue progress and Shopify completion
remain unverified until deployment and readback.
