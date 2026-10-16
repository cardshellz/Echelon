-- A saved Sync may replace an unknown synchronous eBay write. This is not
-- terminal-response evidence. Every such decision installs recurring current
-- stock/content reconciliation in the same transaction; no provider I/O here.
CREATE TABLE inventory.ebay_publication_reconciliation_watches (
  id bigserial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog.products(id),
  connection_id integer NOT NULL REFERENCES channels.channel_connections(id),
  external_scope_id text NOT NULL CHECK(length(external_scope_id) BETWEEN 1 AND 240),
  scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
  scopes jsonb NOT NULL CHECK(jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 251),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  cycle bigint NOT NULL DEFAULT 1 CHECK(cycle>0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','needs_attention')),
  next_check_at timestamptz NOT NULL,
  checked_at timestamptz,
  verified_outbox_ids bigint[] NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text CHECK(length(last_error_code) BETWEEN 1 AND 100),
  last_error_message text CHECK(length(last_error_message)<=1000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Each exact membership keeps its original obligation. A later verified
  -- member set must not overwrite it or permanently fence the whole product.
  UNIQUE(product_id,connection_id,external_scope_id,scope_hash),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
  CHECK(state<>'verified' OR (checked_at IS NOT NULL AND cardinality(verified_outbox_ids)>0))
);
CREATE INDEX ebay_publication_reconciliation_due ON inventory.ebay_publication_reconciliation_watches(next_check_at,id);
CREATE INDEX ebay_publication_reconciliation_product ON inventory.ebay_publication_reconciliation_watches(product_id,connection_id,external_scope_id,id);

CREATE TABLE inventory.ebay_automatic_publication_recoveries (
  attempt_id bigint PRIMARY KEY REFERENCES inventory.quantity_publication_attempts(id),
  -- Stable references supplied by the channel command owner. Inventory retains
  -- its audit independently of the channel owner's saved-job lifecycle.
  sync_job_id uuid NOT NULL,
  sync_revision bigint NOT NULL CHECK(sync_revision>0),
  watch_id bigint NOT NULL REFERENCES inventory.ebay_publication_reconciliation_watches(id),
  scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
  scope_keys text[] NOT NULL CHECK(cardinality(scope_keys) BETWEEN 1 AND 251),
  before_record jsonb NOT NULL CHECK(jsonb_typeof(before_record)='object'),
  request_evidence jsonb NOT NULL CHECK(jsonb_typeof(request_evidence)='array' AND jsonb_array_length(request_evidence)<=2000),
  created_at timestamptz NOT NULL,
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX ebay_automatic_recovery_sync_job ON inventory.ebay_automatic_publication_recoveries(sync_job_id,sync_revision);

CREATE TABLE inventory.ebay_publication_reconciliation_observations (
  id bigserial PRIMARY KEY,
  watch_id bigint NOT NULL REFERENCES inventory.ebay_publication_reconciliation_watches(id),
  revision bigint NOT NULL CHECK(revision>0),
  cycle bigint NOT NULL CHECK(cycle>0),
  outbox_id bigint NOT NULL REFERENCES inventory.inventory_publication_outbox(id),
  observed_quantity bigint NOT NULL CHECK(observed_quantity>=0),
  quantity_consistent boolean NOT NULL,
  matches_desired boolean NOT NULL,
  current_revision boolean NOT NULL,
  provider_response_hash text NOT NULL CHECK(provider_response_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL
);
CREATE INDEX ebay_publication_reconciliation_observation_cycle ON inventory.ebay_publication_reconciliation_observations(watch_id,revision,cycle,id);
CREATE TABLE inventory.ebay_publication_reconciliation_cycles (
  watch_id bigint NOT NULL REFERENCES inventory.ebay_publication_reconciliation_watches(id),
  revision bigint NOT NULL CHECK(revision>0),
  cycle bigint NOT NULL CHECK(cycle>0),
  command_key uuid NOT NULL UNIQUE,
  content_job_id uuid,
  stock_state text NOT NULL CHECK(stock_state IN ('verified','repair_queued','blocked')),
  error_code text CHECK(length(error_code) BETWEEN 1 AND 100),
  error_message text CHECK(length(error_message)<=1000),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY(watch_id,cycle),
  CHECK(stock_state='blocked' OR content_job_id IS NOT NULL)
);
CREATE INDEX ebay_publication_reconciliation_content_job ON inventory.ebay_publication_reconciliation_cycles(content_job_id)
  WHERE content_job_id IS NOT NULL;

CREATE FUNCTION inventory.guard_ebay_automatic_publication_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt inventory.quantity_publication_attempts%ROWTYPE; actual jsonb; request_count integer;
BEGIN
  SELECT * INTO attempt FROM inventory.quantity_publication_attempts WHERE id=NEW.attempt_id;
  PERFORM inventory.assert_ebay_operator_resume_locks(NEW.scope_keys);
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR attempt.state NOT IN ('running','uncertain') OR attempt.owner_kind NOT IN ('legacy','outbox')
    OR attempt.scope->>'providerKey' IS DISTINCT FROM 'ebay'
    OR attempt.scope->>'providerScopeType' IS DISTINCT FROM 'account'
    OR NOT attempt.affected_scope_keys <@ NEW.scope_keys
    OR to_jsonb(attempt) IS DISTINCT FROM NEW.before_record
    OR NOT EXISTS(SELECT 1 FROM inventory.ebay_publication_reconciliation_watches watch WHERE watch.id=NEW.watch_id
      AND watch.scope_hash=NEW.scope_hash AND watch.state='pending') THEN
    RAISE EXCEPTION 'Automatic replacement requires exact unresolved ownership and durable recurring reconciliation' USING ERRCODE='23514';
  END IF;
  SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object('request_record',to_jsonb(q),'result_record',to_jsonb(r)) ORDER BY q.ordinal),'[]'::jsonb)
    INTO request_count,actual FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
    WHERE q.attempt_id=NEW.attempt_id;
  IF actual IS DISTINCT FROM NEW.request_evidence OR EXISTS(
    SELECT 1 FROM (SELECT q.*,row_number() OVER(ORDER BY q.ordinal) AS expected FROM inventory.quantity_provider_requests q WHERE q.attempt_id=NEW.attempt_id) q
    WHERE q.ordinal<>q.expected OR NOT (
      (q.method='POST' AND q.path='/sell/inventory/v1/bulk_update_price_quantity')
      OR (q.method='PUT' AND q.path ~ '^/sell/inventory/v1/(inventory_item|inventory_item_group|offer)/[^/?#[:space:]]+$')))
    OR (request_count=0 AND NOT (attempt.owner_kind='outbox' AND cardinality(attempt.affected_scope_keys)=1 AND EXISTS(
      SELECT 1 FROM inventory.inventory_publication_outbox o WHERE o.id=attempt.outbox_id
        AND o.provider_key_snapshot='ebay' AND o.provider_scope_type_snapshot='account'
        AND o.destination_kind_snapshot=attempt.scope->>'destinationKind'
        AND COALESCE(o.channel_connection_id_snapshot,o.dropship_store_connection_id_snapshot)::text=attempt.scope->>'connectionId'
        AND o.external_scope_id_snapshot=attempt.scope->>'externalScopeId'
        AND o.external_inventory_item_id_snapshot=attempt.scope->>'externalInventoryItemId'
        AND o.product_variant_id::text=attempt.scope->>'productVariantId'))) THEN
    RAISE EXCEPTION 'Automatic replacement must preserve every request and prove supported synchronous intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_automatic_publication_recovery_guard BEFORE INSERT ON inventory.ebay_automatic_publication_recoveries
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_ebay_automatic_publication_recovery();
CREATE FUNCTION inventory.check_ebay_automatic_publication_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts a WHERE a.id=NEW.attempt_id
    AND a.state='superseded_unknown' AND (to_jsonb(a)-'state')=(NEW.before_record-'state')) THEN
    RAISE EXCEPTION 'Automatic recovery evidence and the preserved unknown transition must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ebay_automatic_publication_recovery_complete AFTER INSERT ON inventory.ebay_automatic_publication_recoveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.check_ebay_automatic_publication_recovery();

-- Reuse every existing attempt transition guard. The new branch proves a
-- separate automatic receipt, never impersonating an operator or terminal HTTP.
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Provider attempts are retained permanently' USING ERRCODE='23514'; END IF;
  IF NEW.state='superseded_unknown' AND OLD.state IN ('running','uncertain') THEN
    IF EXISTS(SELECT 1 FROM inventory.ebay_automatic_publication_recoveries receipt
      WHERE receipt.attempt_id=OLD.id AND receipt.before_record=to_jsonb(OLD)
        AND receipt.owner_transaction_id=pg_current_xact_id()) THEN
      PERFORM inventory.assert_ebay_operator_resume_locks(OLD.affected_scope_keys);
      IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
        RAISE EXCEPTION 'Automatic recovery preserves the historical unknown outcome unchanged' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF EXISTS(SELECT 1 FROM inventory.quantity_publication_operator_resume_attempts member
      JOIN inventory.quantity_publication_operator_resumes command ON command.id=member.resume_id
      WHERE member.attempt_id=OLD.id AND member.before_record=to_jsonb(OLD)
        AND command.owner_transaction_id=pg_current_xact_id()) THEN
      PERFORM inventory.assert_ebay_operator_resume_locks(OLD.affected_scope_keys);
      IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
        RAISE EXCEPTION 'Operator resume preserves the historical unknown outcome unchanged' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    PERFORM inventory.assert_cutover_admission_fence_owner();
    IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
      OR NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_reconciliation_attempts member
        JOIN inventory.quantity_publication_reconciliations command ON command.id=member.reconciliation_id
        WHERE member.attempt_id=OLD.id AND member.before_record=to_jsonb(OLD)
          AND command.owner_transaction_id=pg_current_xact_id()) THEN
      RAISE EXCEPTION 'Superseding an attempt requires its immutable reconciliation receipt; outcome evidence must not change' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.owner_token,NEW.owner_kind,NEW.gate_epoch,NEW.scope_key,NEW.scope,NEW.outbox_id,NEW.planned_outbox_id,NEW.affected_scope_keys,NEW.affected_scopes,NEW.planned_outbox_ids,NEW.started_at)
    IS DISTINCT FROM (OLD.owner_token,OLD.owner_kind,OLD.gate_epoch,OLD.scope_key,OLD.scope,OLD.outbox_id,OLD.planned_outbox_id,OLD.affected_scope_keys,OLD.affected_scopes,OLD.planned_outbox_ids,OLD.started_at)
    OR OLD.state IN ('succeeded','resolved','rejected','not_sent','superseded_unknown') OR NEW.state NOT IN ('succeeded','uncertain','resolved','rejected','not_sent')
    OR (NEW.state IN ('rejected','not_sent') AND OLD.state<>'running') THEN
    RAISE EXCEPTION 'Provider attempt identity and terminal evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.resolution_basis='provider_response_terminal' AND (OLD.state NOT IN ('running','uncertain')
    OR (to_jsonb(NEW)-'state'-'completed_at'-'outcome_hash'-'resolution_basis')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'completed_at'-'outcome_hash'-'resolution_basis')
    OR NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_response_recoveries r WHERE r.attempt_id=OLD.id
      AND r.before_record=to_jsonb(OLD) AND r.evidence_hash=NEW.outcome_hash AND r.owner_transaction_id=pg_current_xact_id())) THEN
    RAISE EXCEPTION 'Automated response recovery requires its immutable atomic receipt' USING ERRCODE='23514';
  END IF;
  IF NEW.state='rejected' AND (
    NOT EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND r.outcome='rejected') OR
    EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND (r.request_id IS NULL OR r.outcome='uncertain' OR r.http_status IS NULL OR r.response_hash IS NULL))
  ) THEN RAISE EXCEPTION 'Terminal rejection requires complete request evidence' USING ERRCODE='23514'; END IF;
  IF NEW.state='not_sent' AND (OLD.owner_kind NOT IN ('listing_setup_zero','outbox')
    OR NEW.outcome_hash IS NULL OR NEW.error_code IS NULL OR NEW.completed_at IS NULL
    OR NEW.resolution_basis IS DISTINCT FROM 'owner_preflight_no_request'
    OR EXISTS(SELECT 1 FROM inventory.quantity_provider_requests WHERE attempt_id=OLD.id)) THEN
    RAISE EXCEPTION 'Preflight no-request completion requires an explicit setup or outbox owner receipt and zero request records' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['ebay_automatic_publication_recoveries','ebay_publication_reconciliation_observations','ebay_publication_reconciliation_cycles'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation()',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON inventory.%I FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation()',table_name||'_no_truncate',table_name);
  END LOOP;
END $$;
CREATE FUNCTION inventory.guard_ebay_publication_reconciliation_watch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.product_id,NEW.connection_id,NEW.external_scope_id,NEW.scope_hash,NEW.scopes,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.product_id,OLD.connection_id,OLD.external_scope_id,OLD.scope_hash,OLD.scopes,OLD.created_at)
    OR NEW.revision<OLD.revision OR NEW.cycle<OLD.cycle THEN
    RAISE EXCEPTION 'Recurring recovery identity and history cannot be removed or rewound' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_publication_reconciliation_watch_guard BEFORE UPDATE OR DELETE ON inventory.ebay_publication_reconciliation_watches
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_ebay_publication_reconciliation_watch();
CREATE TRIGGER ebay_publication_reconciliation_watches_no_truncate BEFORE TRUNCATE ON inventory.ebay_publication_reconciliation_watches
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
