-- Add quantity-based product exception pricing without overloading weight
-- fields. Existing rules remain unchanged because the new amount is nullable.

ALTER TABLE shipping.rate_rules
  ADD COLUMN per_additional_unit_cents bigint;

ALTER TABLE shipping.rate_rules
  DROP CONSTRAINT IF EXISTS shipping_rate_rule_action_chk,
  DROP CONSTRAINT IF EXISTS shipping_rate_rule_money_chk;

ALTER TABLE shipping.rate_rules
  ADD CONSTRAINT shipping_rate_rule_action_chk
    CHECK (
      action IN (
        'block',
        'free',
        'fixed',
        'fixed_band',
        'base_plus_per_started_pound',
        'base_plus_per_additional_unit',
        'surcharge',
        'free_threshold'
      )
    ),
  ADD CONSTRAINT shipping_rate_rule_money_chk CHECK (
    (rate_cents IS NULL OR rate_cents >= 0)
    AND (per_started_pound_cents IS NULL OR per_started_pound_cents >= 0)
    AND (per_additional_unit_cents IS NULL OR per_additional_unit_cents >= 0)
    AND (threshold_cents IS NULL OR threshold_cents >= 0)
  ),
  ADD CONSTRAINT shipping_rate_rule_additional_unit_chk CHECK (
    (
      action = 'base_plus_per_additional_unit'
      AND rate_cents IS NOT NULL
      AND per_additional_unit_cents IS NOT NULL
      AND measurement_scope = 'matched_items'
      AND per_started_pound_cents IS NULL
      AND threshold_cents IS NULL
    )
    OR (
      action <> 'base_plus_per_additional_unit'
      AND per_additional_unit_cents IS NULL
    )
  );
