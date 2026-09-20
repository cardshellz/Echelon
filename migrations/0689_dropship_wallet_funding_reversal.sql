-- Dropship wallet funding design, phase 4: reversals.
--
-- A funding credit that already settled can still be taken back: a card
-- chargeback, or an ACH debit the bank returns after it cleared. Stripe reports
-- both as disputes on the payment intent. The wallet answers with two ledger
-- kinds (server/modules/dropship/domain/funding-reversal.ts):
--
--   funding_reversal    a debit of the disputed amount, never more than the
--                       credit, posted when the funds are withdrawn; the
--                       balance may go negative (allowed since migration 191)
--                       and the vendor is paused in the same transaction;
--   funding_reinstated  the matching credit when the dispute is won and the
--                       funds come back.
--
-- One row per dispute for each kind: the ledger's unique reference index keeps
-- a replayed webhook from posting twice. The list otherwise matches 0688.
ALTER TABLE dropship.dropship_wallet_ledger
  DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk;
ALTER TABLE dropship.dropship_wallet_ledger
  ADD CONSTRAINT dropship_wallet_ledger_type_chk
    CHECK (type IN (
      'funding',
      'order_debit',
      'refund_credit',
      'return_credit',
      'return_fee',
      'insurance_pool_credit',
      'manual_adjustment',
      'advance_fee',
      'funding_reversal',
      'funding_reinstated'
    ));

COMMENT ON CONSTRAINT dropship_wallet_ledger_type_chk ON dropship.dropship_wallet_ledger IS
  'Ledger kinds. funding_reversal / funding_reinstated (migration 0689) record a settled credit taken back by a dispute or ACH return, and its return when the dispute is won.';
