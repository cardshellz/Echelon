BEGIN;
-- No historical quantities or financial records are inferred or corrected here.
ALTER TABLE oms.oms_order_lines
  ADD COLUMN channel_current_quantity integer,
  ADD COLUMN channel_quantity_updated_at timestamptz,
  ADD CONSTRAINT oms_line_channel_quantity_valid CHECK (
    (channel_current_quantity IS NULL AND channel_quantity_updated_at IS NULL)
    OR (channel_current_quantity IS NOT NULL AND channel_current_quantity >= 0 AND channel_quantity_updated_at IS NOT NULL
      AND channel_current_quantity <= GREATEST(quantity, channel_observed_quantity, paid_quantity))
  );
ALTER TABLE oms.oms_order_line_authority_events
  ADD COLUMN previous_channel_current_quantity integer CHECK (previous_channel_current_quantity >= 0),
  ADD COLUMN channel_current_quantity integer CHECK (channel_current_quantity >= 0),
  ADD COLUMN channel_quantity_updated_at timestamptz;
-- A failed reservation leg retries this saved physical demand delta, rather
-- than deriving a new inventory release from a financial refund's amount.
ALTER TABLE oms.order_line_adjustments
  ADD COLUMN merchandise_reduction_quantity integer CHECK (merchandise_reduction_quantity >= 0);
CREATE FUNCTION oms.protect_refund_merchandise_reduction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.merchandise_reduction_quantity IS NOT NULL
    AND NEW.merchandise_reduction_quantity IS DISTINCT FROM OLD.merchandise_reduction_quantity THEN
    RAISE EXCEPTION 'A recorded merchandise reduction is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refund_merchandise_reduction_immutable BEFORE UPDATE ON oms.order_line_adjustments
  FOR EACH ROW EXECUTE FUNCTION oms.protect_refund_merchandise_reduction();
COMMIT;
