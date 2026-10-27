# AP summary snapshot and current-main procurement verification

## Scope and result

This continues the unpublished `891a397e2` package. Current main `bdf711be2c23ad6e992df947b08202e495779db1` is included through merge `880758b69`; the AP correction is code commit `b340d5b45037c0362ab41b5d0065f872f04af38f`. Documentation/evidence updates on top of that code commit do not change runtime inputs. No SQL migration, production role assignment or live/historical business-record repair is included.

The previously open AP common-snapshot gap is fixed and locally verified. Remaining engineering boundaries are posted-PO freshness fanout and extreme health child-row volume. Hosted CI, deployment and production acceptance remain separate.

## What the code definitely does

[`getApSummary`](../server/modules/procurement/ap-ledger.service.ts#L2407) captures the supplied/default clock epoch once, validates it before acquiring a connection, clones a private Date and opens one read-only repeatable-read transaction. [`readApSummaryInSnapshot`](../server/modules/procurement/ap-ledger.service.ts#L2424) runs all six existing reads through that transaction: open invoices, monthly payments, all payments, applied credits, recent payments and recently paid invoices.

The private executor exposes only `select` and `execute`. Parsed-source comparison verifies that the original query/calculation/response body is preserved apart from the database executor identifier. Status filters, integer-money conversion, aging buckets, monthly date policy, nullable fields and response keys are unchanged. The [existing read route](../server/modules/procurement/ap-ledger.routes.ts#L548) still calls the same public owner.

Snapshot consistency applies to one request. The existing now parameter controls aging/month calculations; settlement totals describe rows visible in that database snapshot. Settlement authority remains with the existing financial command owners.

## Reproduction and recovery proof

The six original targeted tests failed against the unfixed owner for the intended reasons: payment record/void and supplier-credit apply/reverse mixed old invoice state with new settlement aggregates; caller Date mutation changed aging/month calculations; the injected PostgreSQL read error had no transaction snapshot/rollback evidence. No fixture, schema or query-transport failure was counted as a reproduction.

The [test barrier](../server/modules/procurement/__tests__/integration/ap-summary-read-barrier.ts) pauses delivery only after the real first SELECT completes. It observes both the original pool path and the transaction-client path. A real financial command commits on another connection while the summary reader remains paused. A fresh read proves the new state committed; the paused reader must still equal the entire pre-commit response. The next request must equal the entire post-commit response. No result fields are ignored or substituted.

The final nine added cases cover payment record/void, credit application/reversal, caller Date mutation with one epoch capture, invalid Date/non-Date rejection before any transport attempt, valid epoch-zero input, and actual PostgreSQL `22012` failure followed by rollback, exactly one reader release and a successful fresh read. They also compare persisted financial/audit state before and after summary reads. The helper forwards callback-based connections without changing their return protocol and restores transport only after the reader settles; no sleeps or production-only test hooks were added.

Both existing integration suites remain registered in `scripts/ci/postgres-test-manifest.ts`. The full final suites passed 21 AP and 34 credit cases. Their frozen pending-patch inputs are proven byte-equivalent to the four committed code/test files; the report does not pretend those earlier wrappers ran at a different HEAD.

## Current-main integration

Nine files overlapped the prepared package and main. The sole textual conflict was [`allocatedCentsPerUnitMills`](../server/modules/procurement/shipment-tracking.service.ts#L204): main converted missing amounts into numeric zero. The integrated code preserves missing amounts as unknown and explicit zero as zero.

That choice follows the actual read model: [`getAllocationBreakdownsByLine`](../server/modules/procurement/shipment-tracking.service.ts#L428) creates category totals only for recorded allocation rows; [`getEnrichedLines`](../server/modules/procurement/shipment-tracking.service.ts#L466) projects absent amounts as null and explicitly requires a known allocation before exposing landed unit cost. The [existing display](../client/src/pages/InboundShipmentDetail.tsx#L299) renders null as a dash. Main's no-500 and malformed-present-money regression cases are retained, with unknown/zero expectations made consistent. Posting completion still belongs to the separate source/application/reconciliation owner.

The merged shipment-service diagnostic passed 76 cases. Those cases are also included in the broader unit run below; they are not added again to its count. Current main's receiving configuration/readiness behavior, existing procurement grants and the dependency-edge cache are preserved.

## Local verification

The [final validation manifest](evidence/procurement-ap-summary-verification-20261027.json) records commands, report hashes, exact case/project coverage, source identities and cleanup evidence.

| Verification | Passed | Evidence boundary |
| --- | ---: | --- |
| PostgreSQL cases | 399 | Receiving 214; shipment lines 87; controlled cost flow 4; reporting 25; work lists 7; supplier documents 7; AP safeguards 21; supplier credits 34 |
| Unit cases | 5,157 | Recorded procurement/shared and additional money/catalog/navigation files; 298 files |
| Official guards | 421 | Eleven guard files; assertions and timeouts retained |
| Mocked desktop/mobile cases | 424 | Fourteen explicit procurement specs, 212 cases per viewport; complete discovered identity set |
| Connected desktop/mobile cases | 46 | Real login/session/HTTP/PostgreSQL/active-ledger paths; four balanced shards; complete discovered identity set |
| Typechecks | 5 | Application, server tests, client tests, connected tests and procurement browser specs |
| Production build | 1 | Built from the frozen committed source before browser execution |
| Migration policy | 558 identities | Validated against current main; zero branch migration changes |

All final passing coverage has zero failed/skipped/flaky cases or reporter errors. The 344 current-main database regression cases and all ordinary formal checks ran at clean `b340d5b45`; the 55 AP/credit cases are separately bound to that commit by the exact tested-input proof. Source and frontend hashes stayed stable throughout the browser runs. Documentation/evidence updates after this code commit do not alter tested runtime inputs.

All databases created for these runs were removed after confirmed process closure. The final audit found zero remaining databases, client connections, scoped test processes or listener on the mocked-browser port. The new local cluster was created specifically for this run; the older local database/cluster was not reused or modified.

## Performance evidence and limits

The [October 25 measurements](evidence/procurement-connected-performance-final-20261025.json) remain attributed to their measured code `5dc5f1b4`. No new timing experiment or production latency result is claimed here. Replayable source comparison proves that seven measured health/list/allocation functions remain unchanged through the main integration and AP correction. The other recorded performance owners/helpers and participating schemas are unchanged; the new import chain performs no top-level SQL/dispatch. The AP summary change is outside those measured owners.

The earlier experiment's complete-output comparisons and fewer health queries remain recorded evidence for that code. They are not relabeled as measurements of this commit. Posted PO summary still prepares freshness per linked shipment (the prior 100-shipment scenario retained 620 calls), and health pagination bounds headers rather than every child collection. Neither a production latency target nor a production capacity failure has been established for those remaining paths. Safe follow-up must retain full evidence and canonical freshness validation rather than truncate rows or bypass checks.

## What is not proven and next checks

Local Windows/Node-24/PostgreSQL-17 checks do not establish hosted Linux/Node-20/PostgreSQL-16 execution, deployment, actual production permission assignments, provider delivery or production latency. A read holds one connection until all six existing queries finish; no new row/advisory locks or writes were added. The tests prove that the settlement writer can commit while the reader is paused, not a production throughput guarantee.

The connected fixture uses selected actual schema/migrations and inert external dispatch; it is not a complete release/bootstrap replay. Its shipment starts `in_transit`, so the 46 connected cases do not prove a real draft-to-booked receiving-configuration journey. The new configuration/readiness screen cases and real command database suites are separate layers of proof. Its payment/credit/return work lists are empty; real two-connection financial command tests and mocked posted-detail screens do not replace a connected operator payment/credit/return detail journey.

The combined package retains the earlier manual auto-draft alias restriction: non-admin callers receive HTTP 403. Both known repository UI callers already use the administrator-gated endpoint; external legacy callers were not inspected.

No new accounting rule, timezone policy, currency behavior, supplier evidence or production role assignment was inferred. The next steps are publishing the reviewed draft PR when authorized, verifying hosted CI and then continuing the two scale investigations. Historical PO 144/149 and shipments 95/97 remain a separate supplier-evidence/repair queue. No live records were read or changed.
