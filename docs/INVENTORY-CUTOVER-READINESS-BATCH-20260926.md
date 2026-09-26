# Inventory cutover readiness batch

This change packages the three runtime defects found during cutover preparation and the approved historical-records cleanup tooling. **Deploying this PR does not activate canonical inventory/ATP, apply a stock opening, run cleanup, or retry provider notifications.** It introduces no migrations, startup repair, scheduled recovery, UI changes or configuration changes.

## Runtime changes

| Problem | Change | Proof |
| --- | --- | --- |
| Accepted OMS demand could reference a terminal WMS order omitted from the census when no residual journal remained. | Capture OMS demand first and include WMS orders/items by exact OMS line foreign key. Do not infer identity from order numbers or SKUs. | `inventory-cutover-reconstruction.integration.test.ts` covers terminal owners, bigint identities, missing parents, quantity/SKU mismatches and unchanged rows. |
| Capturing a completed owner could otherwise make its unfinished accepted demand appear covered. | Continue blocking terminal owners unless the captured fulfilled quantity equals the demand quantity; both strict and reviewed openings retain the check. | Reconstruction and opening unit tests cover unfinished terminal demand. This does not waive unknown custody or re-create completed claims. |
| Replaying an unchanged receipt item executed a no-op SQL UPDATE, which the production immutability guard correctly rejected. | Update an existing item only when attaching a missing link; verify every retained identity, quantity and link afterward. Keep the immutable trigger and its attachment requirements intact. | `channel-receipt-immutable-replay.integration.test.ts` installs the actual migration guard; exercises digital-only and engine-echo repeats, permitted attachment, conflicts, rollback and concurrency. |
| A non-authorizing update recomputed a refunded/cancelled/review status from historical paid quantity. | Preserve the established disposition on non-authorizing observations. Quantity formulas, authorizing topics, payment provenance and disposition-owner commands are unchanged. | `oms-line-authority-disposition-replay.test.ts` and a real-PostgreSQL cutover-query replay suite prove repeated updates preserve the disposition and do not hide unrelated live demand. |

The new PostgreSQL suites are registered in the existing eight-shard CI manifest. Coverage increases from 95 to 97 suites; the original 70-file digest is unchanged. Offline cleanup-contract tests and strict checks of the maintenance scripts are added to the normal CI job.

