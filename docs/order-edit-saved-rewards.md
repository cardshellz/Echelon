# Saved Club rewards in the order editor

Customers can independently select saved rewards, remove them from the draft, or return an unused reward to points. Selection is a pricing preview and does not spend points again. Multiple codes still pass Shopify's native eligibility and combination calculation and Club's existing reward validation. The existing Club widget caps new redemption to the remaining merchandise value; a saved reward exceeding that value remains unused and can be returned.

`CustomerOrderEditService.manageRewards/cancelReward` binds these actions to the signed-in customer's owned order. `ClubOrderEditCodeRedemptions` forwards to Club's authenticated rewards management endpoints. Club's `RewardWidgetService.cancel` delegates to the existing `RewardCancellationService`, also used by the member portal. Its existing store locks the redemption, excludes reserved/used rewards, verifies native code deactivation and non-use, and posts the canonical cancellation ledger entry once. No editor-specific balance or refund ledger is introduced.

The v2 management response exposes canonical redemption IDs and cancellation recovery state. The v1 state response remains unchanged for older clients. After cancellation succeeds or fails, the editor reloads management state from Club; it never adds the points locally. A cancellation awaiting verification remains visible after reload and can be retried by the same reward ID. A failed state refresh hides stale spendable balances.

## Original Club-priced merchandise

Shopify rejects adding a manual discount to an original automatically discounted line. When other editable items cannot carry the complete, natively approved order discount, `allocateOrderEditNativeCodePricing` marks the affected original for replacement with the **same real variant in the same order**. `ShopifyOrderEditProvider` verifies that the original is unfulfilled and has no customization, selling plan, or bundle properties that the add-variant API cannot preserve. It stages the original at zero and adds the approved quantity of that variant, retaining both Club pricing and the order discount in the native merchandise price. The quote records original, calculated, and commercial source identities. The customer continues to see the Club unit price, with rewards separately deducted in the summary.

The provider verifies native merchandise, shipping, tax lines, total, refund capacity, and item metadata again before commit. This replacement path is limited to edits without additional payment: restoration of replaced original line identity after payment expiry is not proven. Existing allocation onto newly added items remains available where it preserves the full saving and native tax. A blocked or failed preview does not reserve or consume a reward. The existing commit/reservation/settlement/recovery services remain authoritative.

## Evidence and release boundary

On 2026-10-19 a guarded provider probe on order #64043 verified:

- $2.33 merchandise minus the existing $1 reward: $1.33 merchandise, $5.49 shipping, $0.41 native tax, $7.23 total.
- Two $2.33 units with both existing rewards ($1 and $3.66): $0 merchandise, $5.49 shipping, $0.33 native tax, $5.82 total.
- Both previews and staged quotes matched and passed pre-submit verification. The probe stopped before reward reservation and native commit, prohibited payment/refund/code mutations, and verified unchanged saved-order and reward-state snapshots afterward.

Local tests cover single/multiple selection, returning the unused reward, exact canonical balance refresh, response loss, cancellation retry after reload, native replacement quote/readback, rejection of customization or unpaid replacement, and native combination rejection. Club's existing PostgreSQL integration tests exercise duplicate cancellation and cancellation versus redemption races. Theme tests use the actual shared Club widget script.

These checks do not prove a deployed financial transaction. Deploy the Club management endpoints first, then Echelon, then the rebuilt **staging-only** theme (174740308127). Production order submission, point return, payment, and refund require the separately authorized customer test; deployment alone must perform none of them.
