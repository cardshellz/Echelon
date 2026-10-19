# Receipt reversal recovery

Corrective scope: R18/R19. Implementation base: `a643f4f91c74d99a431f89759b546acc1daf68b8` (2026-10-19). This slice covers line and whole-receipt reversal commands and their receiving UI. It does not change the financial authority of other purchasing or AP commands.

## Summary of changes

A reversal now retains one exact command identity across a lost response, reload and explicit retry. The durable financial command result commits in the same database transaction as the compensating receipt, inventory, PO and AP writes. A saved rejection retains its original HTTP status. The receiving screen keeps an unresolved request until it receives a verified success or the matching durable rejection.

## What the code definitely does

| Owner | Execution path and evidence |
| --- | --- |
| `receipt-reversal.routes.ts` — `registerReceiptReversalRoutes` | Preserves both existing POST URLs. Requires authentication and purchasing approval, validates canonical positive resource IDs and command headers, rejects query parameters, and passes the unchanged request body to the command owner. Both endpoints use the same reversal namespace. |
| `receipt-reversal.commands.ts` — `hashReceiptReversalCommandIdentity`, `createReceiptReversalCommands` | Binds action, target, authenticated operator and exact raw body to the key. A different intent cannot reuse a result. Validates the input and response, claims the existing financial command ledger, and passes its transaction to the reversal service. A bounded SHA-256-derived audit key fits existing reversal columns even for a 200-character HTTP key. |
| `command-results.repository.ts` — `executeClaim` | Existing owner verifies the lease and saves the terminal response in the same transaction as the supplied work. Transaction rollback preserves a recoverable reservation rather than a partial successful reversal. This shared infrastructure is reused without modification. |
| `receipt-reversal.service.ts` — transaction entry points | Takes the shared inventory cost-graph lock before receipt and purchase locks. Retains frozen-unit/original-posting checks, remaining-quantity checks, exact lot cost evidence, the public inventory writer, PO received-counter correction and AP matching reopen. Whole-order commands select all remaining quantities at first execution; replay returns that original saved group. |
| `receipt-reversal.repository.ts` — `readReversalKeyEvidence` | Compares legacy keys literally. Percent and underscore characters cannot expand a SQL LIKE pattern. Existing reversal evidence without the matching durable command response blocks new compensation. No historical response or group membership is fabricated. |
| `receipt-reversal-command.ts`, `persistent-financial-intent.ts` (client) | Saves a validated, operator-scoped intent before sending. A response must identify the exact actor, receipt, line/order, key and requested line quantity. Lost, malformed, permission and uncertain responses retain recovery. Clearing requires verified success or a durable rejection for that key. |
| `use-receipt-reversal.ts`, `Receiving.tsx`, `ReceiptReversalRecoveryNotice.tsx` | Makes recovery available in receipt detail, the receiving list and unavailable-detail states. Disables new reversal submission while recovery is unresolved. Stops stale receipt/operator callbacks from altering the current screen. Explicit retries reuse the visible saved request; automatic mutation retries are disabled. Refreshes existing purchase-cost and reversal reads without treating them as command-result evidence. |

## Compatibility and operator recovery

The routes and existing success fields remain; the response adds verifiable command identity. Request schemas now reject unknown fields, string quantities, invalid booleans and unsupported integer bounds. A reason must be at most 900 characters (the shared reversal limit) so the inventory owner's audit prefix also fits its journal contract; no reason is silently truncated. The existing negative-inventory override remains subject to the inventory owner's policy and is unavailable after quantity-ledger activation.

For an uncertain result, use **Retry saved receipt reversal**. Do not submit a newly keyed correction merely because the first response was lost. A saved rejection tells the operator what must be reviewed before creating a new intent. Authentication failures retain the request until the same operator has access again.

Legacy reversal history without a saved command response returns `RECEIPT_REVERSAL_EVIDENCE_REVIEW_REQUIRED`. Review the original audit entries and physical/PO state before deciding on another correction. The application cannot reconstruct a historical whole-order response or its original complete membership. The receiving history now validates the returned rows and receipt identity, with explicit loading, empty, failure and retry states. A failed or malformed history read blocks fresh reversals while keeping saved-command recovery accessible. Existing posted history is preserved, and this release supplies no data repair.

