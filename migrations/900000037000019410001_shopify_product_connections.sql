-- Product-scoped external commands. Intent survives process loss independently
-- of local mapping transactions; a request with an unknown remote outcome must
-- be recovered by evidence, never by another blind product-create request.
CREATE TABLE catalog.shopify_product_connection_commands (
  command_key uuid PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog.products(id),
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  connection_id integer NOT NULL,
  shop_domain text NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  preview_hash text NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CHECK (mode IN ('create','link')),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  review_evidence jsonb NOT NULL CHECK (jsonb_typeof(review_evidence)='object'),
  create_spec jsonb CHECK (create_spec IS NULL OR jsonb_typeof(create_spec)='object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','creating','configuring','mapping','publishing','complete','review','rejected')),
  create_requested boolean NOT NULL DEFAULT false,
  remote_product_id text CHECK (remote_product_id IS NULL OR remote_product_id ~ '^[1-9][0-9]*$'),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  retryable boolean NOT NULL DEFAULT true,
  resume_attempt_count integer NOT NULL DEFAULT 0 CHECK (resume_attempt_count>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  FOREIGN KEY(connection_id,channel_id) REFERENCES channels.channel_connections(id,channel_id),
  CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((state IN ('complete','rejected'))=(completed_at IS NOT NULL)),
  CHECK (state<>'complete' OR (remote_product_id IS NOT NULL AND result IS NOT NULL)),
  CHECK (mode='create' OR (create_spec IS NULL AND create_requested=false))
  ,CHECK (request->>'mode'=mode AND request->>'channelId'=channel_id::text)
  ,CHECK (source_snapshot#>>'{product,id}'=product_id::text AND source_snapshot#>>'{channel,id}'=channel_id::text
    AND source_snapshot#>>'{channel,connectionId}'=connection_id::text AND source_snapshot#>>'{channel,shopDomain}'=shop_domain)
  ,CHECK ((mode='create')=(create_spec IS NOT NULL))
);
CREATE UNIQUE INDEX shopify_product_connection_active_owner
  ON catalog.shopify_product_connection_commands(channel_id,product_id)
  WHERE state NOT IN ('complete','rejected');
CREATE INDEX shopify_product_connection_due
  ON catalog.shopify_product_connection_commands(next_attempt_at)
  WHERE state NOT IN ('complete','rejected') AND retryable;

CREATE TABLE catalog.shopify_product_connection_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_key uuid NOT NULL REFERENCES catalog.shopify_product_connection_commands(command_key),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 100),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX shopify_product_connection_event_history
  ON catalog.shopify_product_connection_events(command_key,id);

CREATE FUNCTION catalog.guard_shopify_product_connection_command()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'SHOPIFY_CONNECTION_RECEIPT_IMMUTABLE'; END IF;
  IF OLD.state IN ('complete','rejected') THEN RAISE EXCEPTION 'SHOPIFY_CONNECTION_TERMINAL_IMMUTABLE'; END IF;
  IF ROW(NEW.command_key,NEW.product_id,NEW.channel_id,NEW.connection_id,NEW.shop_domain,
      NEW.actor,NEW.request_hash,NEW.preview_hash,NEW.mode,NEW.request,NEW.source_snapshot,NEW.review_evidence,NEW.create_spec,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.command_key,OLD.product_id,OLD.channel_id,OLD.connection_id,OLD.shop_domain,
      OLD.actor,OLD.request_hash,OLD.preview_hash,OLD.mode,OLD.request,OLD.source_snapshot,OLD.review_evidence,OLD.create_spec,OLD.created_at)
    THEN RAISE EXCEPTION 'SHOPIFY_CONNECTION_INTENT_IMMUTABLE'; END IF;
  IF OLD.create_requested AND NOT NEW.create_requested THEN RAISE EXCEPTION 'SHOPIFY_CONNECTION_CREATE_EVIDENCE_IMMUTABLE'; END IF;
  IF OLD.remote_product_id IS NOT NULL AND NEW.remote_product_id IS DISTINCT FROM OLD.remote_product_id
    THEN RAISE EXCEPTION 'SHOPIFY_CONNECTION_REMOTE_ID_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shopify_product_connection_command_guard BEFORE UPDATE OR DELETE
  ON catalog.shopify_product_connection_commands FOR EACH ROW
  EXECUTE FUNCTION catalog.guard_shopify_product_connection_command();
CREATE FUNCTION catalog.guard_shopify_product_connection_history()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'SHOPIFY_CONNECTION_HISTORY_IMMUTABLE'; END;
$$;
CREATE TRIGGER shopify_product_connection_no_truncate BEFORE TRUNCATE
  ON catalog.shopify_product_connection_commands FOR EACH STATEMENT
  EXECUTE FUNCTION catalog.guard_shopify_product_connection_history();
CREATE TRIGGER shopify_product_connection_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON catalog.shopify_product_connection_events FOR EACH STATEMENT
  EXECUTE FUNCTION catalog.guard_shopify_product_connection_history();
