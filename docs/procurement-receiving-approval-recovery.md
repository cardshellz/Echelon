# Receiving entry and reviewed PO approval recovery

## Scope and source

This batch addresses the receiving retry and stale approval defects from the procurement closeout. Implementation started from main commit `ea858e32896495113155c240e123dc5504485347` and incorporates current main `da7e0ea8eba57c808d44528d03a1d1ad18baf1cc`. That advancement changes CI only; all 39 task files were hashed before/after integration and remained unchanged. Validation uses an isolated checkout, disposable loopback PostgreSQL databases and local browser fixtures. It does not repair historical records or establish production deployment or acceptance.

## What changed and why

### Manual receiving entry

`Receiving.tsx:entryMutation` sends manual receipt creation and Add Line through `useReceivingEntry` and `createReceivingEntryClient`. The client saves the operator's original command and key in session storage before sending. Transport errors, malformed success responses, permission failures and unavailable detail reads retain that command. A matching verified success or the command's recorded terminal rejection releases it. A later independent physical batch gets a new key, even when SKU, location and quantity are identical.

`registerReceivingEntryRoutes` owns both POST entry points. It checks authenticated session identity and `inventory:adjust`, rejects noncanonical IDs and unexpected query parameters, and requires an idempotency key. `createReceivingEntryCommands.execute` binds actor, action, receipt and payload to one durable command identity across both endpoints. Current Identity authority is checked before replay and locked again inside a new mutation. `ReceivingService.executeEntryInTransaction` writes the receipt/line, totals and before/after audit evidence in the transaction used to save the durable result. An audit or result failure rolls the mutation back; retry uses the original key through the existing command ledger.

`receivingEntryResultMatchesRequest` is the shared server/client result verifier. It checks the returned command identity and requested receipt/line data, including the selected pack factor and exact cost representation. The server verifies before commit and when replaying; the client verifies before clearing recovery. A replay is an old command result, so `Receiving.tsx:entryMutation.onSuccess` performs a fresh detail read rather than installing that historical snapshot over newer counts.

The page keeps recovery accessible from the list, receipt, creation dialog and Add Line dialog, including failed detail reads. Unresolved entry commands prevent conflicting actions in this page. Operator and navigation guards prevent delayed responses from modifying another operator's or receipt's view. Storage failures block a new entry before dispatch. Restoring connectivity does not automatically send a saved command.

PO/shipment-sourced receipt creation and CSV import keep their existing owners. Internal `ReceivingService.createOrder`/`addLine` methods remain for compatibility; they do not themselves create a durable HTTP command. The corrected public manual entry routes use the new command owner. These changes do not infer duplicate physical batches from matching goods.

### Approval of reviewed purchase terms

The PO detail response includes `approvalLinesFingerprint`. `purchaseApprovalLinesFingerprint` projects persisted active line columns, sorts by ID and hashes canonical JSON. Presentation joins and cancelled lines are excluded. This also detects a catalog SKU synchronization that changes a line without advancing the PO header or total.

`PurchaseOrderDetail` captures the displayed timestamp, exact total and fingerprint. `createPurchaseApprovalClient` saves that original review with its key before sending; recovery does not substitute an unseen newer review. `createPurchaseApprovalCommands.execute` verifies command identity, current authority and matching fresh/replayed success. `approveInTransaction` locks the graph, Identity authority, PO and line economics, then compares all three reviewed values before approving. It refuses to silently normalize legacy amounts during approval. The approved header, status history, immutable approval event and command result commit together.

For approvals required by the configured tier, `sendWithLockedEconomics` uses `approvalCoversLockedEconomics` to compare the new approved event's line fingerprint with current locked lines before document preparation or recorded external dispatch. A mismatch returns the PO to pending approval. Recovery is return to draft, save/review current terms, submit and approve a new review, then prepare/record dispatch. Existing authority/tier rules remain in force. Policy-based automatic approval is unchanged.

Historical and amendment approval events without a reviewed line fingerprint retain their existing amount, authority and timestamp checks. This batch does not invent historical review evidence, backfill approvals or redesign amendment approval. It also does not send supplier email: the existing dispatch command records an operator's external-send confirmation.

## Operator recovery and failure modes

| Observed outcome | Required behavior |
| --- | --- |
| Lost response, malformed response or offline request | Keep the saved request and use its explicit retry; never create a replacement intent to guess whether it committed. |
| Receipt/PO GET fails after a confirmed command | Keep command confirmation separate; reload the detail read without repeating a new mutation. |
| New counts arrive before an Add Line replay | Confirm the original entry, then read current receipt state. |
| Permission revoked or operator switched | Preserve the original operator's saved intent; no replay to an unauthorized actor. Restore authority before recovery. |
| Storage cannot be read, written or cleared | Block new intent creation and show an actionable recovery error. Clearing storage is not a recovery action. |
| Changed SKU pack factor | Record rejection of the original entry, refresh/reselect the SKU, review the count and submit a new intent. |
| Changed PO version, total or persisted line terms | Reject the old review. Load and review the current PO before submitting a new approval. |
| Audit or durable-result write fails | Roll back business writes and retry the same command after the ledger's retry delay. |
| Identical goods from two intentional batches | Preserve two entries with different keys. |

