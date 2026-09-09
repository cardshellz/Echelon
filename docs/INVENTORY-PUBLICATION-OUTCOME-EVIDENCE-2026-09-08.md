# eBay quantity publication: rejection, cooldown, and request evidence

## Status and scope

Implemented and locally verified on `codex/inventory-publication-outcome-evidence`, based on refreshed `origin/main` commit `5f45434312636313999c2dafb568e4da19f6f192`. No PR, deployment, live provider requests, production migrations, historical recovery attestations, or ATP/configuration changes were performed for this fix.

The clean-worktree procedure isolated this work from the original checkout's unrelated catalog changes. The implementation is in `C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence`.

## What the code definitely does

The approved change closes the future-publication failure path: a proven eBay rejection is no longer automatically indistinguishable from a lost response, and a provider cooldown is durable rather than an in-process short retry. It does not reconstruct missing historical evidence.

| Boundary | Function and exact evidence | Behavior |
| --- | --- | --- |
| Actual HTTP | [ebay-quantity-http.ts:34](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/channels/adapters/ebay/ebay-quantity-http.ts:34), `classifyEbayQuantityResponse`; line 56, `executeEbayQuantityHttpResponse` | Makes one HTTP mutation without automatic redirects or transport/5xx retries. Records status, optional provider request ID, response hash, error codes, and retry instruction. Only narrow recognized responses establish rejection. |
| Channel and maintenance callers | [ebay-api.client.ts:830](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/channels/adapters/ebay/ebay-api.client.ts:830), `EbayApiClient.requestUnadmitted`; [ebay-utils.ts:223](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/routes/ebay/ebay-utils.ts:223), `requestQuantity` | Quantity mutations use the shared HTTP helper. Non-quantity request behavior remains separate. |
| Listing protocol | [quantity-publication-request.ts:58](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/channels/quantity-publication-request.ts:58), `executeAdmittedEbayQuantityRequest` | Observes each actual mutation within the admitted SKU/group protocol, without double-journaling recursive bulk decomposition. An accepted-but-not-completed bulk response is not successful publication. |
| Dropship callers | [dropship-ebay-listing-push.provider.ts:514](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/dropship/infrastructure/dropship-ebay-listing-push.provider.ts:514), `requestEbayUnadmitted`; [dropship-ebay-inventory-publication.adapter.ts:249](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/dropship/infrastructure/dropship-ebay-inventory-publication.adapter.ts:249), `requestNoContent` | Both listing and canonical quantity publication use the same HTTP evidence/classification path. Existing credential-health updates and transport error contracts are preserved. |
| Owner-scoped evidence | [quantity-provider-request-evidence.ts:56](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/inventory-planning/application/quantity-provider-request-evidence.ts:56), `QuantityProviderEvidenceCollector` | Serializes requests/evidence writes on the owner's connection and drains queued work before releasing ownership. Missing evidence, swallowed uncertainty, or unfinished work prevents successful completion. `provesTerminalRejection` at line 75 requires a rejected request and complete, non-uncertain HTTP evidence for the entire observed operation. |
| Durable persistence | [quantity-provider-request-evidence.repository.ts:12](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/inventory-planning/infrastructure/quantity-provider-request-evidence.repository.ts:12), `PostgresQuantityProviderRequestEvidenceStore.start`; line 24, `finish` | Commits request-start evidence before HTTP. Commits result plus any cooldown atomically afterward. Uses short transactions; no database transaction stays open across HTTP. No tokens, raw request bodies, or raw response bodies are written to these evidence tables. |
| Admission and catchup | [quantity-publication-admission.repository.ts:238](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts:238), `PostgresQuantityPublicationAdmission.execute`; cooldown at line 337, terminal handling at line 369, `listDue` at line 449 | Existing unresolved outcomes remain blockers. Admission also checks durable cooldowns by real provider account and item, including connection aliases. Proven rejection becomes terminal `rejected`, never `succeeded`; catchup remains outstanding. Active cooldowns are excluded from due work. |
| Database invariants | [0663_quantity_provider_request_evidence.sql:2](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/migrations/0663_quantity_provider_request_evidence.sql:2), table definitions; line 55, `guard_quantity_publication_attempt_transition` | Adds request/result/cooldown tables. Request and result evidence is immutable. Only a running attempt with complete persisted evidence can become rejected. Existing uncertain attempts cannot be automatically relabeled rejected. No historical rows are updated by the migration. |
| Delivery proof | [inventory-cutover-drain-readback-proof.ts:52](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/inventory-planning/domain/inventory-cutover-drain-readback-proof.ts:52), `validateCutoverDrainReadbacks` | `provider_rejection` is not evidence that a conservative quantity was delivered. Rejection does not satisfy cutover publication proof. |

### Execution example

1. Admission locks the applicable scope and rejects overlap with any unresolved historical attempt. It checks the persisted provider cooldown before sending.
2. For an allowed operation, the owner and each request start are committed before HTTP. A rejected request then receives its own immutable result record.
3. If eBay returns the observed HTTP 400 / 25001 daily-limit response, result and cooldown are saved together. With complete evidence for all requests, the owner becomes `rejected` and retains catchup work.
4. A restart, another connection to the same account/SKU, or a new inventory event cannot shorten that cooldown. No additional HTTP mutation is sent through admission while it applies.
5. Once the deadline expires, normal catchup is eligible again. It does not replay a quantity from the request journal: [quantity-publication-admission.port.ts:42](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/inventory-planning/application/quantity-publication-admission.port.ts:42), `QuantityPublicationCatchupService.processDue`, invokes its existing replan dependency. For Dropship, [dropship-listing-push-worker-service.ts:238](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/dropship/application/dropship-listing-push-worker-service.ts:238), `processItem`, refreshes the intent; the production [factory at line 14](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/dropship/infrastructure/dropship-listing-push-worker.factory.ts:14) generates current preview data.

