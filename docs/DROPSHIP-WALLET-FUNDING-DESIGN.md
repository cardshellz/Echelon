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
3. **Card backstop** — the order-processing pass charges the card for
   `min(back-to-minimum, single top-up limit)`, never less than the gap; when
   even the limit cannot cover the gap nothing is charged and the order waits.
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
bigger ones. `domain/autopay-refill.ts`:

- refill (after any order debit and at the daily check, while the balance
  counting pending is under the minimum): pull the top-up amount, or the
  whole shortfall when that is more, never past the single-charge bound;
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

All six phases of the funding design are delivered; later work (a USDC
autopay pull from a self-custody wallet) is not designed here.
