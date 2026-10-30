-- New explicit label requests only. Existing returns are not automatically
-- enrolled or retried by this migration.
CREATE TABLE returns.customer_return_workflows (
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  request_key uuid NOT NULL,
  oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id),
  request_snapshot jsonb NOT NULL CHECK(jsonb_typeof(request_snapshot)='object'),
  scope_snapshot jsonb NOT NULL CHECK(jsonb_typeof(scope_snapshot)='object'),
  semantic_hash varchar(64) NOT NULL CHECK(semantic_hash ~ '^[a-f0-9]{64}$'),
  actor varchar(255) NOT NULL CHECK(btrim(actor)<>''),
  phase varchar(24) NOT NULL CHECK(phase IN ('queued','preparing','labels','ready','retryable_failure','needs_input','needs_help')),
  reason varchar(64),
  authorization_id bigint UNIQUE REFERENCES returns.customer_return_authorizations(id),
  failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 6),
  explicit_retry boolean NOT NULL DEFAULT false,
  next_run_at timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(channel_id,request_key),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK(phase NOT IN ('labels','ready') OR authorization_id IS NOT NULL),
  CHECK(phase<>'needs_input' OR authorization_id IS NULL),
  CHECK((phase IN ('queued','preparing','labels','ready'))=(reason IS NULL)),
  CHECK(reason IS NULL OR reason IN ('RETURN_DETAILS_CHANGED','RETURN_SHIPPING_UNAVAILABLE',
    'RETURN_LABEL_RECONCILIATION_REQUIRED','RETURN_WORKFLOW_TEMPORARY_FAILURE','RETURN_WORKFLOW_NEEDS_HELP'))
);
CREATE INDEX customer_return_workflows_due ON returns.customer_return_workflows(next_run_at,created_at)
  WHERE phase IN ('queued','preparing','labels');
CREATE TABLE returns.customer_return_workflow_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL,
  request_key uuid NOT NULL,
  actor varchar(255) NOT NULL,
  from_phase varchar(24),
  to_phase varchar(24) NOT NULL,
  error_code varchar(100),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY(channel_id,request_key) REFERENCES returns.customer_return_workflows(channel_id,request_key)
);
CREATE TRIGGER customer_return_workflow_events_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_workflow_events
  FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();
CREATE FUNCTION returns.guard_customer_return_workflow_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Return workflow intent is retained' USING ERRCODE='23514'; END IF;
  IF (NEW.channel_id,NEW.request_key,NEW.oms_order_id,NEW.request_snapshot,NEW.scope_snapshot,NEW.semantic_hash,NEW.actor,NEW.created_at)
    IS DISTINCT FROM (OLD.channel_id,OLD.request_key,OLD.oms_order_id,OLD.request_snapshot,OLD.scope_snapshot,OLD.semantic_hash,OLD.actor,OLD.created_at)
    OR (OLD.authorization_id IS NOT NULL AND NEW.authorization_id IS DISTINCT FROM OLD.authorization_id) THEN
    RAISE EXCEPTION 'Return workflow identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_workflow_identity BEFORE UPDATE OR DELETE ON returns.customer_return_workflows
  FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_workflow_identity();
