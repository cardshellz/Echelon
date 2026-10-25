# Preserve automatic Club prices when applying an order discount

## Confirmed failure and correction

`ShopifyOrderEditProvider.stageCodes` previously tried to reproduce the combined
Club and order-discount amount as a manual discount on every line. Shopify rejects
`orderEditAddLineItemDiscount` on an original line that already has an automatic
discount. This happened before order submission, even though the displayed totals
were valid.

The corrected path preserves the original automatic line and represents the
already-approved **order** saving on editable lines. It reuses the existing
discount-rule validation, combination checks, exact-cent allocation engine, and
Club reservation/finalization/release services. It does not issue a new reward or
treat ordinary Shopify coupons as Club points.

For the reported selection, product prices remain $2.33 and $4.49. The customer
summary retains a separate $1.00 order discount. Native allocation is $2.33 on the
original line and $3.49 on the added line. Items after discounts are $5.82;
shipping is $6.49; tax is $0.74; the total is $13.05.

## Invariants and source trace

- `domain/order-edit-native-code-allocation.ts`:
  `allocateOrderEditNativeCodePricing` preserves automatic product prices and the
  full validated saving. It rejects insufficient editable capacity; it never
  partially spends a reward. `referenceOrderEditCodePricing` rebuilds the normal
  allocation from logical items, including native penny splits.
- `infrastructure/shopify-order-edit.provider.ts`:
  `protectedCodeTotals` compares native-allocation and reference-allocation
  shipping, tax lines and totals. `stageCodes` requires matching original native
  allocation identities and amounts and never manually discounts a protected
  line. It verifies the final native tax evidence again. `prepareCommit`
  rechecks current eligibility, combination rules, tax and shipping before the
  existing reward reservation callback and commit boundary.
- `application/order-edit-provider.schema.ts`:
  `preservesAutomaticQuotePrice` binds the new optional proof to the original
  line, quantity, raw native price and reconciled net amount. Shopify raw unit
  and subtotal fields can exclude an automatic order allocation: $2.79 raw minus
  $0.46 automatic allocation is $2.33 net. These fields are not interchangeable.
- `application/order-edit-evidence.ts` and
  `infrastructure/postgres-order-edit-code-history.ts`:
  committed readback must preserve the original automatic rule and allocation.
  `withOrderEditCodePricing` retains that evidence for subsequent edits.
  `stageRecovery` and `isUnpaidRecoveryRestored` restore and verify the original
  price without attempting another forbidden manual discount.

Paths above are relative to `server/modules/order-edits/`. The additional proof
field is optional in `shared/order-edits/order-edit-codes.ts`; old persisted
quotes retain their existing interpretation. No database migration, reward
ledger mutation, warehouse-hold change or theme change is part of this fix.

## Validation and operational limits

- 630 order-edit unit/API-contract tests passed, including native submission
  after reservation, missing reservation, changed tax, wrong automatic rule,
  exact allocation, inadequate capacity and unpaid recovery.
- 90 PostgreSQL integration tests passed on a new localhost-only disposable
  PostgreSQL 17 cluster. The owned cluster was stopped afterward. These cover
  the existing warehouse/store concurrency and submission-hold behavior.
- At **2026-10-18 20:19:56 UTC**, the corrected provider successfully prepared an
  **uncommitted native Shopify quote** for order #64043 with the customer's
  selected added item and the same approved $1 reward. Shopify returned total
  1305 cents, shipping 649 cents and tax 74 cents. Before/after committed order
  fingerprints matched. The probe explicitly prohibited order commit, payment,
  refund, code mutation, reward issuance and redemption operations.
- A subsequent read-only database inspection found that the saved reward was
  still pending with no used-at timestamp or order association, the original
  100-point ledger debit, and zero editor redemption receipts. The failed edit
  had expired without a commit attempt or warehouse hold.

This does **not** prove a real committed order, successful payment, native unpaid
reversal, or post-success reward-reuse rejection. Those remain staging acceptance
steps after deployment. The earlier permission covered one $1 reward and a
refund-only test; this added-item selection would require an additional payment,
which has not been authorized or submitted by the agent.

Orders containing only protected automatic-discount lines, or insufficient
editable value to carry the entire approved saving, remain unsupported. An
allocation that changes tax or shipping is also rejected before submission.
The native line allocation differs from proportional checkout allocation;
downstream refunds must continue to use verified native net amounts, not the
customer-facing Club unit price. Automatic expiry-job scheduling was not
verified by this change.

Deployment of this additional shared-backend fix requires approval. The earlier
approved recovery changes (Club #251, Echelon #1839 and staging-theme #153) are
already deployed; they did not resolve this separate native discount constraint.