Session storage preserves recovery across reloads in the same browser session; it is not a cross-device recovery index. External clients must retain their own command keys. Old open clients lacking the new key/review contract must reload. Unknown external callers and production command-ledger health were not exercised here.

## Additive audit migration

`migrations/900000027000019030001_receiving_entry_audit_guard.sql` extends `guard_receiving_integrity_audit_history` for `procurement.receiving.entry.create` and `procurement.receiving.entry.add-line`. It retains all three existing protected actions and rejects UPDATE, DELETE, TRUNCATE and rewriting an unrelated row into protected evidence. It updates the guard function, not historical business or audit rows.

The actual [draft PR #1903](https://github.com/cardshellz/Echelon/pull/1903) owns the allocation, as required by [migration allocation](migration-allocation.md). Its metadata declares the existing receiving discard guard and the latest migration visible during allocation as dependencies. The SQL was transferred without changing its bytes: SHA256 `11a30f13ffa4265ebb02d784bf1c4d684da2c2180605aa35548ffd466317c9c2`. Both receiving integration fixtures load the final filename. Allocation creates local source/metadata only; it does not execute SQL.

Publication also incorporates main `d5d3cc45c442366f972b4aabb1de71c2c5c66836`, including its PO shipment-progress UI. Final allocation/merge validation is recorded separately under `outputs/procurement-receiving-approval-2026-10-23/publication-1903/`; the implementation checkpoint below retains its original source and counts. Hosted checks and production deployment remain separate evidence.

Retain the additive guard during application rollback. Removing it would permit alteration of already-recorded entry evidence. No migration has been applied to a live database by this task.

## Validation and remaining boundaries

`receiving-entry-recovery.cases.ts`, imported into the existing `receiving-close-integrity.integration.test.ts`, exercises real Identity, command ledger and receiving/inventory owners. It covers response loss followed by one stock posting, distinct identical batches, concurrent requests, actor/action/target/body conflicts, revoked authority, changed pack factor, transaction rollback and exact-key recovery. The same suite imports `receiving-entry-http.cases.ts`, which drops the actual HTTP response stream after creation/Add Line commits, then retries through the real routes and default command repository. It proves current HTTP permission checks, closing one 25-piece batch through HTTP, replay after closure and repeated close without additional stock. The fixture adapts the session/DB connection, disables external channel synchronization and uses limited receipt-cost ports; it does not claim external delivery or full cost posting. `receiving-audit-immutability.integration.test.ts` installs both existing guards and the pending successor and checks protected writes plus unchanged historical rows on upgrade.

`purchase-approval-authority.integration.test.ts` exercises the real approval routes, Identity, PostgreSQL locks, audit and command ledger. Its review/recovery cases include stale totals, same-total changed lines, the actual catalog SKU synchronization owner, identical/equal-timestamp changes, concurrent approval, committed-response loss, authorization changes, injected audit/result failures and preparation/dispatch invalidation followed by fresh-review recovery.

`procurement-receiving-entry-recovery.spec.ts` and `procurement-purchase-approval-recovery.spec.ts` cover desktop/mobile recovery, navigation, operator changes, offline behavior, blocked/corrupt storage and failed detail reads. Related receiving, importing, quarantine, reversal, sourcing, supplier document/preparation/dispatch and navigation specs are regressions. These browsers use mocked HTTP; PostgreSQL tests prove real owner transactions separately. A connected browser-to-real-HTTP acceptance journey and live production acceptance are not claimed.

The validation record is `outputs/procurement-receiving-approval-2026-10-23/validation-summary.json` in the task's primary workspace. It names exact reports, counts, source hashes, corrections and remaining skips. Tests and logs are local evidence, not hosted CI or deployment evidence.

Local results: 4,927 unit/guard cases passed with seven unchanged skipped unit cases; 261 cases passed across eight disposable PostgreSQL suites; 354 unique desktop/mobile browser cases passed. The post-integration CI lane passed all 406 guard cases (some overlap the earlier unit selection; the counts are not additive). Creation fixture corrections were rerun over all 36 receiving recovery browser cases, and the final approval UI passed all 22 approval recovery cases. The real HTTP receiving suite passed all 40 cases. Exact compiler/build outcomes and final source evidence are recorded in the validation record. Cleanup verified zero task databases and zero other clients before stopping the task's local PostgreSQL cluster.

Remaining procurement work stays separate: manual PO/RFQ recovery, number allocation, AP clock propagation and final connected acceptance/performance checks from the closeout. Historical cost cleanup for PO 144, PO 149 and shipments 95/97 remains a separate read-only preview/approval track. None of those records were changed by this batch.
