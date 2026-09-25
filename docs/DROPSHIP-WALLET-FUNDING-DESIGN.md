# Dropship wallet funding — design record

Owner decisions of 2026-09-20, recorded once so the code has a written source.
Each phase is its own pull request on the funding branch; the sections name
the code that carries each rule. Money is integer cents everywhere.

## Model

A prepaid deposit account per vendor: two stored balances (`available`,
`pending`) on `dropship.dropship_wallet_accounts`, every movement a row in
`dropship.dropship_wallet_ledger`. Orders never move money; they reassign it.
Negative balances are allowed since migration 191: a negative is the
receivable the daily wallet run collects.

## Sources

- **Bank account (ACH debit)** — one-off deposits and the only routine autopay
  besides a card. Free. Lands in days; counted as `pending` until it does.
- **Card** — routine autopay or backstop, at the card fee (3% at launch,
  disclosed when set and on every charge).
- **USDC** — one-off deposits to the vendor's own address in a wallet Card
  Shellz controls, credited by the chain watcher (phase 6). No fee, and it
  can never be pulled, so it is never the autopay source.

## Tiers (phase 1 and 2, merged)

Two admin-set minimums on the versioned policy row (`migrations/0683`):
pack tier (eaches, inner packs) and case tier. The pack tier is kept when the
vendor's auto-reload floor or their balance (pending counts) is at the
minimum; cases are on sale once the balance counting pending reaches the case
minimum. A raised minimum is enforced after the grace period, by publishing
zero for that tier's SKUs (`domain/listing-tiers.ts`, the hourly reconciler).

## The shortfall waterfall at acceptance (phase 3)

`server/modules/dropship/domain/acceptance-funding.ts`, applied in
`dropship-order-acceptance.repository.ts` under the wallet row lock:

1. **Available balance** pays first, free.
2. **Pending-ACH advance** — the order is accepted against bank transfers still
   settling. Represented as an overdraft of `available`, bounded by the
   eligible pending credits and by the cap (policy cap, or the vendor's
   credit-profile override). Fee on the amount used (`advance_fee` ledger row,
   migration 0688), posted in the same transaction as the order debit and
   counted inside the bound. All-or-nothing per order: an order the advance
   cannot cover whole goes to the card. Eligibility is judged per bank
   account: company account holder, a balance read through Stripe Financial
   Connections when it was linked, and one earlier pull from it settled.
3. **Card backstop** — the order-processing pass charges the card the whole
   gap, plus a refill back to the minimum only within the single top-up bound,
   and never more than the policy's manual funding maximum in one charge
   (`decideCardBackstopCharge`). An order whose gap alone is above that
   maximum is not charged and waits. Phase 7: the bound shapes routine
   top-ups, not what a held order may be charged.
4. **Payment hold** — 24 hours (policy), then the order is cancelled.

When a pending credit settles, the existing settlement path adds it to
`available` and the overdraft clears. When it fails, the existing void path
removes it from `pending`; the negative stays, the vendor is paused in the
same transaction, and the daily wallet run collects the amount.

Balance verification is opt-in. The ACH setup session asks Financial
Connections for `payment_method` only, because Stripe refuses the entire bank
link when an account requests `balances` before registering for that product,
and the vendor meets that as a bare failure at "Add a bank account". Setting
`DROPSHIP_STRIPE_FINANCIAL_CONNECTIONS_BALANCES=true`, once the registration
at Stripe is approved, adds the permission back. Without it a bank account
still funds the wallet and pays for orders; it simply never qualifies for the
pending-ACH advance, since the balance is one of the three facts that requires.
When the permission is granted, the funding method records the Financial
Connections account id, and the balance is read at link time and on
`refreshed_balance` webhooks and appended to
`dropship.dropship_funding_method_balance_verifications`.

## Reversals (phase 4)

A credit that settled can still be taken back: a card chargeback, or an ACH
debit the bank returns after it cleared. Stripe reports both as disputes on the
funding payment intent (`charge.dispute.*`). `domain/funding-reversal.ts`,
applied by the wallet service and repository:

