-- Content verification is separate from quantity request termination evidence.
-- No job is reactivated and no provider request/quantity guard is changed here.
ALTER TABLE channels.ebay_listing_sync_jobs
  ADD COLUMN verification_intent_hash text CHECK(verification_intent_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN verification_revision bigint CHECK(verification_revision > 0 AND verification_revision <= revision),
  ADD CONSTRAINT ebay_sync_verification_checkpoint_pair CHECK(
    (verification_intent_hash IS NULL) = (verification_revision IS NULL));

CREATE OR REPLACE FUNCTION channels.guard_ebay_listing_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.verification_intent_hash IS NOT NULL OR NEW.verification_revision IS NOT NULL THEN
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
  IF (NEW.state,NEW.owner_token,NEW.claimed_revision,NEW.verification_intent_hash,NEW.verification_revision)
    IS DISTINCT FROM (OLD.state,OLD.owner_token,OLD.claimed_revision,OLD.verification_intent_hash,OLD.verification_revision)
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
  RETURN NEW;
END $$;

CREATE TRIGGER ebay_listing_sync_checkpoint_insert_guard BEFORE INSERT ON channels.ebay_listing_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_listing_sync_job();
