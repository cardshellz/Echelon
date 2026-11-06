-- A provider acknowledgement and a final provider result are different facts.
-- Historical events do not contain this evidence and remain unclassified.
ALTER TABLE marketplace.listing_member_retirements
  ADD COLUMN dispatch_finality text CHECK (
    dispatch_finality IS NULL OR
    (dispatch_status = 'accepted' AND dispatch_finality IN ('pending', 'terminal'))
  );

-- Older binaries do not know this column. Never carry a final receipt from one
-- dispatch key to another during a rolling deployment or recovery transition.
CREATE FUNCTION marketplace.reset_listing_member_dispatch_finality() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.dispatch_status, NEW.dispatch_key) IS DISTINCT FROM (OLD.dispatch_status, OLD.dispatch_key)
    AND NEW.dispatch_finality IS NOT DISTINCT FROM OLD.dispatch_finality THEN
    NEW.dispatch_finality := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listing_member_dispatch_finality_reset BEFORE UPDATE ON marketplace.listing_member_retirements
  FOR EACH ROW EXECUTE FUNCTION marketplace.reset_listing_member_dispatch_finality();