- funds withdrawn (an active dispute, or `funds_withdrawn`) → one
  `funding_reversal` debit per dispute of min(disputed amount, credit), the
  balance allowed negative, the vendor paused in the same transaction with the
  `funding_returned` reason; the daily wallet run collects. An inquiry
  ("warning" statuses) moves nothing until funds are withdrawn, and one that
  closes without a chargeback (`warning_closed`) moves nothing at all.
- dispute won (`funds_reinstated`, or closed as won) → one
  `funding_reinstated` credit of the reversal; the vendor resumes if funded.
- dispute lost → the reversal stands; only the log says so.
- a dispute on a payment the wallet never recorded belongs to another product
  and is ignored.

The card fee charged with a card credit is not the vendor's to lose twice: the
reversal is bounded by what the wallet received, and the fee is written off.

## Vendor-facing (phase 5)

The vendor keeps one number: the **minimum** (`minimum_balance_cents`,
"keep $X"), at least the pack tier and at least the case tier to sell cases.
The minimum step offers exactly those two amounts, as the served policy sets
them (`minimumOptions` in `client/src/lib/dropship-wallet-flow.ts`): nothing
else to type and nothing to guess — the earlier daily-cost guesser and
free-form amount are gone. It opens on the pack minimum, or the case minimum
while the vendor's cases are on sale; a minimum saved before the step was
narrowed opens on the tier it falls in. An optional **top-up amount**
(`top_up_amount_cents`, migration 0690; null pulls the minimum) says how
much each automatic refill pulls, so a vendor who wants fewer pulls takes
bigger ones. The step offers it as quick picks beside the minimum itself —
2×, 3× and 5× the minimum, recomputed whenever the minimum changes so a
"2×" pick follows it (`topUpOptions`) — plus an amount of the vendor's own;
a saved amount that equals a multiple reads as that multiple, any other as
the vendor's own. Adding money — step 6 and the manage view's Add money
panel — offers the same picks again, plus the vendor's own top-up amount
when it is not one of them, within the manual funding limits, and opens on
what autopay would pull next (`depositOptions`, `nextTopUpCents`); the old
fixed presets below the minimum are gone. `domain/autopay-refill.ts`:

- refill (after any order debit and at the daily check, while the balance
  counting pending is under the minimum): pull the top-up amount, or the
  whole shortfall when that is more, never past the single-charge bound
  (a held order's backup-card charge is not a refill: it takes the whole
  gap, up to the policy's manual funding maximum — phase 3, item 3);
- the bound is the server's, max(minimum, top-up amount), derived when the
  client sends none (`max_single_reload_cents` keeps it; an older client's
  own bound is honoured while it covers both amounts). A deep negative is
  collected over several daily runs, never skipped and never unbounded;
- the card shortfall charge at acceptance is unchanged: min(back-to-minimum,
  bound), never less than the gap.

Words on every vendor surface: minimum, top-up amount, autopay, backup card,
bank account or card. Not floor, auto-reload, single top-up limit. The rules
page ("How your wallet works") has six topics quoting only served values:
the two tier minimums, the grace period, the card fee, the advance fee and
cap, the hold time.

Low-balance alert: the daily wallet run's cannot-top-up outcomes (autopay
off, no usable bank account or card, a declined charge) are sent as
`dropship_wallet_low_balance`, once per vendor per day per outcome, in the
words above. A refill the bound cut short is logged (`refillPartial`) and
continues on the next run; nothing more is sent, because autopay is still
working.

## Removing a saved method

A funding method is never deleted: the ledger references it for as long as
the ledger exists. Removal (`DELETE /api/dropship/wallet/funding-methods/:id`,
behind the `remove_funding_method` step-up proof) archives the row, and every
charge path requires `active`, so that alone stops the money. The decision is
the pure rule in `domain/funding-method-removal.ts`, applied under the row
lock of the one transaction that archives (`archiveFundingMethod`):

- **Refused** while the method is the enabled autopay source
  (`DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE`), while a top-up from it is
  still pending (`DROPSHIP_FUNDING_METHOD_HAS_PENDING_FUNDING`), or when it is
  the only card a held order could be charged to and the vendor is active
  (`DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD`) — the card backstop is a launch
  requirement, as `assertAutoReloadMayBeDisabled` already enforces. Each is a
  409; the page shows the reason and re-reads the wallet.
