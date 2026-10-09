-- No provider operation or historical quantity outcome changes in this migration.
-- Source mapping stays immutable; the worker separately binds observed resources.
ALTER TABLE channels.ebay_listing_sync_jobs
  ADD COLUMN provider_identity jsonb CHECK(jsonb_typeof(provider_identity)='object'),
  ADD COLUMN provider_identity_hash text CHECK(provider_identity_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT ebay_sync_provider_identity_pair CHECK((provider_identity IS NULL)=(provider_identity_hash IS NULL));

CREATE TABLE channels.ebay_listing_sync_admission_failures (
  command_key uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  product_id integer NOT NULL REFERENCES catalog.products(id),
  variant_ids integer[] NOT NULL,
  actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 200),
  error_code text NOT NULL CHECK(length(error_code) BETWEEN 1 AND 100),
  error_message text NOT NULL CHECK(length(error_message) BETWEEN 1 AND 1000),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL
);
CREATE INDEX ebay_sync_admission_failure_latest ON channels.ebay_listing_sync_admission_failures(channel_id,product_id,created_at DESC);
CREATE TRIGGER ebay_sync_admission_failure_immutable BEFORE UPDATE OR DELETE ON channels.ebay_listing_sync_admission_failures
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_sync_admission_failure_no_truncate BEFORE TRUNCATE ON channels.ebay_listing_sync_admission_failures
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE OR REPLACE FUNCTION channels.guard_ebay_listing_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.verification_intent_hash IS NOT NULL OR NEW.verification_revision IS NOT NULL OR NEW.provider_identity IS NOT NULL THEN
      RAISE EXCEPTION 'New listing sync jobs cannot contain a verification checkpoint' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Saved listing sync jobs are retained permanently' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.channel_id,NEW.connection_id,NEW.product_id,NEW.identity,NEW.identity_hash,NEW.requested_by,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.channel_id,OLD.connection_id,OLD.product_id,OLD.identity,OLD.identity_hash,OLD.requested_by,OLD.created_at)
    OR OLD.state IN ('completed','needs_attention') OR NEW.revision NOT IN (OLD.revision,OLD.revision+1) THEN
    RAISE EXCEPTION 'Listing sync identity and terminal jobs are immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.state,NEW.owner_token,NEW.claimed_revision,NEW.verification_intent_hash,NEW.verification_revision,NEW.provider_identity,NEW.provider_identity_hash)
    IS DISTINCT FROM (OLD.state,OLD.owner_token,OLD.claimed_revision,OLD.verification_intent_hash,OLD.verification_revision,OLD.provider_identity,OLD.provider_identity_hash)
    AND NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=918427 AND objid=hashtext(OLD.id::text)::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) THEN
    RAISE EXCEPTION 'Listing sync transition requires its exact live session owner' USING ERRCODE='23514';
  END IF;
  IF (NEW.verification_intent_hash,NEW.verification_revision) IS DISTINCT FROM (OLD.verification_intent_hash,OLD.verification_revision)
    AND (OLD.state <> 'running' OR NEW.verification_revision IS DISTINCT FROM OLD.claimed_revision
      OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
        AND e.revision=OLD.claimed_revision AND e.owner_token=OLD.owner_token AND e.event='stage_started'
        AND e.evidence->>'key'='verification' AND e.evidence->>'preparedIntentHash'=NEW.verification_intent_hash)) THEN
    RAISE EXCEPTION 'Verification checkpoint requires its exact owned stage evidence' USING ERRCODE='23514';
  END IF;
  IF (NEW.provider_identity,NEW.provider_identity_hash) IS DISTINCT FROM (OLD.provider_identity,OLD.provider_identity_hash)
    AND (OLD.provider_identity IS NOT NULL OR OLD.state<>'running' OR NEW.provider_identity IS NULL
      OR NEW.owner_token IS DISTINCT FROM OLD.owner_token OR NEW.claimed_revision IS DISTINCT FROM OLD.claimed_revision
      OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
        AND e.revision=OLD.claimed_revision AND e.owner_token=OLD.owner_token AND e.event='stage_completed'
        AND e.evidence->>'key'='provider_identity' AND e.evidence->>'preparedIntentHash'=NEW.provider_identity_hash
        AND e.evidence->'identity'=NEW.provider_identity)) THEN
    RAISE EXCEPTION 'Provider identity requires its immutable owned observation receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
