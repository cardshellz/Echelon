# Order editor: the sales channel owns the price

Started 2026-11-19. Owner ruling: pricing math is the sales channel's job, not the
order editor's. The editor must not recompute or re-check discounts, tax or totals.

## Rule

Shopify works out every price. The editor:

1. tells Shopify what the customer wants changed;
2. shows the customer Shopify's numbers;
3. at submit, confirms Shopify's total is still the total the customer approved.

Club member prices are owned by shellz-club and stored on each product
(`cardshellz.plan_prices`). The editor reads the price for the customer's plan and
asks Shopify to take the difference off an added item. It does not calculate it.

## Why

Order #65231 (2026-11-06): a member with a 15% code tried three times to add two
items. Every attempt was refused with `ORDER_EDIT_PERCENTAGE_DISCOUNT_MISMATCH`.
Shopify had put $4.79 of the discount on a $32.00 item, where that item's own 15%
is $4.80. The order's total discount was correct. The editor's rule assumed each
item is rounded separately. Seven of the fifteen failures recorded in production
were this check.

Which item tripped the check is arithmetic from the stored order; the failure
record does not name the item.

## What stays, because it is not price math

A customer never sends a price. The request carries the order, item quantities,
added products, optional codes, and two reference values; unknown fields are
rejected, and the submit request has an empty body. These protections stay:

- the order and the edit belong to the signed-in customer;
- the order is re-read at submit and refused if it changed;
- the order is held until any extra is paid; unpaid edits are undone;
- a refund must equal the amount on the approved quote;
- one edit per order at a time; repeat submits are recognised;
- picking cutoff, warehouse hold, stock and product checks;
- after submit, Shopify's total must equal the approved total, or staff review.

Eligibility rules for codes and rewards (single use, combinations, already
applied) are rules, not arithmetic. They stay until step 5 decides that feature.

## Steps

Each step is its own pull request with tests.

| Step | Change | State |
| --- | --- | --- |
| 1a | Use Shopify's per-item share of a percentage code as given | Done in the pull request that adds this file |
| 1b | Remaining places that recompute Shopify's edit figures and compare: fixed-credit shares, product-discount and subtotal reconciliation, balance arithmetic | Waits on step 3 for fixed credits (see below) |
| 2 | Member price: keep lookup and apply. Remove the "club price changed since the order" refusal and the checks that try to prove which Shopify discount gave the member price | Not started |
| 3 | Test Shopify's own behaviour during an edit on the staging store | Not started |
| 4 | Preview shows Shopify's numbers in place of the editor's own pricing (`priceOrderEditPreviewItems`) | Not started; depends on step 3 and on how fast Shopify answers |
| 5 | Codes and rewards entered during an edit: owner decides whether the feature stays. If it does, the amount must come from Shopify | Not started |
| 6 | Delete pricing code left unused | Not started |

### Why fixed credits wait (step 1b)

The fixed-credit checks are not rounding checks. They refuse an edit where a
fixed credit (for example a points reward) would move onto other items when an
item is removed, or grow when a quantity grows. `SHOPIFY-ORDER-EDIT-PILOT.md`
records that Shopify keeps the original allocation and rejects increasing a line
that carries a fixed code. If that holds, the checks never fire and can go. If it
does not hold, removing them would let a customer keep or multiply a credit.
Step 3 settles which.

### Step 3: questions for the staging store

`scripts/verify-preserved-reward-staging.ts` already runs the real provider
against `cardshellz-staging.myshopify.com` on a synthetic order and cleans up.
The same approach answers, without touching a production order:

1. Does a percentage code extend to an added item, and how are its cents placed?
2. Does a fixed code stay on the original items when one is removed or increased?
3. Does the club discount apply to an added item when the editor does not add it?
   In production the added item's discount carried the editor's label, not
   Shopify's (order #65128), so today the editor applies it.
4. **Coupon minimum.** An order qualifies for a code with a minimum spend, then
   items are removed until it is below the minimum. Does Shopify drop the code in
   the edit? The editor reads a code's minimum only for codes entered during an
   edit, not for a code already on the order. If Shopify keeps the discount, add
   an explicit rule: refuse an edit that takes the order below the code's minimum.
5. Do the edit session's item discounts always equal the order's before any
   change? If they can differ, `QUOTE_BASELINE_MISMATCH` would refuse the edit.

Questions 1 to 3 are described in code comments and the pilot notes. None of the
five has been run for this plan.

## Risks

- Each removed check is one fewer place that would notice Shopify returning an
  unexpected number during an edit. The after-submit total check keeps a customer
  from being charged an amount they did not approve.
- Production has 31 edits and none since 2026-11-10, so real data can confirm the
  #65231 case and little else.
