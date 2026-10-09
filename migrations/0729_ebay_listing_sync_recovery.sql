-- Installing this migration makes no provider call and resolves no old attempt.
-- Request termination and successful delivery are distinct evidence.
CREATE TABLE inventory.quantity_publication_response_recoveries (
  attempt_id bigint PRIMARY KEY REFERENCES inventory.quantity_publication_attempts(id),
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
  request_receipts jsonb NOT NULL CHECK(jsonb_typeof(request_receipts)='array' AND jsonb_array_length(request_receipts)>0),
  before_record jsonb NOT NULL CHECK(jsonb_typeof(before_record)='object'),
  created_at timestamptz NOT NULL,
  actor text NOT NULL DEFAULT 'system:quantity-provider-response-recovery' CHECK(actor='system:quantity-provider-response-recovery'),
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TRIGGER publication_response_recoveries_immutable BEFORE UPDATE OR DELETE
  ON inventory.quantity_publication_response_recoveries FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE FUNCTION inventory.guard_publication_response_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual jsonb;owned_keys text[];scope_key text;lock_key bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
    AND classid=918419 AND objid=0 AND objsubid=2 AND mode='ShareLock' AND granted)
    OR NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts a WHERE a.id=NEW.attempt_id
      AND a.owner_kind IN ('legacy','outbox') AND a.state IN ('running','uncertain') AND a.scope->>'providerKey'='ebay'
      AND to_jsonb(a)=NEW.before_record) THEN
    RAISE EXCEPTION 'Response recovery requires exclusive exact unresolved ownership' USING ERRCODE='23514';
  END IF;
  SELECT affected_scope_keys INTO owned_keys FROM inventory.quantity_publication_attempts WHERE id=NEW.attempt_id;
  IF cardinality(owned_keys)<1 THEN RAISE EXCEPTION 'Response recovery requires every exact owned scope' USING ERRCODE='23514';END IF;
  FOREACH scope_key IN ARRAY owned_keys LOOP
    -- The identical 64-bit advisory key used by existing inventory admission.
    lock_key:=hashtextextended(scope_key,918420);
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=((lock_key>>32)&4294967295)::oid AND objid=(lock_key&4294967295)::oid
      AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN
      RAISE EXCEPTION 'Response recovery requires exclusive exact-scope ownership' USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('requestId',q.id::text,'ordinal',q.ordinal,'method',q.method,'path',q.path,
    'requestHash',q.request_hash,'outcome',r.outcome,'httpStatus',r.http_status,'responseHash',r.response_hash,
    'errorCodes',COALESCE(r.error_codes,'{}'::text[]),'recordedAt',
    CASE WHEN r.recorded_at IS NULL THEN NULL ELSE to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) ORDER BY q.ordinal)
    INTO actual FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
    WHERE q.attempt_id=NEW.attempt_id;
  IF actual IS NULL OR actual IS DISTINCT FROM NEW.request_receipts THEN
    RAISE EXCEPTION 'Response recovery must retain every immutable request receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_response_recovery_guard BEFORE INSERT ON inventory.quantity_publication_response_recoveries
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_response_recovery();
ALTER TABLE inventory.quantity_publication_attempts DROP CONSTRAINT quantity_publication_attempts_basis;
ALTER TABLE inventory.quantity_publication_attempts ADD CONSTRAINT quantity_publication_attempts_basis
  CHECK(resolution_basis IN ('owner_completion','operator_attestation','provider_rejection','owner_preflight_no_request','provider_response_terminal'));
ALTER TABLE inventory.quantity_publication_attempts ADD CONSTRAINT publication_response_terminal_state
  CHECK(resolution_basis IS DISTINCT FROM 'provider_response_terminal' OR state='resolved');

-- Retain the established cutover, rejection and no-request transition protections.
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Provider attempts are retained permanently' USING ERRCODE='23514'; END IF;
  IF NEW.state='superseded_unknown' AND OLD.state IN ('running','uncertain') THEN
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
  IF NEW.state='not_sent' AND (OLD.owner_kind<>'listing_setup_zero' OR NEW.outcome_hash IS NULL OR NEW.error_code IS NULL
    OR EXISTS(SELECT 1 FROM inventory.quantity_provider_requests WHERE attempt_id=OLD.id)) THEN
    RAISE EXCEPTION 'Preflight no-request completion requires zero request records and listing setup ownership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION inventory.check_publication_response_recovery_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts a WHERE a.id=NEW.attempt_id AND a.state='resolved'
    AND a.resolution_basis='provider_response_terminal' AND a.outcome_hash=NEW.evidence_hash) THEN
    RAISE EXCEPTION 'Response recovery receipt and transition must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER publication_response_recovery_complete AFTER INSERT ON inventory.quantity_publication_response_recoveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.check_publication_response_recovery_complete();

