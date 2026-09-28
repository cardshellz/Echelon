-- Reviewed initial membership only; deploying this migration changes no target.
-- Normal canonical/live membership and new-Walmart defaults remain unchanged.
CREATE TABLE inventory.publication_initial_scope_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id integer NOT NULL UNIQUE REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  previous_revision bigint NOT NULL CHECK (previous_revision > 0),
  authority_revision bigint NOT NULL CHECK (authority_revision > 0),
  idempotency_key varchar(120) NOT NULL UNIQUE CHECK (idempotency_key=btrim(idempotency_key) AND idempotency_key<>''),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  review_hash varchar(64) NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  actor varchar(100) NOT NULL CHECK (actor=btrim(actor) AND actor<>''),
  occurred_at timestamptz NOT NULL,
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  included_variant_ids integer[] NOT NULL CHECK (array_position(included_variant_ids,NULL) IS NULL),
  excluded_variant_ids integer[] NOT NULL DEFAULT '{}' CHECK (array_position(excluded_variant_ids,NULL) IS NULL),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object')
);
CREATE TRIGGER publication_initial_scope_receipts_immutable
BEFORE UPDATE OR DELETE ON inventory.publication_initial_scope_receipts
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE TRIGGER publication_initial_scope_receipts_no_truncate
BEFORE TRUNCATE ON inventory.publication_initial_scope_receipts
FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_publication_membership_evidence();

CREATE FUNCTION inventory.guard_initial_publication_scope_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE expected_ids integer[]; expected_excluded_ids integer[];
BEGIN
  PERFORM inventory.assert_cutover_admission_fence_owner();
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value),'{}'::integer[]) INTO expected_ids
    FROM unnest(NEW.included_variant_ids) AS item(value);
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value),'{}'::integer[]) INTO expected_excluded_ids
    FROM unnest(NEW.excluded_variant_ids) AS item(value);
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NEW.included_variant_ids IS DISTINCT FROM expected_ids
    OR NEW.excluded_variant_ids IS DISTINCT FROM expected_excluded_ids
    OR NEW.included_variant_ids && NEW.excluded_variant_ids
    OR EXISTS(SELECT 1 FROM unnest(expected_ids) AS item(value) WHERE value<=0)
    OR EXISTS(SELECT 1 FROM unnest(expected_excluded_ids) AS item(value) WHERE value<=0)
    OR NOT EXISTS(SELECT 1 FROM inventory.availability_runtime_authority
      WHERE singleton_key=true AND authority='legacy' AND activation_run_id IS NULL AND revision=NEW.authority_revision)
    OR EXISTS(SELECT 1 FROM inventory.availability_activation_freezes WHERE released_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM inventory.inventory_publication_targets WHERE id=NEW.publication_target_id
      AND revision=NEW.previous_revision AND state='preview' AND publication_authority='echelon' AND membership_mode='whole_product')
    OR EXISTS(SELECT 1 FROM inventory.publication_membership_heads WHERE publication_target_id=NEW.publication_target_id)
    OR EXISTS(SELECT 1 FROM inventory.publication_membership_versions WHERE publication_target_id=NEW.publication_target_id)
    OR NEW.evidence->'review'->'ready' IS DISTINCT FROM 'true'::jsonb
    OR NEW.evidence->'review'->>'reviewHash' IS DISTINCT FROM NEW.review_hash
    OR NEW.evidence->'review'->'includedVariantIds' IS DISTINCT FROM to_jsonb(expected_ids)
    OR NEW.excluded_variant_ids IS DISTINCT FROM ARRAY(
      SELECT (value->>'productVariantId')::integer
      FROM jsonb_array_elements(COALESCE(NEW.evidence->'review'->'excludedVariants','[]'::jsonb))
      ORDER BY (value->>'productVariantId')::integer)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.evidence->'review'->'excludedVariants','[]'::jsonb))
      WHERE value->>'reason' IS DISTINCT FROM 'unsupported_bundle')
    OR COALESCE(NEW.receipt->'excludedVariants','[]'::jsonb)
      IS DISTINCT FROM COALESCE(NEW.evidence->'review'->'excludedVariants','[]'::jsonb)
    OR NEW.receipt->>'publicationTargetId' IS DISTINCT FROM NEW.publication_target_id::text
    OR NEW.receipt->>'previousRevision' IS DISTINCT FROM NEW.previous_revision::text
    OR NEW.receipt->>'revision' IS DISTINCT FROM (NEW.previous_revision+1)::text
    OR NEW.receipt->>'reviewHash' IS DISTINCT FROM NEW.review_hash
    OR NEW.receipt->>'preparedBy' IS DISTINCT FROM NEW.actor
    OR (NEW.receipt->>'preparedAt')::timestamptz IS DISTINCT FROM NEW.occurred_at
    OR NEW.receipt->'includedVariantIds' IS DISTINCT FROM to_jsonb(expected_ids)
    OR NEW.receipt->'alreadyApplied' IS DISTINCT FROM 'false'::jsonb
    OR NEW.receipt->'runtimeAuthorityChanged' IS DISTINCT FROM 'false'::jsonb
    OR NEW.receipt->'providerWriteAttempted' IS DISTINCT FROM 'false'::jsonb
    OR NEW.receipt->'outboxEnqueued' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'INITIAL_SCOPE_RECEIPT_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_initial_scope_receipt_guard
