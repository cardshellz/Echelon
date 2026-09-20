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
- **USDC** — one-off; phase 6 moves it to a wallet Card Shellz controls.

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
   migration 0686), posted in the same transaction as the order debit and
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

Balance verification: the ACH setup session asks for the `balances`
permission; the funding method records the Financial Connections account id;
the balance is read at link time and on `refreshed_balance` webhooks and
appended to `dropship.dropship_funding_method_balance_verifications`.

## Remaining phases

4. Reversals — dispute and ACH-return webhooks: debit, pause, collect.
5. Vendor-facing — "keep $X" as the one setting, optional top-up amount, new
   words, rules page rewrite, low-balance alert.
6. USDC in a Card Shellz wallet — addresses, chain watcher, custody.
