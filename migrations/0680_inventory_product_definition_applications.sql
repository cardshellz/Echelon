BEGIN;

-- Routine post-cutover definition changes have their own immutable receipts.
-- This migration does not select a model, activate ATP or enqueue publication.
CREATE TABLE inventory.product_definition_applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog.products(id),
  model_id integer NOT NULL REFERENCES inventory.transformation_model_versions(id),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  occurred_at timestamptz NOT NULL,
  review jsonb NOT NULL CHECK (jsonb_typeof(review)='object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  CHECK (receipt ? 'productId' AND receipt ? 'modelId'
    AND (receipt->>'productId') IS NOT NULL AND (receipt->>'modelId') IS NOT NULL
    AND (receipt->>'productId')::integer=product_id AND (receipt->>'modelId')::integer=model_id)
);
CREATE INDEX product_definition_applications_product_idx ON inventory.product_definition_applications(product_id,id DESC);
CREATE FUNCTION inventory.guard_product_definition_application() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Product definition receipts are immutable' USING ERRCODE='55000';
  END IF;
  PERFORM inventory.assert_cutover_admission_fence_owner();
  IF NOT EXISTS (
    SELECT 1 FROM inventory.transformation_model_heads head
    JOIN inventory.transformation_model_versions model ON model.id=head.active_model_id
    WHERE head.product_id=NEW.product_id AND model.product_id=NEW.product_id
      AND model.id=NEW.model_id AND model.lifecycle_status='sealed'
  ) THEN
    RAISE EXCEPTION 'Receipt must identify the active sealed product model' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_definition_application_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.product_definition_applications
FOR EACH ROW EXECUTE FUNCTION inventory.guard_product_definition_application();
CREATE TRIGGER product_definition_application_no_truncate
BEFORE TRUNCATE ON inventory.product_definition_applications
FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_product_definition_application();

CREATE TABLE inventory.safety_definition_applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_key text NOT NULL REFERENCES inventory.promise_safety_policy_heads(scope_key),
  policy_id integer NOT NULL REFERENCES inventory.promise_safety_policy_versions(id),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  occurred_at timestamptz NOT NULL,
  review jsonb NOT NULL CHECK (jsonb_typeof(review)='object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  CHECK (receipt ? 'scopeKey' AND receipt ? 'policyId'
    AND (receipt->>'scopeKey') IS NOT NULL AND (receipt->>'policyId') IS NOT NULL
    AND receipt->>'scopeKey'=scope_key AND (receipt->>'policyId')::integer=policy_id)
);
CREATE INDEX safety_definition_applications_scope_idx ON inventory.safety_definition_applications(scope_key,id DESC);
CREATE FUNCTION inventory.guard_safety_definition_application() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Safety definition receipts are immutable' USING ERRCODE='55000'; END IF;
  PERFORM inventory.assert_cutover_admission_fence_owner();
  IF NOT EXISTS (
    SELECT 1 FROM inventory.promise_safety_policy_heads head
    JOIN inventory.promise_safety_policy_versions policy ON policy.id=head.active_policy_id
    WHERE head.scope_key=NEW.scope_key AND policy.scope_key=NEW.scope_key
      AND policy.id=NEW.policy_id AND policy.lifecycle_status='sealed'
  ) THEN RAISE EXCEPTION 'Receipt must identify the active sealed safety policy' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER safety_definition_application_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory.safety_definition_applications
FOR EACH ROW EXECUTE FUNCTION inventory.guard_safety_definition_application();
CREATE TRIGGER safety_definition_application_no_truncate BEFORE TRUNCATE ON inventory.safety_definition_applications
FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_safety_definition_application();

COMMIT;
