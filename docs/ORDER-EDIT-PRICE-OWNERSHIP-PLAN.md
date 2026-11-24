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
| 1b | Remaining places that recompute Shopify's edit figures and compare: fixed-credit shares, product-discount and subtotal reconciliation, balance arithmetic | Unblocked by step 3: Shopify neither moves nor grows a fixed credit |
| 2 | Member price: keep lookup and apply. Remove the "club price changed since the order" refusal and the checks that try to prove which Shopify discount gave the member price | Not started |
| 3 | Test Shopify's own behaviour during an edit | Done 2026-11-24 on live open orders, nothing submitted (results below) |
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

### Step 3: questions

The questions the later steps depend on:

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

The staging store was judged not representative enough (owner, 2026-11-24), so
the questions were run on live open orders instead: open an edit session, stage
one change, read Shopify's calculation, stop. Nothing was committed and each
order read back unchanged afterwards.

### Step 3 results (2026-11-24, API 2026-10)

Each answer comes from one order. The requests went straight to Shopify, not
through the editor's quote path, so the editor's checks and its member-price
step played no part.

| Question | Order | What Shopify did |
| --- | --- | --- |
| 1. Percentage code, item added | #65927, 10% code | The added $1.00 item received 9 cents of the code. Existing items kept their shares. The code extends by itself; note the share is a cent under the item's own 10%. |
| 2a. Fixed code, item removed | #65912, $5.00 code | The removed item's $2.36 share went to zero. The other items kept $2.11 and $0.53. The credit did not move. |
| 2b. Fixed code, quantity increased | #65912 | Refused: "The line item has a discount that doesn't support increasing the quantity." |
| 2c. Fixed code, item added | #65912 | The added item received no share. The credit did not grow. |
| 3a. Club member, item added | #65923, no code | The added item came in at full price ($139.99) with no member discount, although the same product carries a member discount on other open orders. The editor must keep applying the member price. |
| 3b. Club member, quantity increased | #65923 | Refused with the same message as 2b. Extra units of a member-priced item must be added as a separate line, as the editor does. |
| 4. Below the code's minimum | #65912, $5.00 code with a $35.00 minimum | After removing the dearest item, items were $19.53 before discount, under the minimum. Shopify kept the code on the remaining items ($2.64). It does not drop a code that no longer qualifies. |
| 5. Session equals order before any change | #65911 | A full quote through the deployed editor passed the comparison (2026-11-23). |

What follows:

- **Step 1b can proceed.** The fixed-credit checks guard against a credit moving
  or multiplying, and Shopify does neither.
- **Step 2 keeps the member-price step.** Only the checks around it go.
- **Coupon minimum: refuse the edit (owner, 2026-11-24).** A customer could
  qualify for a minimum-spend code, then remove items and keep the code's share
  on what remains. The editor now refuses a reviewed edit that takes the order
  below the minimum of a code applied at checkout
  (`ORDER_EDIT_CODE_MINIMUM_NOT_MET`, `domain/order-edit-code-minimum.ts`).
  - Checked at review (quote), after Shopify has calculated the edit, using
    Shopify's item prices. The live preview does not show it yet.
  - An order already below the minimum can still be edited if the edit does
    not take it further below.
  - A code that was deleted, or is not a basic code, has no minimum to read and
    is not blocked.
  - **Not confirmed:** whether Shopify measures the minimum before or after the
    club discount. A trial calculation could not settle it (the $35.00-minimum
    codes in use were not accepted for another customer even well above the
    minimum). The rule compares item prices before any discount, so a member is
    refused only when below the minimum on both readings.
  - Not covered: a code added during an earlier edit (stored as a manual
    discount, not a checkout code).
- **A checkout code cannot be taken off in an edit** (tested 2026-11-24 on
  #65912 and #65927, nothing submitted). `orderEditRemoveDiscount` on the code
  is refused: "This discount was applied using a discount code and can't be
  removed." Removing an item and adding the same product back as a new line
  drops a fixed code's share from it (the new line carried none), but a
  percentage code re-applies to the new line (174 cents, against 175 before).
  So "allow the edit but strip the code" is possible only for fixed codes, and
  only by replacing every remaining line. What replacing lines does to the
  warehouse side was not checked.
- Not tested: a percentage code with a minimum (the three open orders with a
  minimum all carried fixed codes), and any of these after commit.

## Risks

- Each removed check is one fewer place that would notice Shopify returning an
  unexpected number during an edit. The after-submit total check keeps a customer
  from being charged an amount they did not approve.
- Production has 31 edits and none since 2026-11-10, so real data can confirm the
  #65231 case and little else.
