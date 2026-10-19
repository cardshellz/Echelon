# Existing payment applications, payment dates and quarantine recovery

## Problem and behavior

Baseline: `8bd0a464101233ec664131dcbf6e13b18f524ee5` after PR1855. A recorded supplier payment could exceed its first invoice allocation without a command to apply the remainder later. Payment dates crossed a date-only form/timestamp/local-display boundary. Quarantine attempts could lose ownership or be cleared on an authorization error. The remaining-work ledger is `remaining-work-2026-10-19.md`.

The AP payment list and detail now expose one payment-balance projection: applied, unapplied, voided or review required. Operators can select current invoices for the same supplier across pages and apply already-recorded funds. This app records completed payments; these commands do not execute a bank transfer. The existing cash row remains unchanged. Each later application is a new immutable allocation, including another partial application to the same invoice.

## Financial authority

`projectPaymentBalance` derives balance and version from the header and all allocation/source evidence. Missing, incompatible, overallocated or inexact evidence produces review, not a spendable remainder. The application command locks the financial graph, current identity grants, payment and target invoices. It checks the reviewed version, available cash, invoice eligibility and invoice cached totals against effective completed-payment evidence. It also verifies the other source payments contributing to those invoices. Exact integer-cent applications, invoice/PO recomputation, immutable before/after audit and saved response commit together. A failure rolls the whole command back. PO financial evidence and financial alerts identify applications by allocation ID, not payment ID, so repeated applications remain consistent across PO list/detail, settlement milestones and past-due alerts, including after a whole-payment void.

Record, apply and void commands recheck current purchasing approval permission after the graph lock. They share one AP request-key namespace whose digest binds actual actor, operation, resource and original HTTP input. Reusing a key for a different operator or payment cannot create another cash record. A database guard serializes legacy/new namespace reservations. Exact old commands replay their original saved response; conflicting or multiple historical identities require review. No historical response is rewritten to invent new proof.

New date-only requests validate real calendar dates and save an explicit nullable `payment_calendar_date` alongside the compatibility timestamp. Database constraints require the verified date and timestamp to agree. Legacy ISO timestamp and internal Date callers remain supported with a null verified date. Existing dates are not backfilled; screens say "Date not verified" for that evidence. Payment dates on Payments, invoice detail, AP dashboard and PO history use the same shared formatter. Audit timestamps retain their existing meaning.

## Client recovery and receiving

Record/apply/void share one actor-bound browser session intent across AP Payments and invoice detail. The exact request is saved before dispatch. Reload, navigation, authentication failure, another operator, unknown success, ambiguous errors and storage failures cannot silently create a replacement request. Only a matching validated success or a matching terminal rejection clears it. Payment history has a reachable URL-backed detail view from invoice links.

Quarantine uses the existing persistent-intent infrastructure with the original receipt storage key, so older unowned attempts are retained as review evidence. Its server namespace binds operator, action, target and request. Saved legacy custody evidence prevents a second write. Success verification checks identity, requested quantities, source and custody/disposition reconciliation. Recovery remains visible when receipt detail is unavailable. A confirmed mutation closes stale input; failed receipt readback blocks another mutation until refreshed.

## Migration and release

Reviewed SQL is staged in `docs/procurement/payment-balance-completion.pending.sql` until a draft PR exists. Allocate it unchanged with the repository migration generator, update fixture/runbook references, then rerun the actual-SQL acceptance and migration guards. Do not choose another free sequential number.

The migration adds the nullable date without backfill, replaces the payment/invoice unique-pair index with a lookup index, protects immutable application/payment history, enforces application bounds and adds AP-family-only request-key protection. Existing source amounts, allocations, balances, dates and saved responses are not rewritten. Deploy the migration before or with the application. Old instances may fail closed on a conflicting key during a rolling release. Reverting to an old binary is not a complete rollback plan after new repeated applications exist; preserve evidence and use a forward correction.

## Acceptance evidence

Local validation passed **5,334 unit cases** (7 pre-existing skips), **207 CI guards**, **221 PostgreSQL cases across 13 disposable databases**, **238 distinct desktop/mobile browser cases**, all three application/test typechecks, an additional changed-browser-source typecheck and the build. Eight final browser reruns are included in those distinct cases.

Final commands and counts are recorded in the local validation manifest at `outputs/procurement-payment-completion-2026-10-19/validation.json`. Tests include actual PostgreSQL repeat applications, competing advances, stale versions, duplicate keys, cross-operator keys, legacy/new reservation races, permission revocation while waiting for a lock, audit failure/rollback, void races, malformed legacy allocation review on both the source payment and another payment on the target invoice (rejecting both cash recording and later application without changing balances), immutable history, calendar boundaries and migration reapplication. Browser cases exercise desktop/mobile recovery, eligible-invoice pagination, failed reads, actor changes and the affected payment-date screens; they mock HTTP and are not proof of production behavior.

## Limits and unknowns

- No supplier credit/refund document or signed inventory-credit posting is introduced; AP-A6 remains open.
- Existing whole-payment void retains every application and restores invoice/PO balances. A per-application undo/reallocation command is not included; individual applications cannot be edited or deleted.
- Legacy dates and response/actor evidence remain unverified where the original record cannot prove them. This batch performs no historical repair.
- Browser recovery is session-local. Closing/clearing browser storage is not a durable server-side task inbox; saved server commands and history remain available for investigation.
- Local validation does not establish hosted CI, migration deployment or production acceptance. Production data volume and incidence of historical defects remain unmeasured.