- **Replayed** when the method is already archived: nothing changes and the
  stored provider outcome is reported.
- **Archived** otherwise: `status = 'archived'`, `is_default = false`, the
  member and time in the metadata, and an audit row whose actor is the member.
  No other method is promoted to default; the wallet flow picks the newest
  active method of a rail on its own.

Only after that commit is the payment method detached at Stripe
(`paymentMethods.detach`). The outcome is recorded on the method
(`metadata.providerDetach`) with its own audit row and returned as
`providerDetach`: `detached`, `already_detached` (Stripe no longer had it),
`pending` (Stripe unreachable; the detach is owed), `requires_review` (Stripe
refused; a human reconciles Stripe's side) or `not_applicable` (USDC, manual).
A detach that does not complete never un-archives anything, and nothing
retries it automatically: the archived method is already unchargeable from
our side, so what remains is hygiene an operator finishes from the audit
trail. Re-adding the same bank account or card later goes through the normal
link flow and creates a new Stripe payment method.

## USDC in a Card Shellz wallet (phase 6)

No provider and no fee: Card Shellz holds the USDC itself. The operator
generates a BIP-39 seed offline and puts only the account-level extended
PUBLIC key (BIP-44 for Ethereum, m/44'/60'/0') in `DROPSHIP_USDC_BASE_XPUB`;
the spending key never exists on a server (`infrastructure/usdc-hd-address-deriver.ts`
refuses a private key outright). Migration 0691; the words are in
`docs/DROPSHIP-USDC-CUSTODY-RUNBOOK.md`.

- **Addresses.** Each vendor gets their own address, 0/i under the account
  key, the first time they ask (`POST /api/dropship/wallet/usdc/deposit-address`)
  and the same one forever (`dropship.dropship_usdc_deposit_addresses`: one
  per vendor per chain, one index per key, one address per chain; index
  allocation under an advisory lock). Reading the wallet never assigns one.
- **Watcher** (`application/dropship-usdc-deposit-service.ts`, worker
  `dropship-usdc-watcher-runner.ts`, every 30 s by default). Before any money
  is read the node and token are verified: chain id 8453, `decimals() == 6`,
  `symbol() == "USDC"`. A scan tick reads `Transfer` logs of the USDC contract
  to every vendor address over the next block range and records each one:
  the identity is (chain, transaction, log index), so a batched exchange
  withdrawal credits every vendor in it. A transfer is credited to the
  **pending** balance once it has `minConfirmations` (6) and **settles**
  (pending → available) once its block is at or below the network's `safe`
  head, which is as far as a sequencer reorg can reach; a transfer already at
  or below the safe head is credited settled at once. Whole cents are the
  atomic units divided by 10,000, rounded down; the remainder is **dust**,
  recorded at the address and never credited. A scan stops before any
  transfer it cannot record, so nothing is credited out of order and a
  permanent fault stays visible until a human acts.
- **No cap.** Owner decision: a single USDC deposit has no maximum. The
  watcher credits every transfer above zero in full; the Stripe funding
  range (`assertStripeWalletFundingAmount`,
  `DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS`) is never consulted on this
  path. The one bound is representability: `usdcAtomicUnitsToCents` refuses
  an amount above `Number.MAX_SAFE_INTEGER` cents with
  `DROPSHIP_USDC_DEPOSIT_INVALID`.
- **Settlement tick.** Every pending credit is judged against its receipt:
  settle at the safe head; re-record one re-included in another block; void
  one whose receipt is gone once the chain has moved `voidAfterBlocks` (60)
  past the block it was recorded in (the pending amount leaves the balance
  through the same path a returned bank transfer uses). A voided credit is
  never re-credited by automation; if the transfer comes back, a human credits
  it by hand with the transaction on file.
- **Custody.** Nothing on the server signs or sends. Sweeping vendor addresses
  to the treasury is done with the offline key (runbook). The admin custody
  report (`GET /api/dropship/admin/wallet/usdc/custody`) compares every
  address's on-chain USDC balance with what the ledger expects there before
  any sweep and alerts on funds the watcher never credited; it also shows the
  key fingerprint and the index-0 address the operator verifies against
  their own wallet once.
- **Manual credit** stays as the fallback for a transfer the watcher did not
  see, hardened: the dollar amount must equal the USDC amount in whole cents,
  the transfer must have gone to the vendor's own address or the shared one,
  and one transfer of a batch is named by its log index, which dedupes against
  the watcher.
- **Vendor words.** The wallet shows the vendor's own address, the timing the
  watcher enforces (confirmations to show, the safe head to settle) and one
  warning: only USDC on the Base network; anything else sent there cannot be
  recovered. The vendor is told when a deposit lands and if one is voided.

Phases 1 to 6 are delivered. Phase 7 below records the pricing and rewards
decisions of 2026-09-23 ahead of their build; a USDC autopay pull from a
self-custody wallet is still not designed here.

## Pricing and rewards (phase 7)

Owner decisions of 2026-09-23. They replace the card fee described under
"Sources" and in phase 5; the sections above stay as the record of what
shipped.

**Pricing.** No processing fee on any rail. A vendor already pays their
marketplace's fees, and a second fee on top made every money screen harder
to read. Card transfers are free but never below a card minimum deposit
($100 at launch); bank and USDC keep the general minimum. The card fee stays
a setting held at zero, so the disclosure machinery (the acknowledgement in
the mandate, the fee on every quote) keeps working should a fee ever return.
The fee and the per-rail minimum deposits become editable on the admin
Wallet Policy tab; today the fee is an environment variable shown there
read-only.

**Rewards.** In place of a fee on card, an incentive on the free rails: every
bank or USDC transfer earns rewards at a per-rail rate (1% at launch, card
0%), credited when the transfer settles. Deposits and automatic top-ups
alike, so the rule reads "bank and USDC earn 1%". Rewards are earned on
transfers rather than on orders because that is the only way "card earns
nothing" can be true: once money is in the wallet it is all the same money.

Rewards are a third balance on the wallet account, integer cents, with their
own ledger lines (earned, spent, reversed, reinstated, and since migration
0705 expired). They are money Card Shellz issues, so:

- spend-only: never paid out, and left out of any refund on account closure;
- never counted toward the minimum, the credit allowance or a top-up trigger,
  and never treated as cash by the treasury reconciliation;
- a returned or disputed transfer takes back the rewards it earned; a part
  already spent comes out of the cash balance through the existing reversal;
- a cancelled or refunded order returns its rewards share to rewards, not to
  cash;
- the rate setting has a ceiling, so a typo cannot pay out 100%;
- no expiry at launch; staff can set one (built in migration 0705).

**Spending.** Rewards are points, 100 per dollar (one per cent, so the
stored cents are the points), and their only use is lower product cost on
.ops orders: an order debit takes points first and cash second, and the
order shows both parts. That happens only once the vendor chooses to
auto-apply their points; until they choose, the points are saved up.
Auto-apply is never a default (owner decision of 2026-09-24, which also
dropped the earlier idea of redeeming points as store coupon codes: points
never leave the wallet). Points get an expiry set by staff, with "never" as
an option (never at launch; built in migration 0705). They never touch the
Shellz Club points ledger.

**Separation from Shellz Club rewards.** The two programs never pool. A .ops
member still earns Shellz Club rewards on retail purchases, and those can
never be spent on .ops orders or product cost; wallet rewards never become
Shellz Club points. Each balance is spent only in the system that owns it,
so no order ever depends on a two-system transaction.

**Built with this phase:** the held-order backup-card charge covers the
whole shortfall, up to the policy's manual funding maximum in one payment
(the single-charge bound now shapes routine top-ups only, and every vendor
surface says so); the add-money step no longer describes autopay, shows the
balance as its own element, and states the picked rail's terms as short
bullets (`describeDepositRail`: fee, landing time, the credit rule from the
account's three facts, and the backup card while a transfer lands), with
"Skip for now" and no Back. The card fee (held at zero) and the card minimum
deposit ($100) are wallet-policy limits staff edit on the Wallet Policy tab
(migration 0701; the environment variable is only the fee's fallback). The
rate a vendor acknowledged is stored on their settings row, backfilled from
the audit trail; an unattended card charge never carries more than it, an
agreement at or above the live rate is current, and a fee cut applies at
once. A card deposit is held to the card minimum on the server and in the
add-money controls, and every vendor surface reads "no fee" at zero.
The rewards money paths (migration 0702): the wallet account carries a
third, spend-only `rewards_balance_cents` (never negative) and every ledger
line snapshots it; a settled bank or USDC credit earns rewards in the
settlement's own transaction, at the per-rail rate read on the same client
from the policy in force (`rewards_rate_bank_bps`, `rewards_rate_usdc_bps`,
`rewards_rate_card_bps`: 1%, 1%, 0% at launch, each under a 10% ceiling,
editable on the Wallet Policy tab), rounded down, once per credit
(`rewards_earned`); a manual staff credit earns nothing. Each order debit
takes rewards first and cash second (`rewards_spent`, then `order_debit` for
what cash still owes; an order rewards pay in full posts no cash row and is
never refused for a negative cash balance), unless the vendor saved their
rewards (`spend_rewards_first` on their settings row,
`PUT /api/dropship/wallet/rewards/preference`); a hold and the card backstop
are sized on the cash the order still needs. A dispute takes the credit's
rewards back pro rata: what is still in the balance leaves it
(`rewards_reversed`), the part already spent comes out of cash through the
same `funding_reversal` row; a won dispute gives both back
(`rewards_reinstated`). The vendor surface: the rewards balance is its own
figure under the cash balance, in points with the dollar value beside, with
a line saying what the vendor's choice is doing or that none is made; the
choice is the page's radio pair ("Auto-apply to orders" / "Save them up",
`PUT /api/dropship/wallet/rewards/preference`, no step-up: a preference,
not a charge), and neither option is selected until the vendor chooses
(migration 0704 made `spend_rewards_first` nullable with no default; NULL
reads as saved everywhere, and rows that carried the old default without a
recorded choice were reset); the rules page states the rule from the served
rates ("bank and USDC transfers earn 1% in rewards points when they land; a
card charge earns none", the 100-points-per-dollar sentence, points used
only on orders and only once auto-apply is chosen, USDC named only where
offered, nothing said while every rate is zero); the add-money bullets and
the USDC panel say what the picked rail earns and when; an activity row
that moved points shows its amount and its points balance after in points;
and an order shows both parts of its payment (the order detail serves the
`rewards_spent` row beside the `order_debit` row, a hold serves the points
share its event recorded, and the accept response carries `rewardsCents`).
The points expiry (migration 0705): staff set on the Wallet Policy tab how
many days after they are earned unused points expire, from 1 to 3,650, or
blank for never, the launch setting (`rewards_expiry_days`). Each earning is
a lot (`dropship_wallet_rewards_lots`) whose expiry date is fixed when it is
earned, so a change applies to points earned after it. The rewards balance
stays the money authority and the lots index it: every rewards writer moves
both in one transaction under the wallet account row lock, and every
movement in or out of a lot is recorded against the ledger row that caused
it (`dropship_wallet_rewards_lot_movements`, append-only). Points leave lots
soonest-expiring first, never-expiring last, oldest first among equals. A
clawback takes from the disputed credit's own lot first, and a won dispute
puts the points back into the lots they came from, keeping their dates: a
lot whose date passed in the meantime expires at the next wallet run. There
is no backfill. The first writer to touch an account opens its first lot for
the points it already holds, never expiring. A later mismatch between the
lots and the balance (the previous release while this one deploys, or a
defect) is corrected with a warning audit row: in the vendor's favour when
the lots hold too few points (a never-expiring lot), in use order when they
hold too many. The hourly maintenance run expires what is left of each lot
past its date as a `rewards_expired` line, one per lot, referenced by the
lot and how many times it has expired. The wallet page names the soonest
points to expire under the points figure; the rules page states the setting
for new points. No email is sent when points expire. The `rewards_redeemed`
kind, which never had a writer, left the ledger vocabulary in the same
migration, which stops rather than proceeds if a row carrying it exists.
Not built yet: the points share of a return credit, and the admin order view
of the split.

**Still open, not designed here:** credit against a business account's first
bank transfer (today one earlier transfer from the account must have
settled), and a USDC pull contract for automatic top-ups from a
self-custody wallet.
