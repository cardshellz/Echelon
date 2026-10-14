# Purchase-order email document gate: cutover and recovery

This release changes supplier-document content validation. It does **not** establish a complete approval-to-dispatch workflow, prove supplier receipt, or guarantee exactly-once email delivery.

## Contract and owners

- `buildPurchaseOrderEmail` produces the supplier projection and hashes the final HTML, including the optional message. The outbox stores immutable contract version, HTML SHA-256, source-projection SHA-256, and purpose. The source hash is content identity; it is not an approved historical revision.
- `enqueuePurchaseOrderEmail` and `replayDeadLetterPurchaseOrderEmail` accept only supported, valid `current_copy` snapshots. PostgreSQL repeats that gate on insert and every lease acquisition/renewal. `processPoEmailOutboxBatch` checks the persisted HTML before the provider call.
- `261_po_email_document_gate.sql` adds a hold to every legacy queued, processing, and dead-letter record. It preserves the original status, message, recipients, attempts, timestamps, errors, provider evidence, and idempotency key. Completed sent/partially-sent records remain unchanged.
- Holds and content metadata cannot be edited or cleared. A held failed record cannot be replayed. Retrying its original enqueue key returns that original held record, which the UI labels explicitly.
- Existing provider-accepted records remain provider evidence. New UI/history wording says “accepted by provider”; it does not claim recipient delivery. A manual/offline PO status is separate business evidence and is not invented as an SMTP result.

## Release sequence

1. Inventory active application/worker instances and suspend email enqueue/replay traffic during cutover. Set `PO_EMAIL_OUTBOX_WORKER_DISABLED=true` on **all** instances and restart/stop the old worker processes. The flag is read at startup in `server/index.ts`; setting it on a running process does not stop its current callback.
2. Drain or investigate every processing lease before migration. Record delivery ID, immutable Message-ID, lease/attempt evidence, provider result and operator decision. A worker may already have called the provider: database constraints cannot retract that call or prevent a paused old process from resuming it. Do not use lease expiration alone as proof that no email was accepted.
3. Capture read-only counts by status and identifiers of queued/processing/dead-letter rows. Use the ordinary deployment migration owner to apply `261_po_email_document_gate.sql` atomically, then deploy the matching application build while workers remain disabled. Do not independently execute parts of this SQL or label old HTML as contract version1.
4. Verify the counts and saved transport/content fields are preserved; all legacy pending/failed rows have `LEGACY_DOCUMENT_UNVERIFIED` and a hold timestamp; pre-existing completed rows do not acquire a hold. Verify the new application lists held deliveries and suppresses replay.
5. Confirm a newly built current-copy snapshot has version1, matching HTML hash, source hash and purpose. Validate with the release's disposable PostgreSQL suite and controlled non-production provider fixture. Production test sends require a separately approved recipient and content.
6. Resume enqueue/replay traffic with the matching build. Enable the worker only after old processes are stopped and unresolved in-flight evidence has an explicit disposition. Watch enqueue rejection codes, worker errors, holds and provider acceptance. An old writer is intentionally rejected by the database instead of inserting unverifiable payloads.

Read-only reconciliation query after migration (does not expose saved bodies or recipient addresses):

```sql
SELECT status, document_hold_reason, count(*) AS deliveries
FROM procurement.po_email_outbox
GROUP BY status, document_hold_reason
ORDER BY status, document_hold_reason;
```

## Held history and uncertain transport recovery

Review the original saved document privately, current PO and supplier terms, and provider logs using the saved Message-ID. Old snapshots may contain internal notes, incorrect totals, or cancelled lines. **Do not regenerate or overwrite already saved/issued history, clear holds, blindly replay legacy HTML, or bulk backfill verification metadata.**

If the provider accepted an old message, preserve that evidence and arrange any required supplier correction as a reviewed new communication. Acceptance and recipient delivery remain different facts. If a still-running legacy callback returns real acceptance after the hold was added, the guarded processing-to-sent completion can record it with the hold retained; a hold must not erase a real outcome.

For a legacy message proven not accepted and still needed, review the current supplier document, confirm applicable purchasing authorization, and use a **new** email intent. Keep a remediation record linking the old delivery ID and the new delivery ID, actor, evidence and decision. This release does not add an automated hold-release or historical remediation command.

If acceptance is unknown, retain the hold and resolve provider evidence before choosing a new send. SMTP retry and acceptance-versus-database-commit ambiguity predate this slice and remain open; a stable Message-ID does not prove provider deduplication. Do not claim exactly-once delivery. Manual/offline issuance needs its own evidence and must not be fabricated by editing outbox results.

## Failure and rollback boundaries

A renderer/build rejection returns a classified error without queue insertion and logs only code, PO ID and actor. Invalid persisted snapshots cannot obtain a new lease; the worker also holds invalid claimed content before an external call. Document holds are additional evidence, not new terminal delivery states.

If validation or deployment fails, keep email workers disabled and fix forward. Do not remove the gate or roll back to writers that omit metadata: they will fail closed, and old workers could already hold a pre-cutover snapshot in memory. No part of this runbook authorizes production data changes, supplier notifications, or automated historical repair.

## Local proof and limits

The PostgreSQL integration suite provisions no application environment itself: it requires an explicit disposable loopback URL, refuses existing procurement/identity schemas and never loads dotenv files. It covers migration preservation, null/future/tampered metadata, old-writer rejection, hold immutability, lease/replay races, expired verified lease renewal, and provider acceptance with mocked transport. Unit checks cover service rejection, worker pre-send inspection, exact UTF-8 hashes, and UI wording/replay eligibility.

These checks do not prove production deployment, actual provider behavior, recipient delivery, or the remaining approval/send policy corrections.
