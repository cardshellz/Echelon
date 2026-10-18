# Club rewards in the customer order editor

## Ownership and reuse

The editor mounts `window.CardShellz.mountRedemptionWidget` from Club's existing
`theme-extension/assets/cardshellz-membership.js`. The cart calls that same
renderer. `client/src/customer-account/ClubRewardsWidget.tsx` is an account and
order adapter: it supplies the authenticated balance, persists request identity,
and applies the returned code through the existing order-edit preview.

Club owns points, issuance, expiration, cancellation, and redemption records.
Echelon never debits points. An ordinary Shopify coupon does not become a reward
because it has a particular prefix or usage restriction. Club must identify an
owned canonical issuance record before Echelon classifies a code as `club_reward`.
Native coupon restrictions and combination rules are still checked.

The customer-account proxy and `CustomerOrderEditService` verify the signed
customer, channel, and order ownership before requesting rewards. Internal Club
routes retain their API-key authentication. Requests and replies use the versioned
reward-widget schemas in both repositories.

## Financial lifecycle

| Stage | Durable effect | Retry / failure behavior |
| --- | --- | --- |
| Open editor / preview | Read balance and unused rewards | No issuance or warehouse hold |
| Redeem points | Club locks the member, reserves one ledger debit and an `issuing` reward for the request UUID | Same UUID returns the same code; another UUID cannot overspend the locked balance |
| Native code creation | Existing Shopify gateway ensures the deterministic code and verifies its customer, value and limits | A lost reply leaves a recoverable issuance; retry looks up the same code |
| Apply code to preview | Existing pricing verifies native rules and the entire reward amount | Invalid or partial use leaves the issued reward available |
| Submit approved edit | Existing receipt lifecycle claims the reward and deactivates its native code before commit | Competing edits and cancellation cannot claim the same reward |
| Confirm settled order | Native order and payment/refund evidence are verified before consuming the receipt and reward | Repeated finalization is idempotent |
| Failed submission | Existing recovery first proves the original order, then restores the code and releases its receipt | An uncertain order or native outcome stays reserved for reconciliation, never automatically refunded or made spendable twice |
| Cancel / expire unused reward | Club verifies native non-use, then atomically completes the debit and creates one refund entry | Duplicate callbacks cannot return points twice |

Native checkout settlement uses the same issuance records. The obsolete draft
invoice route refuses canonical rewards rather than turning a single-use code
into an untracked manual adjustment. The member portal and cart retain their
public interfaces and use the shared issuance service.

Money and point balances are decimal strings or integer hundredths; financial
arithmetic uses integer values. No migration or alternate points ledger is added.
State transitions emit structured audit events after successful transactions.

## Evidence and remaining acceptance work

Local verification on 2026-10-18:

- 653 Echelon order-edit/customer-account/transport tests passed; application type
  check and the customer-account production bundle build passed.
- 800 Club server tests passed, including disposable PostgreSQL transaction and
  concurrency tests. The final ownership-retry check and script suite passed
  together (111 tests). Both Club TypeScript projects passed.
- Three browser tests exercised the actual shared Club renderer. All 59 theme
  browser tests passed with that same renderer, including mobile, lost issuance
  replies, saved-code entry, submission, and cancellation after failed preparation.
  The six reward-related theme tests also passed with the standard CI host fixture.

These are automated/local results, not proof of deployment or live Shopify
settlement. The staging acceptance target is unpublished theme `174740308127`.
The theme build manifest pins the Echelon source commit and bundle hashes.

After deployment, record the deployed SHAs and releases, customer/order under
test, request UUID, reward ID, operation ID, original/final balance, code state,
receipt state, and order/payment outcome. Do not log credentials or session tokens.
Verify reuse after a failed edit and rejection after a successful one. A staging
theme still uses real customer orders and points; financial test actions must be
authorized separately from merely opening the preview.

The databases serialize local claims, but Shopify checkout and order edits do not
share a transaction. The service deactivates the native code and checks both its
usage and customer order history before submission and settlement. Local tests
cannot establish Shopify's behavior for an already-in-flight checkout; that
cross-system case requires native acceptance evidence. Uncertain evidence must
remain reserved for reconciliation, not be treated as a completed redemption or
an automatic refund.
