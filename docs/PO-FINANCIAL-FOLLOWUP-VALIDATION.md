# Financial follow-up validation

## Source and scope

Branch `codex/procurement-financial-consumer-integrity` starts from freshly fetched main `c68a6a9a32547029fa8a39308a9b66d5ca6304cf`, which contains merged PR #1806 and the subsequent shipment-cost follow-up. PR #1806's hosted checks passed and the user confirmed deployment. This batch is a separate change; no independent production readback was performed.

Three parallel workstreams implemented source/workflow projection, financial alert synchronization, and UI/lifecycle handoff. Independent source reviews traced repository decoding, cancellation, alert locking/audit history, invoice permissions and conflicting read states. Root integrated queue/route/health/CI wiring and validation.

## Local evidence

| Check | Result | Evidence scope |
| --- | --- | --- |
| Procurement unit regression | 3,128 passed; 14 pre-existing skips at broad run | 215 procurement unit suites |
| CI guards | 202 passed | Migration identity, PostgreSQL inventory, browser selection and test/type coverage guards |
| Health escalation job | 2 passed | Existing summary/escalation orchestration contract |
| Final route/legacy boundary rerun | 38 passed; 7 unrelated skips | Both evidence/detail routes and remaining legacy exception suite |
| Final financial alert domain | 41 passed | Exact settlement, dates, unknown sources and malformed schedule boundaries |
| PostgreSQL integration | 222 passed across 12 suites; no skips | Real source reads, locks, history, payment/alert races and audit rollback |
| Desktop/mobile browser acceptance | 98 passed in full run; 4 corrected fixture cases passed on focused rerun | 102 distinct cases across evidence, pipeline and AP safeguards |
| Typechecks | Application, server tests and client tests passed | Combined code; final schedule domain and changed browser specs additionally passed a focused typecheck |
| Production build | Passed | Client/server bundles; existing large-chunk warning remains |

Counts overlap between broad and focused runs and are not an additive unique-test total. The broad browser run was **not** clean: four failures came from two newly authored tests, each run on desktop and mobile. One expected a bare invoice number instead of the actual `Invoice #...` heading; the other used a viewer role that the existing application routes redirect away from PO/AP detail. The latter now uses the existing lead role with only `purchasing:view`, proving the permission restriction on creation/payment without violating the route's role requirement. Both corrections were test-only; all four focused reruns passed. No assertion was weakened to bypass a product failure.

Seven permanently skipped financial-detector tests asserted the removed cache/vendor-terms implementation. They were removed and replaced by active domain and database cases. Seven unrelated legacy skips remain. No new skips, exclusions or relaxed CI requirements were added.

The final schedule shape guard was added after the broad regression: 16 new malformed-input cases were added; 15 failed before correction. The final 41-case domain run, 21-case alert database rerun, focused typecheck and production build cover that final change. The other database suites retain their successful broader evidence.

## Database coverage

Each suite used its own disposable local PostgreSQL database. Local PostgreSQL is version 17; hosted CI uses version 16, so hosted results remain separate evidence.

| Suite | Passed |
| --- | ---: |
| po-financial-exceptions | 21 |
| po-financial-followup | 14 |
| po-financial-evidence | 20 |
| po-financial-refresh | 14 |
| ap-financial-safeguards | 13 |
| procurement-payment-controlled-acceptance | 13 |
| receiving-cost-application | 74 |
| invoice-replacement | 19 |
| procurement-flow-cost-controlled-acceptance | 3 |
| invoice-cost-review | 10 |
| ap-invoice-line-metadata | 13 |
| invoice-po-quantities | 8 |

The new follow-up and financial-exception suites are registered in `scripts/ci/postgres-test-manifest.ts` and its independent coverage guard. The protected older-suite baseline remains intact. Unit tests retain automatic discovery; changed browser specs stay in the existing procurement suite.

Specific checks prove: coherent source snapshots during concurrent ownership changes; discovery of line-owned invoices with missing header links; traversal past 501 settled rows; exact PostgreSQL bigint conversion and unsafe rejection; cancelled debt visibility; no repeated alert/audit on later-day retries; manual disposition preservation; audited payment/void/unlink recovery; overlapping payment/synchronization lock waits; and rollback when the final audit write fails.

## Corrections found during validation

The first database run rejected raw bigint strings in the new queue reader. The repository now validates exact decimal strings and their safe integer range before conversion; normal and boundary cases pass. Review identified cancelled invoices being filtered before financial evaluation, null invoice/payment/schedule inputs throwing instead of producing unknown outcomes, and successful but conflicting browser reads inheriting old completion guidance. Each has a regression case.

The original route unit harness lacked a transaction and source rows for the new snapshot reader. It now exercises that boundary and a failed-read response. Typechecks caught two dependency interfaces that needed to expose the methods actually consumed: transactional health reads and the evidence route's single `read` method. Fixture bigint assertion types, one required payment number and an initially misplaced test were corrected before the final database runs.

## Evidence files and limits

Local evidence is retained under `outputs/procurement-financial-consumers-2026-10-15` (combined regression, typechecks and build) and `outputs/procurement-financial-consumer-integrity-2026-10-15` (database manifest, browser logs and independent alert review). These logs are local evidence, not deployment proof.

The owned PostgreSQL cluster and browser listener are stopped, with task databases removed. No production records, external payments, email transport or notification jobs were operated. There is no migration or historical backfill. Existing event-driven postcommit alert hooks remain best effort, and no daily scanner is added. Production scale/lock contention and live workflow acceptance remain unverified. See `PO-FINANCIAL-FOLLOWUP.md` for source trace, failure behavior and retained work.
