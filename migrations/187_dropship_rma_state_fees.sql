-- Dropship RMA state machine + fee engine (B2, stack 2/4).
-- Spec: dropship-returns-design-spec.md (D4 state machine, D2 fee matrix,
--       D5 netting + negative balance) + dropship-returns-build-spec.md.
--
-- 1. Every RMA status transition is audited with the policy version that
--    governed the RMA (D4 + D-governing). The RMA row already carries
--    policy_version_id (migration 186); the transition audit rows now record
--    it too so the deciding policy version is visible on the transition
--    history itself.

ALTER TABLE dropship.dropship_rma_status_updates
  ADD COLUMN IF NOT EXISTS policy_version_id integer
    REFERENCES dropship.dropship_return_policies(id) ON DELETE SET NULL;

-- 2. Backfill: existing transition rows inherit the RMA's current policy
--    version (pre-enforcement rows may have NULL — that is accurate: they
--    predate policy versioning).

UPDATE dropship.dropship_rma_status_updates su
SET policy_version_id = r.policy_version_id
FROM dropship.dropship_rmas r
WHERE su.rma_id = r.id
  AND su.policy_version_id IS NULL
  AND r.policy_version_id IS NOT NULL;

-- 3. No-ship timeout knob (D4): requested -> closed when the return never
--    ships. Default 14 days, policy-configurable on the versioned B1 policy
--    row. Existing rows keep the default.

ALTER TABLE dropship.dropship_return_policies
  ADD COLUMN IF NOT EXISTS no_ship_timeout_days integer NOT NULL DEFAULT 14;

ALTER TABLE dropship.dropship_return_policies
  DROP CONSTRAINT IF EXISTS dropship_return_policies_no_ship_chk;
ALTER TABLE dropship.dropship_return_policies
  ADD CONSTRAINT dropship_return_policies_no_ship_chk
    CHECK (no_ship_timeout_days > 0 AND no_ship_timeout_days <= 365);

-- 4. Negative wallet balances are ALLOWED (D5). The return-fee path no longer
--    hard-fails on insufficient funds; fees net against the same-RMA credit
--    first and any remainder rides the wallet ledger as a negative balance
--    (the wallet ledger IS the receivable). No schema change is required for
--    this — dropship_wallet_accounts.available_balance_cents has no
--    non-negativity constraint. This comment records the decision so future
--    migrations do not add one.
COMMENT ON COLUMN dropship.dropship_wallet_accounts.available_balance_cents IS
  'Signed balance. Negative balances are allowed (design spec D5): return fees net against same-RMA credit first and any remainder rides as a negative balance for the scheduled collection sweep. Do NOT add a non-negativity constraint.';
