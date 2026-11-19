# Durable customer return label workflow

## Customer contract

One explicit Get return labels action saves the immutable selections and boxes. The backend worker owns continuation after the HTTP response, modal close or browser close. The customer sees Getting your return label(s), then the original label downloads. Observation uses GET only. Requests and PDF body reads have a 25-second deadline; failed observation stops after three failures and retains the same saved request. A failed observation or a stopped workflow offers one Try again action; internal command/carrier states are not customer actions.

An unfinished request is discoverable by its owned order even if browser storage was cleared. The server returns only that customer's saved public selections, allowing the browser to restore the original key. Completed requests remain in the existing authorization history, and closing order tools refreshes that history. Ready/pre-authorization-rejected requests do not prevent starting a later return for remaining eligible units.

## Owners and state transitions

- Shopify purchase and existing return claims remain the quantity authority through the unchanged live inspection and authorization owners.
- CustomerReturnWorkflowStore owns durable workflow intent, scheduling, leases, state and append-only events. Its two new tables have only the returns module as writer.
- CustomerReturnSubmissionService owns the existing same-key preparation and atomic intake. The new worker calls that owner rather than creating another authorization path.
- CustomerReturnLabelsService and PostgresCustomerReturnLabelStore remain the exclusive owners of quote checks, purchase intent, carrier purchase and reconciliation. Browser code never decides the next parcel or calls progress in the new flow.
- The existing parcel receiving service routes each return label's exact mixed-box contents into receiving once. Inventory treatment and refunds remain separate commands.

| Phase | Owner and exit |
| --- | --- |
| queued | The one-second normal worker sweep leases the saved request. |
| preparing | Same-key submission validates the current purchase, policy, addresses and box plan, then commits intake atomically. |
| labels | Each worker step invokes the existing label owner for one purchase or reconciliation. Completed boxes remain downloadable. |
| ready | Every box has its verified saved label and download link. No further worker purchase is allowed. |
| retryable_failure | Automatic transient retries are exhausted or the carrier definitively rejected a purchase. One explicit retry requeues the same workflow. |
| needs_input | The existing submission owner conclusively rejected the request before authorization. One customer retry opens fresh item review; the original server receipt remains. |
| needs_help | Identity/configuration faults or unresolved carrier reconciliation need attention. The visible request reference identifies the precise job and existing attempts; retry keeps the original authorization and manifest. |

Workflows have five-minute fenced leases and two-way customer/channel/order binding. Claim uses SKIP LOCKED. A stale worker cannot overwrite a newer lease. Source ownership changes stop a job before the next claimed step. Automatic transient/reconciliation failures use five-second exponential backoff capped at one minute, and stop after six failed observations. A schema/integrity SQLSTATE is escalated immediately. The existing submission/purchase leases continue to protect their own boundaries independently.

A carrier attempt is failed only after the existing adapter reports a definitive rejection. A new explicit retry can create a subsequent attempt under the same parcel lock, with the old failed evidence retained. Each explicit retry permits one subsequent attempt; there is no arbitrary customer retry quota. Executing, successful or uncertain attempts forbid another purchase; uncertain outcomes always use provider lookup. The existing unique unresolved-attempt index remains enabled.

Before the first postage purchase the entire immutable box plan is quoted. Once a label was successfully purchased, subsequent steps refresh the target box's quote rather than re-quoting every remaining box on every step. Policy pause, immutable destination, service restrictions, measured weights and quote expiry are still checked by their existing owners.

## Compatibility and release

The forward migrations update the ambiguous source-trigger function and add workflow/event tables. They do not enroll, retry, cancel or rewrite historical customer requests. New explicit requests use the worker as the normal path, without a new rollout flag. Older receipts and accepted returns can join it only after an explicit customer retry. Existing staff/older-theme endpoints remain available during the paired release.

The normal shared scheduler starts the worker and reports startup/sweep failure. The existing global scheduler maintenance control still applies. A controlled release must deploy the backend migrations and worker before the pinned account bundle. Do not activate a real historical retry as a deployment test.

## Single acceptance command

Run `node --import tsx scripts/ci/returns-workflow-acceptance.ts` with the existing disposable PostgreSQL CI runner environment. The runner creates a fresh owned database for each suite, validates loopback isolation, strips application database credentials, and cleans up only its own generated databases. The Returns required check now depends on both its normal browser matrix and connected workflow acceptance.

Acceptance includes actual migration-defined receiving/authorization/purchase owners and cache triggers, the actual ShipStation adapter against a strict HTTP fixture, required contact fields, purchase response loss, shipment/label readback and PDF downloads. It covers worker crashes after commit, competing workers, stale completion, ownership changes, explicit rejected-label retries, bounded unknown outcomes, historical source gaps, two mixed return boxes from a three-shipment purchase, out-of-order receiving and receipt retries. Browser tests cover automatic observation, modal close, storage loss, account/standalone surfaces and download behavior.

Fixtures have no network fallback for shipping purchases. No real customer order, points, inventory balance, refund or postage purchase is changed by acceptance. This proves the assembled synthetic journey. Final external acceptance still requires an appropriate provider test environment or separately approved dedicated test postage; it must not be described as already completed.

## Operational diagnosis and recovery

Use the customer's Return reference to correlate customer_return_workflow_step and customer_return_submission_failed events. The latter retains the failed boundary and bounded cause code without exception messages, SQL parameters, addresses or provider payloads. The workflow stores the current phase and last error; append-only workflow events retain who/when/from/to/error. The original label attempt ledger retains the carrier rejection or unknown outcome and original provider shipment reference.

For a stopped job, inspect the existing failure and provider readback, correct the underlying configuration/code through its normal owner, then use the same customer Try again command. Do not delete the request, clear uncertain attempts, invent source records, edit monetary balances or buy replacement postage manually as a recovery shortcut.
