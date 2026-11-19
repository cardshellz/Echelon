# Purchase-order and initial RFQ recovery

## Scope

This batch follows receiving retry and reviewed-approval PR #1903. Work began on main commit 0dd1cf95929d2dd2337f6e1e79441ee46a16801b. It corrects manual PO entry and initial RFQ recovery. No historical records, supplier communications or live databases are changed. Local validation and hosted/deployed acceptance are separate evidence.

## Purchase-order command ownership

registerPurchaseOrderEntryRoutes delegates create, draft save, duplicate, solo preparation and document preparation to createPurchaseOrderEntryCommands. Existing URLs and compatibility response fields remain, but every manual entry needs an Idempotency-Key. The action, target, authenticated actor and original payload bind the durable command. All five routes share one command namespace, including PUT draft saves.

executePurchaseEntryInTransaction acquires the established graph lock and checks current Identity authority before work. Business writes, before/after PO events and the durable response commit together. The owner uses nested savepoints for existing draft-save/preparation semantics. A rejected preparation can leave an explicitly confirmed saved draft; an infrastructure failure rolls back the outer command. Preparation records no supplier dispatch and sends no email.

createPurchaseOrderEntryClient saves the exact intent in operator-scoped session storage before dispatch. The editor, legacy creation dialog, list and detail preparation actions expose the same recovery. Lost or malformed responses retain the request. A matching verified success or recorded terminal rejection releases it. Actor changes, route changes, permission changes and unavailable storage cannot silently replace the unresolved request. A confirmed write is followed by a fresh detail read: historical replay snapshots do not overwrite newer state, and a failed read blocks further edits until reloaded.

Legacy public.idempotency_keys rows lack sufficient scope and transaction evidence. They remain unresolved and block re-dispatch under that key. This batch does not delete old cache records, infer their outcome or automatically invent a replacement key. Session storage is same-browser-session recovery, not a cross-device recovery index. External callers must retain their own keys; old open clients without the required contract must reload.

## Initial RFQ creation

The Order Builder and legacy Purchasing View use the existing RFQ recovery store and command client. The saved initial batch includes exact supplier selections, quantities and override evidence. Recovering it does not recompute demand: a first attempt may already have reserved all remaining demand before its response was lost.

The versioned creation route uses createRfqCreateCommands and the existing financial command ledger. RFQs, supplier mapping changes, reservations, audit evidence and the creation receipt share one transaction. Current Identity permission is checked before work and after reservation/replay waits. Receipt validation binds the actor, key, original request, historical request hash and persisted creation identities. Later quote/status progression is not itself a reason to reject original creation evidence.

Legacy callers without the receipt-version header retain their existing response shape. Legacy keys may be adopted only when the original creator and request evidence are verified; missing or conflicting evidence remains unresolved. Existing RFQ quote/conversion/release recovery records remain readable.

## Failure modes and operator action

| Outcome | Recovery |
| --- | --- |
| Lost response, offline request or malformed success | Recover the saved original request; do not start a replacement intent. |
| Permission revoked or account changed | Restore the original operator's current authority before recovery. |
| Browser storage unavailable or corrupt | Restore storage; preserve the unresolved request. No new request is sent. |
| Draft saved but preparation rejected | Show the saved draft and rejection; review and correct it before another preparation. |
| Confirmed write followed by failed GET | Retry the detail load, without another mutation. |
| Audit/result persistence fails | Roll back business writes, then retry the same key under the ledger's retry policy. |
| Old unscoped PO cache or unverifiable legacy RFQ evidence | Preserve the key and review evidence; no automatic clearing or inferred success. |
| Concurrent identical retries | One durable result; changed actor/action/target/body conflicts cannot reuse it. |

Existing financial command tables provide durable results, and migration 227 protects all PO events against update, delete and truncate. Financial-command terminal updates are guarded, but expired command receipts can be deliberately purged; they are not the long-term audit authority. Review found that RFQ creation audit rows lacked an equivalent database guard.

The additive migration migrations/900000029000019070001_rfq_creation_audit_guard.sql protects the five RFQ creation, allocation-override and supplier-mapping audit actions from update, delete, rewriting unrelated rows into protected evidence and truncate. Existing rows are not rewritten. Creation now records the locked supplier mapping before/after values and the injected command timestamp. PR #1907 owns the generated filename and metadata. Allocation preserved the tested SQL bytes (SHA-256 746ecae58d1c8e11d1b6aa94c2397c50f767459475a2ca04b44b733e73263031). Only disposable tests apply this SQL during development. After allocation, all 73 RFQ PostgreSQL cases and 63 migration guards passed; migration policy validates the generated ownership and ordering.

## Regression coverage and limits

purchase-order-entry-recovery.integration.test.ts exercises actual HTTP routes, Identity, catalog/purchasing owners, PostgreSQL transactions and the default command repository. rfq-workflow.integration.test.ts imports initial creation recovery cases using the actual owners and real HTTP response loss. Both test only disposable loopback databases. Browser recovery specs cover desktop/mobile UI behavior with mocked HTTP; these are separate layers of evidence.

Seven PO exception lifecycle cases were moved from output-only closeout evidence into po-exception-lifecycle.integration.test.ts and registered in the PostgreSQL CI manifest. Obsolete skipped mocks were removed only after the actual-owner replacements passed. Existing active unit cases remain.

Final run reports and exact source fingerprints are recorded under outputs/procurement-po-rfq-recovery-2026-10-24 in the task's primary workspace. On the pinned starting baseline, final local validation passed 4,992 unit cases, 406 CI guards, 226 PostgreSQL cases, 188 distinct desktop/mobile browser cases, application/server-test/client-test/browser-spec typechecks and the build. An additional 80-case focused run includes the writer baseline and final RFQ contracts (overlapping cases are not added to the unit total). Main advanced during this run; its compatibility verification is recorded separately below. No hosted checks or production acceptance are implied by local results.

## Current-main compatibility

Reconciled main commit 9206840bca20537d6f61c7d4c83a4b449421ec1a before handoff. The two merge conflicts were import blocks in the PO list/detail pages; shared status displays and recovery controls are both retained. Post-merge verification passed 192 targeted unit/guard cases, all 78 PO browser cases, all four typechecks and the production build. The 110 RFQ browser cases retain identical product source. The server change extracted the existing physical-status resolver without changing its behavior; it introduced no PO/RFQ fixture dependency, so the 226 database cases were not repeated. Migration policy passes against this pinned main (550 existing migrations); the new audit SQL is allocated to PR #1907 without changing its bytes.

## Remaining procurement closeout

- C5 (numeric document allocation), E1 (AP cash-command clock propagation) and E2 (local HTTP fixture transport) are implemented and locally validated in the follow-up [numbering/clock closeout batch](procurement-numbering-clock-closeout.md). Publication, hosted CI and deployment remain separate release steps.
- Complete connected browser-to-real-HTTP acceptance against a disposable active quantity ledger, remaining non-admin authority/navigation cases and representative synthetic-volume health/cost query measurements.

PO 144, PO 149 and shipments 95/97 remain a separate historical evidence/repair queue. Their supplier evidence is not inferred and their records are untouched. Foreign-currency support and mixed/converted-source returns remain separately scoped capabilities with existing guards.
