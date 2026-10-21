# Order edit payment return and paid completion

## Confirmed incident

Read-only inspection of order #64534 on October 21 confirmed the additional
$3.35 payment succeeded. Shopify reported fully paid, $9.17 net paid, and zero
outstanding. Club's 233-point reward receipt was already `used`, with its ledger
entry `completed`. No production reconciliation, payment, refund, points change,
or order mutation was performed during this investigation or validation.

The persisted edit was `synchronizing` with
`ORDER_EDIT_PROJECTION_TOTALS_INVALID`. Its original item had a native editable
line total of 279 cents, but the canonical financial allocation correctly showed
zero cents after the original reward. The added item had a net of 216 cents.
`OrderEditPaidProjection.projectLocked` summed the raw 279 and 216 amounts instead
of the proved financial nets, preventing OMS projection and warehouse release.

A database regression also confirmed that terminal completion previously cleared
WMS edit ownership without retiring the provider hold receipt. Physical manual
holds and an edit's receipt are separate responsibilities.

## Implementation ownership

- `client/src/pages/OrderEdits.tsx::OrderEditOperationView` explicitly targets
  `_self` for customer payment links. Staff payment links retain their behavior.
  Ordinary progress has no status button; failures and uncertain commands offer
  **Try again**. An acknowledged pending payment is progress, not a red failure.
- `client/src/customer-account/use-order-edit-status.ts::useOrderEditStatus`
  observes submitted operations with serial, abortable, visible-page reads every
  five seconds. Focus, pageshow and visibility return refresh promptly. A failed
  read stops scheduled requests and offers retry. Terminal states stop polling.
  Timers and return events never submit financial reconciliation commands.
- `order-edit-payment-return.ts` stores a bounded, customer/connection-scoped
  session navigation hint before leaving. Returning to the matching account page
  can reopen the exact operation even after it is no longer active. The ordinary
  authenticated API must verify it before the hint is consumed. Browser state,
  URL parameters and return events are never evidence that money was paid.
- `CustomerOrderEditor` prevents old reads from overwriting a command's newer
  response and ignores aborted responses after close. **Done** refreshes native
  account totals after verified completion.
- `server/modules/oms/order-edit-paid-pricing.ts::buildOrderEditPaidPricing`
  derives exact line nets from the validated financial breakdown. It binds IDs,
  quantities, unit retail prices and whole-line product nets; validates all sums;
  uses BigInt arithmetic; and retains the reconciling legacy fallback. For the
  incident, it projects original net 0, added net 216, member saving 50 and new
  reward saving 233, with merchandise net 216 + shipping 649 + tax 52 = 917.
- `finalizeOrderEditWarehouseRelease` retires verified provider receipts through
  the existing OMS command in the same transaction as terminal state, warehouse
  owner release and immutable audit. The persisted operation supplies the clock.
  Failure rolls everything back. Independent manual holds remain intact.

No discount combination policy, reward issuance/settlement owner, draft hold
policy, payment gateway configuration or Shopify order data is changed by this
implementation.

## Validation and limits

- Unit coverage includes native allocations, legacy evidence, tax-inclusive
  evidence, uneven cents, removed lines, invalid/duplicate/missing identities,
  overflow, browser context ownership/expiry/storage failures, and payment UI.
- Real disposable PostgreSQL tests exercise the actual paid projector, service
  sweep, operation store, warehouse gateway and inventory certification. They
  prove exact amounts, concurrent projection retries, a failed remote release,
  terminal completion on retry, one projection audit, receipt retirement,
  preservation of a manual hold, and no remaining pending operation. Audit
  persistence failure rolls receipt retirement and owner release back together.
  External warehouse calls are controlled test doubles, not live ShipStation.
- Desktop/mobile browser tests cover the real account entry and signed-envelope
  transport with intercepted HTTP: same-tab navigation, return after an operation
  became inactive, automatic completion, focus/background behavior, slow and late
  reads, failure-only retry and absence of automatic financial commands.
- Existing Club acceptance ran against `cardshellz-staging.myshopify.com` with a
  disposable localhost points ledger. A real issued reward was finalized twice
  through the existing settlement service; the second finalization preserved the
  balance. Unpaid recovery and non-points coupon exclusion were also verified.
- Native Shopify test-store order #1028 accepted a $1 additional payment through
  the existing **Test Payment Gateway**. Readback proved `test: true`, `SUCCESS`,
  `fullyPaid: true` and zero outstanding. No real card was charged. The synthetic
  order was cancelled and archived; Shopify refused deletion of a brokered order.
  The synthetic draft was deleted. This is not a production payment test.
- The test store returns to Shopify's hosted order confirmation after payment.
  It does not automatically redirect to our editor. The store-account return is
  independently tested; no undocumented checkout return parameter is appended.
  A hosted confirmation alone does not prove Echelon completion or hold release.

## Release boundary

Deploying the backend lets the ordinary worker retry already-paid, stuck edits,
including #64534. That can update its OMS financial projection and release its
edit-specific fulfillment holds. It must not issue another payment or consume a
used reward again. A shared-backend release therefore requires deployment approval;
the validation here deliberately did not replay the real operation.

The companion theme change targets only unpublished theme `174740308127`.
Production completion remains unverified until an approved release is observed.