CREATE TABLE channels.ebay_listing_sync_jobs (
  id uuid PRIMARY KEY, channel_id integer NOT NULL REFERENCES channels.channels(id),
  connection_id integer NOT NULL REFERENCES channels.channel_connections(id), product_id integer NOT NULL REFERENCES catalog.products(id),
  identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='object'), identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','recovering','awaiting_evidence','completed','needs_attention')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), claimed_revision bigint CHECK(claimed_revision>0 AND claimed_revision<=revision),
  owner_token uuid, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  requested_by text NOT NULL CHECK(length(btrim(requested_by)) BETWEEN 1 AND 200),
  error_code text CHECK(length(error_code)<=100), error_message text CHECK(length(error_message)<=1000), result jsonb,
  next_attempt_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CHECK((state='running')=(owner_token IS NOT NULL AND claimed_revision IS NOT NULL))
);
CREATE UNIQUE INDEX ebay_listing_sync_one_active ON channels.ebay_listing_sync_jobs(channel_id,product_id)
  WHERE state IN ('queued','running','recovering','awaiting_evidence');
CREATE INDEX ebay_listing_sync_due ON channels.ebay_listing_sync_jobs(next_attempt_at,id) WHERE state IN ('queued','running','recovering','awaiting_evidence');
CREATE INDEX ebay_listing_sync_latest ON channels.ebay_listing_sync_jobs(channel_id,product_id,updated_at DESC,id DESC);
CREATE FUNCTION channels.guard_ebay_listing_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Saved listing sync jobs are retained permanently' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.channel_id,NEW.connection_id,NEW.product_id,NEW.identity,NEW.identity_hash,NEW.requested_by,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.channel_id,OLD.connection_id,OLD.product_id,OLD.identity,OLD.identity_hash,OLD.requested_by,OLD.created_at)
    OR OLD.state IN ('completed','needs_attention') OR NEW.revision NOT IN (OLD.revision,OLD.revision+1) THEN
    RAISE EXCEPTION 'Listing sync identity and terminal jobs are immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.state,NEW.owner_token,NEW.claimed_revision) IS DISTINCT FROM (OLD.state,OLD.owner_token,OLD.claimed_revision)
    AND NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=918427 AND objid=hashtext(OLD.id::text)::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) THEN
    RAISE EXCEPTION 'Listing sync transition requires its exact live session owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_listing_sync_job_guard BEFORE UPDATE OR DELETE ON channels.ebay_listing_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_listing_sync_job();
CREATE TABLE channels.ebay_listing_sync_commands (
  command_key uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES channels.ebay_listing_sync_jobs(id),
  identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 200),created_at timestamptz NOT NULL
);
CREATE TABLE channels.ebay_listing_sync_events (
  id bigserial PRIMARY KEY,job_id uuid NOT NULL REFERENCES channels.ebay_listing_sync_jobs(id),revision bigint NOT NULL CHECK(revision>0),
  event text NOT NULL CHECK(event IN ('requested','claimed','stage_started','stage_completed','completed','recovering','awaiting_evidence','needs_attention')),
  owner_token uuid,evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),created_at timestamptz NOT NULL
);
CREATE TRIGGER ebay_listing_sync_commands_immutable BEFORE UPDATE OR DELETE ON channels.ebay_listing_sync_commands
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_listing_sync_events_immutable BEFORE UPDATE OR DELETE ON channels.ebay_listing_sync_events
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_listing_sync_events_no_truncate BEFORE TRUNCATE ON channels.ebay_listing_sync_events
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_listing_sync_commands_no_truncate BEFORE TRUNCATE ON channels.ebay_listing_sync_commands
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER publication_response_recoveries_no_truncate BEFORE TRUNCATE ON inventory.quantity_publication_response_recoveries
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