Recovery is stored in browser session storage, scoped to the signed-in operator. It survives reloads in that session, but browser session deletion, closing the session, or moving to a different device is not cross-device recovery. The durable server response remains the authority. A storage read/write failure blocks new dispatch; a failure to clear confirmed recovery permits retry of the same saved key.

## Assumptions, risks and failure modes

- No production prevalence, affected quantity or financial loss is inferred from source. No production records were read or changed.
- Existing whole-order semantics remain: all remaining quantities at first execution. This change does not introduce a new reviewed-quantity snapshot policy.
- Receipt stock, PO counters, original-unit evidence, AP matching flags and saved result roll back together on a business-transaction failure. Unknown infrastructure failures retain the original key for retry; known business rejections are durable outcomes.
- Graph-first ordering matches other physical/cost commands, but the shared lock can cause contention. No production latency benchmark is claimed.
- Retention or corruption that leaves posting evidence without a valid command result fails closed. It is not permission to reapply a compensation.
- Purchase-cost cache invalidation refreshes related views. This is not a new cost-completion calculation or automatic supplier-balance repair.
- The small saved-intent store extraction also serves shipment creation. Its existing recovery behavior is covered by regression tests.

## Test coverage and evidence boundary

Unit/HTTP tests exercise identity changes, strict inputs, auth/permission, stored success/rejection status, invalid saved results, retry headers, legacy evidence and sanitized infrastructure failures. Client tests cover saved intent ownership, storage failure, pinned-key retry and response verification. The receiving-unit PostgreSQL suite executes real pre-opening inventory/PO/AP owners and command-result persistence, including competing keys, held locks, rollback and replay. Activated-ledger coverage additionally verifies the combined command through the canonical quantity journal. Desktop/mobile browser fixtures exercise lost responses, reload, rejection, navigation/operator changes, permission, storage failure and recovery from unavailable detail.

Tests are automatically selected by existing unit and procurement-browser globs; both modified PostgreSQL suites are already listed in `scripts/ci/postgres-test-manifest.ts`. No new migration or dependency is required. Local validation, hosted CI, merge, deployment and independent production acceptance are separate proof states. Final local results are recorded below; no deployed behavior is implied by this implementation document.

## Local verification (2026-10-19)

- 4,086 backend/shared/platform/CI checks passed across 248 files; seven pre-existing database-dependent PO-exception cases remain skipped in the unit harness. All new reversal cases executed. Nine CI/migration guard files contribute 274 of these passes.
- 67 client units passed, including all 24 existing shipment-creation command tests.
- 156 PostgreSQL cases passed with zero skips across receiving-unit integrity (57), receiving-close integrity (22), receiving-quarantine (20), quantity ledger (46), and quantity-ledger hardening (11). Each suite used a verified disposable local database; all were removed and the task-owned cluster stopped.
- 150 desktop/mobile browser cases passed: reversal recovery (34), receiving import (18), receiving integrity (20), receiving units (48), and shipment creation (30). Controlled API fixtures and screenshots establish client behavior, not live production integration.
- Application, server-test, client-test and changed-browser typechecks passed. Production build passed; existing bundle-size warnings remain. Migration validation passed against fetched `origin/main` at the implementation base (526 migration identities, no new SQL).

A local cost-reporting HTTP fixture initially failed because Fetch rejected its OS-assigned port before dispatch. Its transport now uses native Node HTTP with a timeout and validated bound address; all seven existing assertions remain and pass. Focused final HTTP results supersede the corresponding initial files without double-counting. A temporary browser import race during parallel development was resolved before the clean final 150-case run. These initial failures are retained in local evidence rather than counted as final success.

Evidence directory: `outputs/procurement-receipt-reversal-recovery-2026-10-19` in the main local workspace. It contains JUnit reports, logs, final summaries and controlled screenshots. Release publication, hosted CI and deployment must be recorded separately.