-- One queue owns publication, maintenance, and withdrawal. No provider calls.
ALTER TABLE channels.ebay_listing_sync_jobs DROP CONSTRAINT ebay_listing_sync_jobs_operation_check;
ALTER TABLE channels.ebay_listing_sync_jobs ADD CONSTRAINT ebay_listing_sync_jobs_operation_check CHECK(operation IN ('sync','publish','withdraw'));
ALTER TABLE channels.ebay_listing_sync_admission_failures DROP CONSTRAINT ebay_listing_sync_admission_failures_operation_check;
ALTER TABLE channels.ebay_listing_sync_admission_failures ADD CONSTRAINT ebay_listing_sync_admission_failures_operation_check CHECK(operation IN ('sync','publish','withdraw'));
CREATE TABLE channels.ebay_listing_exclusion_commands (
  command_key uuid PRIMARY KEY, channel_id integer NOT NULL REFERENCES channels.channels(id),
  product_id integer NOT NULL REFERENCES catalog.products(id), actor text NOT NULL,
  excluded boolean NOT NULL, job_id uuid REFERENCES channels.ebay_listing_sync_jobs(id),
  before_intent jsonb NOT NULL, created_at timestamptz NOT NULL,
  CHECK(length(actor) BETWEEN 1 AND 200)
);
CREATE TRIGGER ebay_listing_exclusion_commands_immutable BEFORE UPDATE OR DELETE ON channels.ebay_listing_exclusion_commands
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_listing_exclusion_commands_no_truncate BEFORE TRUNCATE ON channels.ebay_listing_exclusion_commands
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
-- Reuse the existing reviewed-retry protocol for interrupted withdrawals.
-- Original start/response evidence remains immutable; authorization only permits
-- a new attempt of the same saved identity after fresh provider inspection.
ALTER TABLE channels.ebay_listing_sync_events DROP CONSTRAINT ebay_listing_sync_events_event_check;
ALTER TABLE channels.ebay_listing_sync_events ADD CONSTRAINT ebay_listing_sync_events_event_check CHECK(event IN
  ('requested','claimed','stage_started','stage_completed','completed','recovering','awaiting_evidence','needs_attention',
   'publication_retry_authorized','withdrawal_retry_authorized'));