Runtime ownership: [`capture`](../server/modules/inventory-planning/infrastructure/inventory-cutover-reconstruction.repository.ts#L38) passes exact accepted line IDs to [`readWmsCutoverReconstruction`](../server/modules/wms/inventory-cutover-reconstruction.reader.ts#L16); [`planCutoverReconstruction`](../server/modules/inventory-planning/domain/inventory-cutover-reconstruction.ts#L129) enforces complete terminal fulfillment. [`persistReceiptItems`](../server/modules/oms/channel-fulfillment-ingress.repository.ts#L1060) owns immutable receipt attachment. [`statusAfterNonAuthorizingUpdate`](../server/modules/oms/oms-line-authority.ts#L110) is used only by the non-authorizing branch of `deriveOmsLineAuthority`.

### PR CI follow-up: split-label transaction contention

The [first PR CI run](https://github.com/cardshellz/Echelon/actions/runs/36242858857/job/108406528062) failed the concurrent split-relabel integration case at `reconcileEbayLabelReplacement`'s `defer` upsert. PostgreSQL recorded four serialization conflicts between 12:45:56.364 and 12:45:56.467 UTC on separate connections. The workflow already retried full serializable transactions, but did so immediately and stopped after three attempts. Actual `pg.DatabaseError` classification was verified; this was not fixed by weakening isolation, catching success-shaped errors or changing quantity expectations.

[`createPackageAllocationLabelCommercialWorkflow`](../server/services/package-allocation-label-commercial-workflow.ts#L45) now waits 50ms and then 100ms between retryable failures, **after** rollback and client release and **before** acquiring the next connection/snapshot. The three-attempt cap, permanent-error behavior, logging, provider-call prohibition and all transaction/quantity guards remain intact. Persistent contention still surfaces an error after the third attempt; the backoff is not a guarantee of success under arbitrary load.

The [unit regressions](../server/__tests__/unit/package-allocation-label-commercial-workflow.test.ts#L67) prove release-before-wait, bounded delays/exhaustion and real driver error handling; two delay/contention checks failed before the runtime change. The [integration case](../server/modules/shipping/__tests__/integration/package-allocation-ledger.repository.integration.test.ts#L1338) now synchronizes all three initial snapshots, asserts that a real PostgreSQL `40001` occurred, and requires all contenders to complete with the same unchanged package/quantity/idempotency assertions. It waits for all contenders before fixture teardown.

Evidence limit: the original CI log does not correlate connection IDs with each workflow attempt, so the exact losing retry sequence is not proven. The initial local full suite and twelve unconstrained reruns passed even before the fix; controlled conflict coverage replaces reliance on that timing luck. No live incident or production recovery is inferred from this test failure.

Follow-up validation: **266 related unit tests passed** in 19 files; **all 132 package-ledger PostgreSQL integration cases passed**, with none skipped; **ten further controlled three-way races passed** (each asserted a real serialization conflict and exact final quantities). Application, server-test and client-test TypeScript checks passed. The dedicated local test database was removed after its connections closed. These checks do not replace the new GitHub CI run or prove production execution.

## Historical records cleanup tooling

The exact approved batch concerns 42 closed-provider historical OMS lines. The saved review proposed 24 actual line changes, 29 order-header changes and four records of refunds already issued. It preserves the other 15 lines, including the nine lines on a separate live order. These are saved-review counts, not a current production census.

Files under `scripts/inventory-cutover-records-*-20260925.ts` separate:

- **Proposal:** offline normalization and complete-order comparison of hash-pinned review artifacts; no database connection.
- **Execution core:** an explicitly called function accepting a database pool and validated request. No CLI, credential lookup, application bootstrap or automatic production hook.
- **Schema readback:** explicit read-only PostgreSQL connection and transaction; exports metadata only.
- **Rehearsal:** rejects remote servers and uses only newly created, uniquely named loopback test databases. Private and cost fields are synthetic. It removes only databases it created.

The execution core validates the literal approved line scope, plan hash, evidence and writable fields before connecting. It acquires the admission fence, checks legacy authority/revision, obtains a batch lock and locks ordered target rows. It compares complete row fingerprints and the actual enabled trigger/function definitions. It preserves normal internal intake and Archon order-outbox effects.

Maintenance ownership: [`prepare` / `validateChange`](../scripts/inventory-cutover-records-execution-20260925.ts#L106), [`lockScope`](../scripts/inventory-cutover-records-execution-20260925.ts#L157), [`protectedRows`](../scripts/inventory-cutover-records-execution-20260925.ts#L175), [`applyInsideTransaction`](../scripts/inventory-cutover-records-execution-20260925.ts#L256) and [`executeRecordsCleanup`](../scripts/inventory-cutover-records-execution-20260925.ts#L350). The [offline contract tests](../scripts/inventory-cutover-records-execution-20260925.test.ts) use no private artifacts or database.

One serializable transaction records the existing refunds, lifecycle changes and actor/source/before-after audit events. It checks protected stock/reservation, WMS/outbound, cost, receipt, provider-command header, review, non-target and prior-audit rows before commit. It does not invoke inventory posting, refund issuance, shipping or provider APIs. A repeat verifies the applied state and audit records and performs zero writes. Changed evidence, conflicting requests, missing audits or unexpected protected changes fail closed. An uncertain commit response requires retrying the **identical** request, not generating another command identity.

This is a bounded maintenance operation, not a new general-purpose order editor. There is intentionally **no live execution wrapper** in this PR. The date-specific request/source files are local protected evidence and are not committed. A fresh checkout cannot run the evidence-dependent proposal/rehearsal without those reviewed inputs; artifact-free contract tests run in CI.

## Verification and remaining boundaries

Validated again on the isolated PR branch based on `origin/main` at `80be0d59d5b3ebdfd5890a56cb8c772f09d2c64b` on 2026-09-26:

| Check | Result |
| --- | --- |
| Application TypeScript; server and client test TypeScript | Passed |
| Strict standalone maintenance-script TypeScript | Passed |
| Full unit run (`vitest run unit --maxWorkers=4`) | 15,530 passed; 39 skipped; 0 failed (1,230 files passed, 1 skipped) |
| Offline proposal/execution contracts (`node --import tsx --test`) | 22 passed |
| Ten focused real-PostgreSQL integration suites | 212 passed; none skipped |
| Exact maintenance execution rehearsal from the PR branch | 21 scenarios passed; both disposable databases removed |
| Whitespace and scope review | Passed; no migrations or raw evidence included |

The first full Windows unit runs exposed local setup issues: a temporary evidence junction exceeded a Git file-list buffer, and unchanged checkout fixtures used CRLF where source-text tests expect LF. Removing the junction and temporarily normalizing those fixtures produced the passing run above. The original evidence was preserved; fixture line endings were restored afterward and none of those unrelated files is part of the PR. Local database checks used PostgreSQL 17; the registered CI suites must also pass in the repository's PostgreSQL CI environment. Local passing checks are not remote CI or deployment proof.

Before packaging, the local rehearsal passed 21 scenarios using captured definitions for 20 tables and all 10 actual triggers on the seven written/internally synchronized tables. Exact apply, rollback, stale rows/new siblings, competing writers, concurrent cleanup attempts, unchanged protected rows, retry conflicts, missing audits and lost commit acknowledgment were exercised. Two private disposable databases were removed afterward.

Rehearsal limits are explicit: private and cost fields were synthetic; 37 foreign keys into unrelated tables were omitted; included foreign keys were `NOT VALID` for historical fixture rows but enforce new/changed references; untouched-table triggers and external delivery workers were not run. This is not a full production clone or certification of whole-opening readiness. Nontransactional sequence gaps on rollback are expected.

After deployment, verify the actual deployed revision, refresh the exact provider/local evidence and trigger hashes, and use a reviewed live wrapper for the already-approved treatment. Do not reuse stale row fingerprints or treat a merge/deployment as cutover approval. The accepted bin-source baseline remains unchanged. Digital-notification retries, receipt/review dispositions, live-order identity/reservation repair and the full opening/activation assessment remain separately controlled work.

No production rows or provider business data are changed by publishing or testing this branch. No assumption of carrier possession or physical shipment contents is made from a commercial fulfilled status. Original investigation notes and raw captures remain in the investigation worktree, outside this PR.
