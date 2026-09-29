-- New customer commands bind the canonical order before any provider call or
-- lease replay. Historical/staff commands remain null and are not customer grants.
ALTER TABLE returns.customer_return_submission_commands
  ADD COLUMN oms_order_id BIGINT REFERENCES oms.oms_orders(id);

CREATE FUNCTION returns.guard_customer_return_submission_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.oms_order_id IS DISTINCT FROM OLD.oms_order_id THEN
    RAISE EXCEPTION 'Return submission canonical order is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.oms_order_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM oms.oms_orders o
      WHERE o.id = NEW.oms_order_id AND o.channel_id = NEW.channel_id
    ) THEN
      RAISE EXCEPTION 'Return submission source channel does not match its OMS order' USING ERRCODE = '23514';
    END IF;
    IF NEW.authorization_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM returns.customer_return_authorizations a
      WHERE a.id = NEW.authorization_id AND a.channel_id = NEW.channel_id
        AND a.oms_order_id = NEW.oms_order_id
    ) THEN
      RAISE EXCEPTION 'Return submission authorization does not match its OMS order' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_return_submission_order_guard
  BEFORE INSERT OR UPDATE ON returns.customer_return_submission_commands
  FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_submission_order();