CREATE OR REPLACE FUNCTION channels.guard_ebay_publication_retry_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job channels.ebay_listing_sync_jobs%ROWTYPE; operation_name text; stage_key text;
BEGIN
  IF NEW.event NOT IN ('publication_retry_authorized','withdrawal_retry_authorized') THEN RETURN NEW; END IF;
  operation_name := CASE WHEN NEW.event='withdrawal_retry_authorized' THEN 'withdraw' ELSE 'publish' END;
  stage_key := operation_name;
  SELECT * INTO job FROM channels.ebay_listing_sync_jobs WHERE id=NEW.job_id;
  IF job.operation<>operation_name OR job.state='completed'
    OR (operation_name='publish' AND (job.publication_target IS NULL OR job.publication_accepted IS NOT NULL
      OR NEW.evidence->'publicationTarget' IS DISTINCT FROM job.publication_target))
    OR (operation_name='withdraw' AND (job.provider_identity IS NULL OR job.state NOT IN ('queued','running','recovering','awaiting_evidence')
      OR NEW.evidence->'providerIdentity' IS DISTINCT FROM job.provider_identity))
    OR NEW.owner_token IS NOT NULL OR NEW.revision<>job.revision
    OR NEW.evidence->>'ownerTransactionId' IS DISTINCT FROM pg_current_xact_id()::text
    OR NEW.evidence->>'beforeRevision' IS DISTINCT FROM job.revision::text
    OR NEW.evidence->'identity' IS DISTINCT FROM job.identity
    OR NOT COALESCE(NEW.evidence->>'reviewHash' ~ '^[a-f0-9]{64}$',false)
    OR NOT COALESCE(NEW.evidence->>'requestHash' ~ '^[a-f0-9]{64}$',false)
    OR EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=job.id AND e.event='stage_completed' AND e.evidence->>'key'=stage_key)
    OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=job.id AND e.event='stage_started' AND e.evidence->>'key'=stage_key
      AND e.id>COALESCE((SELECT max(a.id) FROM channels.ebay_listing_sync_events a WHERE a.job_id=job.id AND a.event=NEW.event),0))
    OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_commands c WHERE c.command_key=(NEW.evidence->>'commandKey')::uuid
      AND c.job_id=job.id AND c.identity_hash=job.identity_hash AND c.actor=NEW.evidence->>'actor')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[job.id::text,'listing:'||job.channel_id::text||':'||job.product_id::text,
      'enqueue:'||job.channel_id::text||':'||job.product_id::text,'command:'||(NEW.evidence->>'commandKey')]) required_lock
      WHERE NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=918427
        AND objid=hashtext(required_lock)::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted)) THEN
    RAISE EXCEPTION 'Listing retry requires its exact reviewed uncertainty and owned command' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION channels.check_ebay_publication_retry_requeued() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.event IN ('publication_retry_authorized','withdrawal_retry_authorized') AND NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_jobs job
    WHERE job.id=NEW.job_id AND job.revision=NEW.revision+1 AND job.state='queued' AND job.owner_token IS NULL
      AND job.claimed_revision IS NULL AND job.publication_accepted IS NULL AND job.error_code IS NULL) THEN
    RAISE EXCEPTION 'Listing retry acknowledgement and requeue must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- A reviewed enrollment can pin preparation when admitting the durable job.
