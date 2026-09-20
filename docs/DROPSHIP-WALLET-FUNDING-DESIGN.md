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

Balance verification: the ACH setup session asks for the `balances`
permission; the funding method records the Financial Connections account id;
the balance is read at link time and on `refreshed_balance` webhooks and
appended to `dropship.dropship_funding_method_balance_verifications`.

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
An optional **top-up amount** (`top_up_amount_cents`, migration 0690; null
pulls the minimum) says how much each automatic refill pulls, so a vendor
who wants fewer pulls takes bigger ones. `domain/autopay-refill.ts`:

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

## Remaining phases

6. USDC in a Card Shellz wallet — addresses, chain watcher, custody.
