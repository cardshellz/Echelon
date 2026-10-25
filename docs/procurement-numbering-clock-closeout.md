# Procurement numbering, payment clocks and HTTP test reliability

## Scope and source baseline

This batch starts at main `6a0b2b5a7ca98a0839e382ccc758cf421e6c6ec7`, after PR #1907. It addresses closeout findings C5 (daily numbering), E1 (AP cash-command clock propagation) and E2 (Fetch-blocked ephemeral test ports reproduced during validation). It does not repair historical data or establish production acceptance.

## Number allocation

`server/platform/document-numbering/document-number.repository.ts:allocateDocumentNumber` is the common owner for daily PO, receipt, payment and inventory-lot suffix allocation. Static table and column mappings prevent request-supplied SQL identifiers. The allocator takes a transaction advisory lock, reads the numeric maximum of complete digits-only suffixes, and increments with BigInt. Cancelled/voided rows remain sequence evidence. Custom reference labels are preserved and ignored by numeric allocation. The existing minimum width is three; 999 progresses to 1000 and 1001. Values are bounded by the actual column length, not JavaScript's safe integer limit. Capacity exhaustion returns `409 DOCUMENT_NUMBER_EXHAUSTED`; invalid database evidence fails closed.

Callers retain the lock through insertion. PO legacy creation, inline creation, duplication, RFQ conversion and recommendation handoff converge on this rule. Graph-owning paths acquire the existing cost-graph lock before the number lock. Header, lines, catalog changes, history and command results remain in their existing rollback boundary. Legacy PO creation now persists its supplied creation-history row in that same transaction. Receipt owners pass the creation timestamp through their storage port. Both inventory lot owners preserve externally supplied transactions; standalone creation opens a transaction covering allocation, insertion and cost updates. `withTx` retains the injected clock. Rollback leaves no reserved number or partial document.

`readSuggestedInvoiceNumber` only suggests an editable supplier invoice reference. It does not reserve a number or change supplier-entered identifiers; invoice creation retains vendor-specific duplicate checks. Existing shipment numbering was already numeric and remains unchanged. Command-derived return, observation, conversion and build lot identifiers are also unchanged.

The explicit calendar policy preserves existing behavior: PO, receipt, lot and invoice suggestions use UTC; payment identifiers use the process-local calendar. Clock snapshots are copied before waits so caller mutation cannot change an in-flight identifier. Existing identifiers are never renumbered.

### Deployment compatibility

The shared allocator retains the exact prior receipt and payment advisory-lock identities. Two PostgreSQL compatibility tests hold each old lock with an uncommitted number, prove the new allocator cannot read past it, then commit and verify that the new writer allocates the next number. PO and lot writers acquire their new namespace locks. The previous lot generators had no common lock, and the lot table has no global lot-number uniqueness constraint. New-version concurrency is tested; overlapping an old lot writer with a new one is not established as safe. Deployment must finish/drain old lot-creation requests before new lot writes begin. This batch does not add a uniqueness constraint over unreviewed historical lot data.

## AP cash-command timestamps

`ap-ledger.service.ts:executeApPaymentCommandInTransaction` validates and copies the supplied command timestamp before awaiting the graph lock. Record, apply and void carry that same time through payment/allocation creation, invoice recalculation, PO balance/milestone/history projections and command audit. Replayed command receipts do not run the clock or mutation again. Recorded payment calendar dates and original cash dates remain separate evidence; applying or voiding a payment does not rewrite them.

This does not unify unrelated invoice lifecycle clocks, PO/shipment receipt database-default timestamps, or post-commit exception-observation times. Those paths must not be described as having been changed by this batch.

## Prefix query indexes

`docs/sql/procurement-document-number-prefix-indexes.sql` adds five full, nonunique `varchar_pattern_ops` indexes. The numeric query includes historical cancelled/voided rows, so active-only number indexes cannot supply all its evidence. A disposable local benchmark seeded 100,000 historical and 1,000 same-day rows for each of the five sources. The actual SQL artifact changed all five plans from full table scans to the intended index-only scans of 1,000 same-day rows.

| Source | Read p95 before | Read p95 after |
| --- | ---: | ---: |
| PO | 17.04 ms | 2.17 ms |
| Receipt | 10.74 ms | 2.93 ms |
| Payment | 17.69 ms | 2.04 ms |
| Lot | 19.82 ms | 2.19 ms |
| Invoice suggestion | 17.14 ms | 2.74 ms |