-- The requested command receipt, exact live locks and same transaction are
-- required; provider identity, response and final verification guards stay intact.
CREATE OR REPLACE FUNCTION channels.guard_ebay_listing_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.verification_intent_hash IS NOT NULL OR NEW.verification_revision IS NOT NULL OR NEW.provider_identity IS NOT NULL OR NEW.publication_target IS NOT NULL OR NEW.publication_accepted IS NOT NULL THEN
      RAISE EXCEPTION 'New listing sync jobs cannot contain a verification checkpoint' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Saved listing sync jobs are retained permanently' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.channel_id,NEW.connection_id,NEW.product_id,NEW.identity,NEW.identity_hash,NEW.operation,NEW.requested_by,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.channel_id,OLD.connection_id,OLD.product_id,OLD.identity,OLD.identity_hash,OLD.operation,OLD.requested_by,OLD.created_at)
    OR OLD.state='completed'
    OR (OLD.state='needs_attention' AND NOT (OLD.operation='publish' AND NEW.state='queued' AND NEW.revision=OLD.revision+1
      AND NEW.publication_accepted IS NULL AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
        AND e.event='publication_retry_authorized' AND e.revision=OLD.revision AND e.evidence->>'ownerTransactionId'=pg_current_xact_id()::text)))
    OR NEW.revision NOT IN (OLD.revision,OLD.revision+1) THEN
    RAISE EXCEPTION 'Listing sync identity and terminal jobs are immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.state,NEW.owner_token,NEW.claimed_revision,NEW.verification_intent_hash,NEW.verification_revision,NEW.provider_identity,NEW.provider_identity_hash,NEW.publication_target,NEW.publication_target_hash,NEW.publication_accepted,NEW.publication_accepted_hash)
    IS DISTINCT FROM (OLD.state,OLD.owner_token,OLD.claimed_revision,OLD.verification_intent_hash,OLD.verification_revision,OLD.provider_identity,OLD.provider_identity_hash,OLD.publication_target,OLD.publication_target_hash,OLD.publication_accepted,OLD.publication_accepted_hash)
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
        AND e.evidence->'identity'=NEW.provider_identity
        AND (OLD.operation<>'publish' OR (jsonb_typeof(e.evidence->'observation')='object'
          AND e.evidence->'observation'->>'isPublished'='true')))) THEN
    RAISE EXCEPTION 'Provider identity requires its immutable owned observation receipt' USING ERRCODE='23514';
  END IF;
  IF (NEW.publication_target,NEW.publication_target_hash) IS DISTINCT FROM (OLD.publication_target,OLD.publication_target_hash)
    AND (OLD.operation<>'publish' OR OLD.publication_target IS NOT NULL OR NEW.publication_target IS NULL
      OR NEW.owner_token IS DISTINCT FROM OLD.owner_token OR NEW.claimed_revision IS DISTINCT FROM OLD.claimed_revision
      OR NOT (
        (OLD.state='running' AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
          AND e.revision=OLD.claimed_revision AND e.owner_token=OLD.owner_token AND e.event='stage_completed'
          AND e.evidence->>'key'='publication_target' AND e.evidence->>'preparedIntentHash'=NEW.publication_target_hash
          AND e.evidence->'identity'=NEW.publication_target))
        OR (OLD.state IN ('queued','recovering','awaiting_evidence') AND OLD.owner_token IS NULL AND OLD.claimed_revision IS NULL
          AND NEW.state=OLD.state AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e
            JOIN channels.ebay_listing_sync_commands c ON c.command_key=(e.evidence->>'commandKey')::uuid AND c.job_id=e.job_id
            WHERE e.job_id=OLD.id AND e.revision=OLD.revision AND e.owner_token IS NULL AND e.event='requested'
              AND e.evidence->>'ownerTransactionId'=pg_current_xact_id()::text
              AND c.actor=e.evidence->>'actor' AND c.identity_hash=e.evidence->>'sourceIdentityHash'
              AND e.evidence->>'targetHash'=NEW.publication_target_hash
              AND e.evidence->'reviewedPublicationTarget'=NEW.publication_target
              AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['listing:'||OLD.channel_id::text||':'||OLD.product_id::text,
                'enqueue:'||OLD.channel_id::text||':'||OLD.product_id::text,'command:'||c.command_key::text]) required_lock
                WHERE NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=918427
                  AND objid=hashtext(required_lock)::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted)))))) THEN
    RAISE EXCEPTION 'Publication target requires its immutable owned preparation or reviewed admission receipt' USING ERRCODE='23514';
  END IF;
  IF (NEW.publication_accepted,NEW.publication_accepted_hash) IS DISTINCT FROM (OLD.publication_accepted,OLD.publication_accepted_hash)
    AND (OLD.operation<>'publish' OR OLD.publication_accepted IS NOT NULL OR OLD.state<>'running' OR NEW.publication_accepted IS NULL
      OR NEW.owner_token IS DISTINCT FROM OLD.owner_token OR NEW.claimed_revision IS DISTINCT FROM OLD.claimed_revision
      OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
        AND e.revision=OLD.claimed_revision AND e.owner_token=OLD.owner_token AND e.event='stage_completed'
        AND e.evidence->>'key'='publication_accepted' AND e.evidence->>'preparedIntentHash'=NEW.publication_accepted_hash
        AND e.evidence->'response'=NEW.publication_accepted)) THEN
    RAISE EXCEPTION 'Publication response requires its immutable owned receipt' USING ERRCODE='23514';
  END IF;
  IF NEW.operation='publish' AND NEW.state='completed' AND (NEW.provider_identity IS NULL OR NEW.publication_target IS NULL
    OR OLD.verification_revision IS DISTINCT FROM OLD.claimed_revision
    OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
      AND e.revision=OLD.claimed_revision AND e.owner_token=OLD.owner_token AND e.event='stage_completed'
      AND e.evidence->>'key'='verification' AND e.evidence->>'preparedIntentHash'=OLD.verification_intent_hash)) THEN
    RAISE EXCEPTION 'Publication completion requires observed provider identity and its pinned target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
