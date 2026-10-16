-- Re-enter the saved publication executor without clearing any delivery barrier.
-- A fresh Sync command is an instruction to continue checking the same request;
-- only immutable provider rejection proof can permit another publish write.
CREATE OR REPLACE FUNCTION channels.has_owned_ebay_publication_continuation(
  before_job channels.ebay_listing_sync_jobs, after_job channels.ebay_listing_sync_jobs
) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT before_job.operation='publish' AND before_job.state='needs_attention'
    AND after_job.state='queued' AND after_job.revision=before_job.revision+1
    AND before_job.owner_token IS NULL AND before_job.claimed_revision IS NULL
    AND after_job.owner_token IS NULL AND after_job.claimed_revision IS NULL
    AND (after_job.provider_identity,after_job.provider_identity_hash,after_job.publication_target,after_job.publication_target_hash,
      after_job.publication_accepted,after_job.publication_accepted_hash,after_job.verification_intent_hash,after_job.verification_revision)
      IS NOT DISTINCT FROM (before_job.provider_identity,before_job.provider_identity_hash,before_job.publication_target,before_job.publication_target_hash,
      before_job.publication_accepted,before_job.publication_accepted_hash,before_job.verification_intent_hash,before_job.verification_revision)
    AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e
      JOIN channels.ebay_listing_sync_commands c ON c.command_key::text=e.evidence->>'commandKey' AND c.job_id=e.job_id
      WHERE e.job_id=before_job.id AND e.revision=before_job.revision AND e.owner_token IS NULL AND e.event='requested'
        AND e.evidence->>'continuationOnly'='true' AND e.evidence->>'requestedOperation'='sync'
        AND e.evidence->>'ownerTransactionId'=pg_current_xact_id()::text
        AND e.evidence->>'beforeRevision'=before_job.revision::text AND e.evidence->'identity'=before_job.identity
        AND c.actor=e.evidence->>'actor' AND c.identity_hash=e.evidence->>'sourceIdentityHash'
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[before_job.id::text,'listing:'||before_job.channel_id::text||':'||before_job.product_id::text,
          'enqueue:'||before_job.channel_id::text||':'||before_job.product_id::text,'command:'||c.command_key::text]) required_lock
          WHERE NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=918427
            AND objid=hashtext(required_lock)::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted)));
$$;

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
    OR (OLD.state='needs_attention' AND NOT (
      (OLD.operation='publish' AND NEW.state='queued' AND NEW.revision=OLD.revision+1
        AND NEW.publication_accepted IS NULL AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
          AND e.event='publication_retry_authorized' AND e.revision=OLD.revision AND e.evidence->>'ownerTransactionId'=pg_current_xact_id()::text))
      OR channels.has_owned_ebay_publication_continuation(OLD,NEW)))
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
