# Shopify coupons and points redemption

This change removes the rewards-ledger dependency from newly entered Shopify
coupons. It does **not** implement native coupon redemption on an existing order.
Do not describe a successful calculation or manual adjustment as recorded native
coupon usage.

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

## Unresolved native-redemption limitation

Shopify's [`DraftOrderInput`](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/DraftOrderInput)
accepts discount codes for calculation. Its
[`OrderEditAppliedDiscountInput`](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderEditAppliedDiscountInput)
accepts only a description, fixed value or percentage. A manual line adjustment
does not supply a coupon identity for native redemption.

`assertCouponAdjustmentSupported` therefore rejects new limited-use and
once-per-customer coupons before `orderEditBegin`. Their calculation can succeed;
that does not prove usage can be recorded safely. Existing unrestricted-campaign
adjustments remain supported but do not increment Shopify's native coupon usage
counter. No custom coupon-redemption ledger is introduced.

The old `unlimited` and `single_use_reward` serialized values exist only to finish
or recover already persisted operations. Do not use them to admit newly entered
coupons or infer reward issuance from a coupon's shape.

## Evidence and release limits

- Read-only Shopify calculations on order #64043 returned $0.23 for each 10%
  example (`SHELLZ_10` and `A8JVQ7BPN3MZ`) and $0.46 for the 20%
  `SHELLZ_AFFILIATE` example, with the native $0.46 member discount also present.
  These calculations did not create an order, consume a code or debit points.
- Tests cover coupon classification, native calculation and reconciliation,
  independence from Club availability, legacy receipt recovery and desktop/mobile
  handling of both eligibility and redemption-capability failures.
- These results do not prove live order commit, payment, refund or native coupon
  redemption. Full support for limited-use coupons remains unresolved.
