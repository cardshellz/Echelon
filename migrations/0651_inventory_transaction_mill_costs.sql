ALTER TABLE inventory.inventory_transactions
  ADD COLUMN IF NOT EXISTS unit_cost_mills bigint,
  ADD COLUMN IF NOT EXISTS total_cost_mills bigint;

ALTER TABLE inventory.inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_unit_cost_mills_nonnegative,
  ADD CONSTRAINT inventory_transactions_unit_cost_mills_nonnegative
    CHECK (unit_cost_mills IS NULL OR unit_cost_mills >= 0),
  DROP CONSTRAINT IF EXISTS inventory_transactions_total_cost_mills_nonnegative,
  ADD CONSTRAINT inventory_transactions_total_cost_mills_nonnegative
    CHECK (total_cost_mills IS NULL OR total_cost_mills >= 0);

COMMENT ON COLUMN inventory.inventory_transactions.unit_cost_mills IS
  'Exact unit cost in 1/100 cent for immutable inventory movement audit evidence.';

COMMENT ON COLUMN inventory.inventory_transactions.total_cost_mills IS
  'Exact absolute extended cost in 1/100 cent for immutable inventory movement audit evidence.';