These are synthetic local measurements, not production latency or deployment-duration guarantees. The benchmark's recorded helper hash predates restoration of the legacy receipt/payment lock identities; its read query and index SQL are unchanged. End-to-end helper timings from that run must not be attributed to the final lock implementation. Allocation still evaluates the selected day's suffix evidence; this is not constant-time allocation for unlimited daily volume. The benchmark does not measure purchasing health or cost-summary queries.

The pending SQL SHA256 is `79a986cc8ddc633ab4312d30da78ac78e90a34540945d3946cf8051357dbc3c8`. Applying it twice preserves all seeded row counts and ordered-row digests. Its catalog guard rejects incompatible same-name indexes, and the real migration-executor test proves transaction rollback leaves no partial indexes or migration receipt. Matching index definitions are declared in the shared Drizzle schemas.

Release migrations run inside a transaction, so concurrent index creation cannot be used. Ordinary index creation may wait for writers and then blocks writes to the affected tables until the migration commits; reads remain available. The runner's lock timeout and transaction rollback remain applicable. Live table sizes and deployment duration are unknown because no live data was accessed. Only disposable databases execute the SQL during development. PR-generated migration allocation is a separate publication step and must preserve the tested SQL bytes.

## Test transport

The broad unit run reproduced `TypeError: fetch failed`, caused by `Error: bad port`, in recommendation and receipt/shipment route fixtures. A local HTTP test server may bind a port that browser-compatible Fetch rejects before sending a request. The shared `server/__tests__/helpers/local-http.ts:requestLocalHttp` uses Node HTTP for explicit loopback test servers, with bounded timeouts, abort/error handling and native Response decoding. It rejects unsupported transport options and compressed responses. Provider HTTP clients and production Fetch behavior remain unchanged.

The mechanical migration changes 91 local request calls across 34 procurement/inventory fixture files; request arguments and existing assertions are preserved. The helper's 23 cases cover blocked logical ports, cookies, binary/text/JSON responses, timeout, cancellation and broken connections. Four affected PostgreSQL route suites were rerun after migration.

## Local validation

All completed checks below passed. Counts are per run; overlapping focused/guard cases are not additional unique coverage.

- 5,974 unit/contract cases across procurement, inventory, shared procurement, numbering and test transport.
- 406 CI guard cases; the final 96-case focused run rechecks the changed allocator, lifecycle error contract and 54 PostgreSQL registration guards.
- 642 PostgreSQL cases across 11 distinct suites: PO entry (21), RFQ (81), AP payment (46), AP safeguards (14), receiving close/entry (42), receiving cost application (209), source-to-cost flow (4), lot allocation (8), PO quantity amendment (94), purchase approval authority (113), and prefix indexes/legacy locks (10).
- 156 desktop/mobile browser cases across PO entry, receiving entry, payment completion and RFQ workflow. Their HTTP responses are mocked; these are not connected-browser or production-acceptance results.
- Application, server-test, client-test and selected browser-spec typechecks, plus the production build. The final server-test typecheck includes the added compatibility cases.

Coverage includes rollover beyond 999, cancelled/voided and custom references, concurrent writers, column-capacity rejection, invalid/mutated clocks, caller-owned transactions, one-connection pools, rollback after later cost-write failure, command replay and active-ledger receive rollback. The last code change restored existing receipt/payment lock identities; the focused tests, compatibility database cases and build were rerun afterward. Earlier broad results retain their recorded source fingerprints.

Exact commands, run reports, source fingerprints, the repeatable synthetic benchmark and the initial failures/corrections are retained in the primary workspace under `outputs/procurement-numbering-clock-2026-10-25`. These are local checks, not hosted CI or deployed behavior. No live records were read or changed.

## Remaining procurement closeout

After this batch is merged and deployed, remaining acceptance work is connected browser-to-real-HTTP recovery against a disposable active quantity ledger, outstanding non-admin authority/navigation cases and representative synthetic-volume health/cost query measurements. Any additional system correction depends on those checks identifying a concrete failure; no additional defect is claimed from the outstanding acceptance work alone.

PO 144, PO 149 and shipments 95/97 remain a separate historical evidence and repair queue. Foreign-currency support and mixed/converted-source returns remain separately scoped capabilities with existing guards.