The new PostgreSQL [regression at line 42](C:/Users/owner/Echelon/worktrees/inventory-publication-outcome-evidence/server/modules/inventory-planning/__tests__/integration/quantity-provider-request-evidence.integration.test.ts:42) verifies rejection, restart, connection aliases, expiry, and successful publication of a newly supplied quantity of 17 instead of the rejected quantity of 4. This particular test proves new input is used; it does not independently prove the entire ATP calculation.

## Explicit policy choices and assumptions

- **Daily revision rejection:** HTTP 400, code 25001, and the specific observed daily-limit wording must match. Generic APPLICATION errors are not sufficient. The recorded provider message says to try after one day; the implementation chooses a conservative 24-hour wait rather than guessing a calendar reset timezone. A longer valid `Retry-After` wins. eBay documents the revision ceiling in its [Listing Management guide](https://developer.ebay.com/develop/guides/sell/listing-management).
- **Other recognized rejection:** structured HTTP 400 REQUEST errors use item cooldowns; HTTP 401/403/429 use account-wide cooldowns. The default minimum is 60 seconds, extended by a valid provider retry instruction. These fallback durations and conservative scopes are implementation policy, not claims about a guaranteed provider reset time. See `classifyEbayQuantityResponse` and `ebayRetryNotBefore` in the shared HTTP helper.
- **Group operations:** conservatively cool all locked group members after an item-level rejection, because this operation does not establish an independent revision budget for each member. The account-wide cooldown uses a reserved empty item key, while valid provider SKU identities are nonempty.
- **Unknown outcome:** timeouts, network failures, HTTP 408/5xx, malformed success bodies, unexpected partial/accepted statuses, or missing evidence remain uncertain. A local timeout is not proof of remote cancellation.
- **Provider request IDs:** stored only when an accepted response header supplies one; otherwise null. The code never manufactures a provider receipt.

## What is likely happening / what is not proven

The earlier read-only [six-attempt review](C:/Users/owner/Echelon/.codex-artifacts/inventory-publication-recovery-review-2026-09-08.md) records two correlated daily-limit responses and four attempts lacking terminal request evidence. It also traces the old generic error-to-uncertainty handler and in-process retry behavior. Those historical observations were not refreshed during this implementation turn.

- **Confirmed implementation boundary:** this migration and code do not clear or reclassify any of those six historical attempts.
- **HYPOTHESIS:** deployment interruption explains the two historical running attempts. The available record does not prove that cause.
- **INSUFFICIENT EVIDENCE:** the four requests without terminal evidence cannot honestly be attested as completed or not sent. This patch cannot recreate their missing history.
- Current provider quantities, current production deployment/state, historical in-flight processing, and exact eBay reset timezone remain unverified here. Local mocked provider tests are not a live marketplace acceptance test.

## Tests, risks, and failure modes

Final frozen-source validation:

| Check | Result |
| --- | --- |
| `npm run test:unit` | 11,426 passed, 37 skipped; 989 files passed, 1 skipped. Includes migration-prefix collision, writer-ratchet, adapter compatibility, and evidence unit tests. |
| Actual disposable PostgreSQL: inventory-planning integration directory plus channel quantity catchup integration | 298 passed across 16 files; no skips. Uses actual migration 0663. |
| `npm run check` | Passed. |
| `npm run build` | Passed; Vite reports the existing large-chunk warning. |
| `git diff --check` | Passed. |

Logs are retained locally under `C:/Users/owner/Echelon/.codex-artifacts/`: `publication-outcome-unit-tests-frozen-20260908.log`, `publication-outcome-postgres-tests-final-20260908.log`, `publication-outcome-typecheck-frozen-20260908.log`, and `publication-outcome-build-frozen-20260908.log`. The isolated loopback-only PostgreSQL instance was stopped after testing; unrelated database services were not stopped. No remote CI run exists yet because this branch has not been published.

An earlier full-suite run had two unrelated `shipment-cost-http` failures with `fetch failed` / `bad port`; that test passed on isolated rerun, and the final frozen full-suite run passed. No procurement code was changed. The precise cause of the earlier failure is not established.

Failure coverage includes rejection followed by swallowed exceptions, ambiguous responses, partial history, concurrent queued requests, request-start failure, result-recording failure, lost owner acknowledgement, immutable evidence, scope locking, account-wide throttling, and long/unrepresentable retry instructions. Lost terminal persistence deliberately leaves reconciliation required rather than risking a duplicate mutation.

Operational risks: evidence adds two short database transactions per observed mutation and additional retained rows. Conservative cooldowns can delay otherwise valid publication. Already-in-flight requests are not remotely cancelled by a newly recorded account cooldown. This change is not an account-global scheduling rewrite or a Shopify transport rewrite.

## Next checks and deployment handoff

1. Review/publish this scoped branch, then run remote CI. Recheck migration-prefix availability against freshly fetched main before opening the PR because other workstreams add migrations concurrently.
2. Apply migration 0663 before starting the new application code, following the normal deployment migration process. Do not drop the evidence tables as a rollback shortcut. The older binary does not enforce this new cooldown contract: stop/drain publishers before considering a rollback, or prefer a forward fix. No rollback or deployment was executed here.
3. After an approved deployment, verify request/result records and cooldown admission on actual runtime traffic without triggering extra quantity writes solely for testing.
4. Separately obtain terminal evidence for the four historical unknowns and review the two correlated rejection histories. Any recovery still uses the existing authorized, audited recovery contract; this fix does not grant permission to infer or force an outcome.
