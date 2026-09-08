# Shipping provider review recovery

## Outcome and scope

This batch closes the proven eBay omitted-quantity readback defect and supplies
the missing explicit recovery path for both that defect and the Shopify
partial-package lineage defect fixed by PR 1413. Recovery lives in the existing
Operations Tower detail, not another page. No migrations, new production tables,
writer-baseline changes, Dropship work, automatic review retries, inventory
adjustments, or production-setting changes are included.

PR 1413 merged as `099c6402c3f5f7bd0b13b56c215d631478546b1f` and was verified
deployed in Heroku v2883 on 2026-09-08. This document does not claim this new batch
is deployed or that production review records have been resolved.

## What the evidence definitely proves

The user approved read-only access to the two specified eBay orders through the
existing connection, without token refresh or writes. The diagnostic read only
the channel 67 production access token, verified the existing immutable account
identity, and used GET requests for the two order fulfillment collections,
the exact fulfillment details, and the corresponding order quantity evidence.
No credentials or customer/address/payment data are stored here.

| Order | Command | Tracking and fulfillment ID | Exact line ID | Provider order quantity |
|---|---|---|---|---|
| 08-15140-13597 | 3018 | 9400150106151382305802 | 10083776958108 | 3 |
| 14-15129-29548 | 3019 | 9434650106151135924856 | 10084705501414 | 1 |

Both collection and detail returned `lineItems: [{ lineItemId: ... }]`, with
`quantity` absent, not zero or null. Both collections reported `total: 1`.
Both current orders returned the exact order ID, `orderFulfillmentStatus:
FULFILLED`, one exact matching fulfillment URL, `cancelState: NONE_REQUESTED`,
an empty cancellation request list, and only the matching line with its numeric
quantity and `lineItemFulfillmentStatus: FULFILLED`. Both fulfillment records
had valid shipped timestamps. eBay already reports these orders fulfilled;
creating another fulfillment is not the correction.

The previous `normalizeFulfillmentLines` in `ebay-api.client.ts` converted an
absent quantity to `NaN`, making the candidate line set invalid despite matching
tracking and line identities. `findShippingFulfillment` then threw
`ebay_fulfillment_idempotency_conflict` and correctly refused another POST.
This is a proven missing-field handling defect, not a SKU match failure or proof
of a reshipment.

## Correction and explicitly bounded inference

The new provider-only helper derives absent quantities from an independently
read current eBay order only when there is a single complete fulfillment
covering the entire fully fulfilled order. This is an inference from all of
those provider facts, **not** an eBay rule that a missing quantity means one.

[eBay's fulfillment guide](https://developer.ebay.com/api-docs/sell/static/orders/managing-fulfillments.html)
states that a fulfilled order has all lines fulfilled, that the collection
returns all fulfillments, and that a valid shipped timestamp establishes
fulfillment completion. The implementation additionally requires exact full
line-set equality, positive safe integer provider quantities, the same account
token, the sole exact order fulfillment URL, no cancellation, and an unchanged
second collection read. It never follows an arbitrary provider URL.

Only omitted fields qualify. Explicit null/zero/invalid quantities, different
quantities, partial orders, multiple fulfillments, extra or duplicated line IDs,
changed evidence, and failed reads do not authorize fulfillment. The final
signature must still match the saved exact package request. The new inference
is limited to canonical strict readback; legacy explicit-quantity behavior is
preserved. Existing OMS success evidence records
`quantityEvidenceSource: provider_fulfilled_whole_order`.

## Reviewed recovery, not automatic retries

Earlier handoff language incorrectly suggested an existing general owner retry
could resolve these commands. The previous private requeue accepts only
`COMMAND_REQUEST_CONFLICT`; it cannot recover either observed provider error.

The new OMS-owned action uses the existing
`POST /api/oms/ops/reconciliation/remediate` route with
`code: CHANNEL_FULFILLMENT_REVIEW_RETRY` and exact command/order IDs. Preview
is the default and performs no write or provider call. The existing Tower panel
shows recognizable order, tracking, SKU and saved package quantities. Execution
requires a fresh preview fingerprint, an explicit reason, and the authenticated
server-session operator with Operations triage permission.

One transaction locks the exact command, checks its reviewed state and remaining
attempt budget, inserts the prior state into existing append-only
`oms.channel_fulfillment_push_requeues`, and queues the same immutable command.
It does not edit command quantities, reset attempt history, mark fulfillment
successful, activate allocation authority, or call a provider. Repeating the
same action is a no-op even after the worker advances the command; changed
state requires a new preview. The normal worker retains all allocation,
account, package and external-provider checks. Eligibility means eligible for
revalidation, not that provider validation already succeeded.

## Live read-only preview

The new owner preview was executed with database-enforced read-only mode and
an 8-second statement timeout. All four exact commands were still in review,
at attempt 1 of 12, with no retry eligibility blockers:

- eBay 3018 and 3019: quantities 3 and 1, as above.
- Shopify 3024 / #62807: SHLZ-SEMI-OVR-C2000, package quantity 1,
  tracking 383583252306.
- Shopify 3025 / #62814: ESS-TOP-STD-SLV-CLR-C1000, package quantity 1,
  tracking 9434650206217283528328.

No production status, audit, provider fulfillment, inventory, or label was
changed. This is not proof that the commands have been successfully recovered.

A second bounded read compared the Shopify commands' referenced plans with their
groups' current versions. Plans 213 and 214 are still current version 1; each
has one quantity-1 package allocation and one quantity-1 `awaiting_relabel`
allocation. Matching label-review exceptions 6781 and 6783 are open. This proves
the residual is current and that related reviews exist; it does not prove the
exception is caused specifically by that residual or authorize completing it.

## Verification

Connected PostgreSQL coverage includes real owner/provider-boundary database
operations with mocked transport, quantities 1 and 3, exact originating account,
no extra provider POST on replay, Shopify stored/live mappings, and split-package
quantities. Recovery coverage includes duplicate concurrent actions, a competing
stale action, wrong order, immutable audits, rollback when the post-audit update
fails, preserved attempts, and replay after a successful worker attempt.

The frozen-code verification completed successfully:

- Full non-integration sweep: 12,108 passed, 0 failed, 23 skipped across 1,113
  test files. This includes the migration-prefix collision guard (1 test) and
  writer-ratchet guards (3 tests).
- Connected shipping PostgreSQL suite: all 37 tests passed.
- Focused coverage: 130 eBay tests, 54 owner recovery/route/ownership tests, and
  72 UI helper/neighbor tests passed. These overlap the full sweep above.
- Final TypeScript check, production build, and whitespace diff check passed.

The build reported an existing large-client-chunk warning; the test runs also
reported existing mock/deprecation warnings. Neither caused a failure. Browser
interaction against the deployed panel has not been tested. GitHub CI and
post-deployment recovery remain separate verification steps; local passing
tests do not establish either outcome.

## Operational finish line and unknowns

Deploy this batch, preview the four exact commands again, and perform explicitly
authorized targeted recovery through the owner action, then verify command
outcomes and exact provider evidence. Do not use a direct SQL status update or
bulk retry. The two Shopify package quantities remain one each; this does not
grant authority to fulfill any unallocated remainder.

The broader historical review backlog is not claimed resolved by these four
cases. The two current `awaiting_relabel` quantities remain separate from the
labeled packages being recovered. Exact subsequent package evidence or an
explicit business resolution is still required; this change neither assigns
them to a label nor closes their related exceptions. Dropship remains
deferred. No claim is made about every marketplace's cancellation policy or
actual carrier possession.
