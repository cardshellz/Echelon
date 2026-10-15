# Unrestricted Shopify coupon adjustments

The order editor supports a deliberately limited workaround: use Shopify to
calculate an eligible, unrestricted order coupon, then apply its approved saving
as a manual order-edit discount. Shopify's native coupon usage count does not
increase. The code, verified terms and exact saving remain in the existing order
edit record. No separate coupon-redemption ledger or rewards-points dependency is
introduced.

## Supported boundary

| Case | Result |
| --- | --- |
| Whole-order percentage or fixed-amount code, `usageLimit: null` and `appliesOncePerCustomer: false` | Calculate with Shopify; apply only its verified saving and permitted combinations. |
| Any finite usage limit, including a single use | Block before calculation or opening an edit. |
| Once-per-customer code | Block before calculation or opening an edit. |
| Missing usage or combination metadata | Block; never assume unrestricted usage. |
| Code already applied, or another code from the same discount campaign | Block duplicate application, including on a later edit. |
| Shopify omits the code, rejects eligibility, or returns inconsistent prices | Block; preserve the current order. |
| Product-specific, shipping, app-defined or other unsupported discount type | Block; this workaround is limited to the verified whole-order adapter. |

Customer messages explain usage-limit restrictions and provide a **Clear code**
action so the customer can continue editing. Point redemption remains a separate
flow. Adding a code to an order with an existing native Shopify code still requires
review; this change does not claim support for that combination.

## Ownership and execution

1. `ShopifyOrderEditCodes.rules` reads Shopify's discount identity and terms.
   Customer restrictions, customer segments, percentage/fixed values and usage
   limits never identify a points reward. Every newly entered code is classified
   as `shopify_coupon`.
2. `verifyNativeCalculation` sends the original Shopify customer ID and revised
   variant quantities to `draftOrderCalculate`, with automatic discounts enabled.
   It does not substitute member prices or suppress the member-pricing function
   for a new coupon. Shopify returns the applicable code amounts; the adapter
   verifies the returned products, quantities, currency and item totals.
3. Existing reciprocal combination checks remain in place, including checks for
   recalculated shipping benefits. The native coupon calculation is not proof
   that a separately recalculated shipping benefit can be combined.
4. The existing adjustment engine allocates approved amounts in cents and stages
   manual line discounts. The provider rechecks Shopify terms and amounts before
   commit. Existing order locks, payment/refund confirmation, audit records and
   recovery protections still apply.
5. Newly entered coupons never call the Club receipt adapter. The provider has
   no dependency on that adapter. The application retains reserve/finalize/release
   only for old persisted operations whose original quote requires those receipts.

Points redemption remains the Club system's responsibility. This patch neither
debits points nor adds a new points-redemption control to the order editor. The
entry field is labelled **Discount code** to avoid conflating those operations.

## Native-redemption limitation

Shopify's [`DraftOrderInput`](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/DraftOrderInput)
accepts discount codes for calculation. Its
[`OrderEditAppliedDiscountInput`](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderEditAppliedDiscountInput)
accepts only a description, fixed value or percentage. A manual line adjustment
does not supply a coupon identity for native redemption.

`assertCouponAdjustmentSupported` therefore rejects new limited-use and
once-per-customer coupons before calculation and `orderEditBegin`. A calculation
could succeed without recording native usage. Unrestricted-campaign
adjustments remain supported but do not increment Shopify's native coupon usage
counter. No custom coupon-redemption ledger is introduced.

The old `unlimited` and `single_use_reward` serialized values exist only to finish
or recover already persisted operations. Do not use them to admit newly entered
coupons or infer reward issuance from a coupon's shape.

## Customer price presentation

`presentOrderEditCodeBreakdown` adds response-only display fields from the existing
verified code-pricing proof. Each item's `productNetCents` is its price after
product/member discounts and before order coupons. Its existing `netCents` remains
the amount after all allocated discounts. `orderDiscounts` identifies the exact
coupon amounts already included in `itemDiscounts`; it is not another discount.
The response schema checks that item subtotals minus these coupons equal the
original item net, and rejects missing, mismatched or non-reconciling evidence.
Saved pricing proofs, fingerprints, shipping inputs, taxes and financial commands
are unchanged.

The customer draft and review display the club unit/line price, then item subtotal,
each order coupon, shipping, tax and updated total. For the #64043 screenshot case:
233 - 23 + 549 + 46 = 805 cents, against 829 cents already paid, yielding a 24-cent
refund difference. The customer modal replaces payment history with **Already
paid** (net of recorded refunds) and the payment/refund difference. Staff retain
their payment history. Older evidence without a verified product/coupon split
keeps its original exact net amounts; the UI never reverse-engineers a club price.

Deploy this backend before the rebuilt staging theme. New clients opt into display
version `v1` using `X-Order-Edit-Pricing-Display`, carried in the customer proxy's
JSON query as `pricingDisplayVersion`. Old tabs receive the previous strict
response shape. This capability changes presentation only and grants no access.
No migration is needed. The complete browser walkthrough remains mocked; it
cannot prove a deployed Shopify refund or payment.

## Evidence and release limits

- Read-only Shopify calculations on order #64043 returned $0.23 for each 10%
  example (`SHELLZ_10` and `A8JVQ7BPN3MZ`) and $0.46 for the 20%
  `SHELLZ_AFFILIATE` example, with the native $0.46 member discount also present.
  These calculations did not create an order, consume a code or debit points.
- Tests cover coupon classification, native calculation and reconciliation,
  independence from Club availability, legacy receipt recovery and desktop/mobile
  handling of both eligibility and redemption-capability failures.
- Follow-up coverage includes changed usage limits, once-per-customer flags,
  combination settings and rejected/changed savings before commit; duplicate
  campaign protection; a coupon-only refund; repeated confirmation and recovery
  of a lost refund response using the same persisted refund intent.
- These results do not prove live order commit, payment, refund or native coupon
  redemption. Full support for limited-use coupons remains unresolved.

## Staging acceptance

1. Use a whole-order percentage test code with no usage limit and no
   once-per-customer restriction. Configure its combination settings explicitly.
2. On an eligible test order, add the code without changing quantities. Confirm
   the code saving, revised tax, total and refund or payment difference. Remove
   and re-add the code; the saving must appear once.
3. Verify a capped code and a once-per-customer code are rejected with a clear
   explanation; clearing the input must preserve the item changes.
4. Verify an incompatible code leaves existing club/shipping discounts intact.
   Change code settings after review; submission must require a fresh review.
5. With explicit authorization for a real financial test, apply the reviewed
   unrestricted-code edit and verify the original Shopify order, manual discount,
   exact refund/payment transaction, OMS state and fulfillment hold/release.
   Retry/reload must not create a second adjustment or refund.
6. Reopen the order and attempt the same coupon again. It must not compound the
   prior saving. Shopify's native usage count is expected to remain unchanged.

The staging theme shares the real Shopify orders and backend. Mocked tests do
not prove the live apply/refund step; no live transaction is part of this patch.
