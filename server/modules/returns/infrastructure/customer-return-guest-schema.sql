-- Allocate this forward-only schema through create-migration.mjs once the PR
-- number exists. Integration tests install this same SQL in a disposable DB.
CREATE TABLE returns.customer_return_guest_challenges (
  id uuid PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES channels.channels(id),
  browser_hash text NOT NULL CHECK (length(browser_hash)=43),
  input_hash text NOT NULL CHECK (length(input_hash)=43),
  email_hash text NOT NULL CHECK (length(email_hash)=43),
  oms_order_id bigint REFERENCES oms.oms_orders(id),
  purchase jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  verified_at timestamptz,
  revoked_at timestamptz,
  delivery_token uuid,
  delivery_until timestamptz,
  next_delivery_at timestamptz NOT NULL,
  account_result text,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '10 minutes'),
  CHECK (verified_at IS NULL OR (verified_at >= created_at AND verified_at < expires_at)),
  CHECK ((delivery_token IS NULL) = (delivery_until IS NULL)),
  CHECK ((purchase IS NULL) = (oms_order_id IS NULL)),
  CHECK (purchase IS NULL OR (jsonb_typeof(purchase)='object'
    AND (purchase->>'channelId')::bigint=channel_id AND (purchase->>'omsOrderId')::bigint=oms_order_id))
);
CREATE INDEX customer_return_guest_email_limit ON returns.customer_return_guest_challenges(channel_id,email_hash,created_at);
CREATE INDEX customer_return_guest_browser_limit ON returns.customer_return_guest_challenges(channel_id,browser_hash,created_at);
CREATE INDEX customer_return_guest_expiry ON returns.customer_return_guest_challenges(expires_at);
CREATE TABLE returns.customer_return_guest_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES returns.customer_return_guest_challenges(id),
  action text NOT NULL CHECK (action IN ('created','email_sent','email_uncertain','verified','code_rejected','account_link','signed_out')),
  occurred_at timestamptz NOT NULL
);
CREATE TRIGGER customer_return_guest_events_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_guest_events
  FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();
CREATE FUNCTION returns.guard_customer_return_guest_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.channel_id,NEW.browser_hash,NEW.input_hash,NEW.email_hash,NEW.oms_order_id,NEW.purchase,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.channel_id,OLD.browser_hash,OLD.input_hash,OLD.email_hash,OLD.oms_order_id,OLD.purchase,OLD.created_at,OLD.expires_at)
    OR NEW.attempts < OLD.attempts
    OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Guest verification identity cannot change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_guest_identity BEFORE UPDATE ON returns.customer_return_guest_challenges
  FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_guest_identity();