BEFORE INSERT ON inventory.publication_initial_scope_receipts
FOR EACH ROW EXECUTE FUNCTION inventory.guard_initial_publication_scope_receipt();

CREATE OR REPLACE FUNCTION inventory.guard_publication_membership_mode() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- Exactly the existing new-Walmart default, not a migration of older rows.
    IF NEW.destination_kind='channel_connection' AND EXISTS(
      SELECT 1 FROM channels.channels WHERE id=NEW.channel_id AND lower(provider)='walmart'
    ) THEN NEW.membership_mode:='explicit'; END IF;
  ELSIF NEW.membership_mode IS DISTINCT FROM OLD.membership_mode THEN
    PERFORM inventory.assert_cutover_admission_fence_owner();
    IF OLD.membership_mode<>'whole_product' OR NEW.membership_mode<>'explicit'
      OR OLD.state<>'preview' OR NEW.state<>'preview' OR OLD.publication_authority<>'echelon'
      OR NOT EXISTS(SELECT 1 FROM inventory.publication_initial_scope_receipts receipt
        WHERE receipt.publication_target_id=OLD.id AND receipt.previous_revision=OLD.revision
          AND receipt.owner_transaction_id=pg_current_xact_id()) THEN
      RAISE EXCEPTION 'Publication membership mode requires a current audited initial-scope command' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A receipt alone is never success. Mode, initial heads and audit must all commit
-- together; missing/extra members, partial writes, or audit failure roll back all.
CREATE FUNCTION inventory.assert_initial_publication_scope_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual_ids integer[]; expected_ids integer[];
BEGIN
  PERFORM inventory.assert_cutover_admission_fence_owner();
  SELECT COALESCE(array_agg(head.product_variant_id ORDER BY head.product_variant_id),'{}'::integer[]) INTO actual_ids
    FROM inventory.publication_membership_heads head WHERE head.publication_target_id=NEW.publication_target_id;
  SELECT COALESCE(array_agg(value ORDER BY value),'{}'::integer[]) INTO expected_ids
    FROM unnest(NEW.included_variant_ids || NEW.excluded_variant_ids) AS item(value);
  IF actual_ids IS DISTINCT FROM expected_ids
    OR NOT EXISTS(SELECT 1 FROM inventory.inventory_publication_targets WHERE id=NEW.publication_target_id
      AND membership_mode='explicit' AND state='preview' AND publication_authority='echelon' AND revision=NEW.previous_revision+1)
    OR NOT EXISTS(SELECT 1 FROM inventory.availability_runtime_authority WHERE singleton_key=true
      AND authority='legacy' AND activation_run_id IS NULL AND revision=NEW.authority_revision)
    OR EXISTS(SELECT 1 FROM inventory.availability_activation_freezes WHERE released_at IS NULL)
    OR EXISTS(SELECT 1 FROM inventory.publication_membership_heads head
      JOIN inventory.publication_membership_versions version ON version.id=head.active_version_id
      WHERE head.publication_target_id=NEW.publication_target_id AND
        (version.included IS DISTINCT FROM (head.product_variant_id=ANY(NEW.included_variant_ids))
          OR version.version<>1 OR version.review_hash<>NEW.review_hash
          OR version.created_by<>NEW.actor OR version.created_at<>NEW.occurred_at))
    OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE actor=NEW.actor
      AND action='inventory_availability.publication_scope.initialized'
      AND target='inventory.inventory_publication_target:'||NEW.publication_target_id::text
      AND context->>'requestHash'=NEW.request_hash) THEN
    RAISE EXCEPTION 'INITIAL_SCOPE_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publication_initial_scope_complete
AFTER INSERT ON inventory.publication_initial_scope_receipts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.assert_initial_publication_scope_complete();

COMMENT ON TABLE inventory.publication_initial_scope_receipts IS
  'One immutable reviewed legacy/preview-only scope initialization per Echelon target; does not activate or publish inventory.';
