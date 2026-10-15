# PO financial evidence validation

## Reviewed source

Implemented in `codex/procurement-po-financial-attribution`, starting from main `ef9ce79e453190c7fb03bd37cb0241d9fb158713`. Before publication, the branch incorporated main `494b4a99d4a2d507013045b783bd0ebc1cd34092`; that update changes CI browser selection only and does not alter procurement runtime code. No SQL migration is added.

## Reproduced failures

The initial PostgreSQL run demonstrated stale sibling PO totals after invoice link, unlink and line import. A separate reproduction established Drizzle's empty-update failure when a link was created without either optional metadata field. Those failing cases pass with the correction, with existing financial assertions preserved.

Review also reproduced malformed invoice input throwing before domain validation and fractional DTO amounts throwing during BigInt refinement. Both now return explicit invalid/review outcomes with regression coverage. Client review found legacy completion guidance visible during failed evidence reads; the final browser cases cover the corrected pending/error/refetch behavior.

## Passed local validation

| Check | Result | What it establishes |
| --- | --- | --- |
| Procurement unit regression | 2,954 passed; 14 existing skips | Existing procurement domain, service and route behavior |
| Final financial evidence domain/API checks | 110 passed | Final 96 domain and 14 HTTP cases, including 15 added malformed-input regressions after the broad unit run |
| Workspace unit checks | 28 passed | Existing workspace rendering/contract behavior and truthful metadata labels |
| PostgreSQL integration | 166 passed across 10 suites; no skips | Real transactions, mapping and payment reads, overlapping writes, rollback, invoice replacement, cost review and controlled receipt/payment flows |
| New browser acceptance | 24 passed | Desktop/mobile known, unknown, invalid, failed and refreshing states; invoice navigation, payment refresh and lost-response recovery |
| Affected browser regression | 102 passed | Existing purchasing, invoice and shipment workflows |
| Final CI guards | 202 passed across 6 suites | PostgreSQL inventory, test exclusion baseline, migration identities and current-main browser selection |
| Production build | Passed | Client and server bundles; existing large-chunk warning remains |
| Application / server-test / client-test types | All passed | Final combined branch; 110.1s / 71.3s / 47.7s respectively |

Counts above overlap where the focused checks repeat cases from the broad run; they are not an additive unique-test total. Browser calls use controlled HTTP fixtures, not a live production API. Local PostgreSQL is version 17; hosted CI uses PostgreSQL 16, so hosted results remain separate evidence.

PostgreSQL suites: `po-financial-evidence` (13), `po-financial-refresh` (14), `ap-financial-safeguards` (13), `procurement-payment-controlled-acceptance` (13), `receiving-cost-application` (60), `invoice-replacement` (19), `procurement-flow-cost-controlled-acceptance` (3), `invoice-cost-review` (10), `ap-invoice-line-metadata` (13), and `invoice-po-quantities` (8). Each runs in its own disposable database.

The two new PostgreSQL suites are registered in both the canonical CI manifest and its independent coverage guard. The new browser spec matches the existing procurement test inventory; selection was explicitly verified to run. No exclusions, assertions or required CI checks were relaxed.

## Specific integrity evidence

- Source rows are unchanged by financial evidence reads.
- Repeatable-read isolation preserves one coherent result when another connection mutates ownership between SELECTs; a later read observes the mutation and requires review.
- Real completed and voided payment history is retained. Shared partial payment stays unknown; no proportional split or link-metadata allocation is inferred.
- Two simultaneous relationship writers overlap at database lock waits and converge on correct invoice and sibling-PO cache state.
- Final-audit failure rolls back every affected invoice, relationship, line, status and PO aggregate change.
- A lost browser payment response triggers bounded retries with the same idempotency key, then reloads recorded evidence and invoice balances.

## Limits and retained work

No production database, payment provider, email transport or queue was operated. Hosted CI, merge, deployment and live acceptance are separate states. All task-created databases were dropped, the owned PostgreSQL cluster was stopped, and the browser server was stopped.

This projection validates recorded invoice/payment applications, not bank settlement or payment-header conservation across unrelated invoices. The direct product-invoice void/cost reconciliation path is unchanged and not newly tested here. Legacy persisted financial totals/status, exception consumers, aging policy and historical repair remain separate work. The full F19 finding is not marked closed.
