-- Extend the existing queue; historical jobs remain maintenance sync jobs.
-- This migration performs no provider requests and changes no listing or quantity.
-- Retained publication checkpoints are read by exact job and event sequence.
CREATE INDEX ebay_listing_sync_events_job_sequence ON channels.ebay_listing_sync_events(job_id,id);
ALTER TABLE channels.ebay_listing_sync_jobs
  ADD COLUMN operation text NOT NULL DEFAULT 'sync' CHECK(operation IN ('sync','publish')),
  ADD COLUMN publication_target jsonb CHECK(jsonb_typeof(publication_target)='object'),
  ADD COLUMN publication_target_hash text CHECK(publication_target_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN publication_accepted jsonb CHECK(jsonb_typeof(publication_accepted)='object'),
  ADD COLUMN publication_accepted_hash text CHECK(publication_accepted_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT ebay_sync_publication_target_pair CHECK((publication_target IS NULL)=(publication_target_hash IS NULL)),
  ADD CONSTRAINT ebay_sync_publication_target_operation CHECK(publication_target IS NULL OR operation='publish'),
  ADD CONSTRAINT ebay_sync_publication_accepted_pair CHECK((publication_accepted IS NULL)=(publication_accepted_hash IS NULL)),
  ADD CONSTRAINT ebay_sync_publication_accepted_target CHECK(publication_accepted IS NULL OR (operation='publish' AND publication_target IS NOT NULL));
ALTER TABLE channels.ebay_listing_mapping_repairs
  ADD COLUMN operation text NOT NULL DEFAULT 'sync' CHECK(operation IN ('sync','publish')),
  ADD CONSTRAINT ebay_mapping_publish_admission_preserves_source CHECK(operation<>'publish' OR
    (before_identity=after_identity AND before_rows=after_rows AND observation->>'kind' IS NOT DISTINCT FROM 'unpublished_inspection'));
ALTER TABLE channels.ebay_listing_sync_admission_failures
  ADD COLUMN operation text NOT NULL DEFAULT 'sync' CHECK(operation IN ('sync','publish'));
ALTER TABLE channels.ebay_listing_sync_events DROP CONSTRAINT ebay_listing_sync_events_event_check;
ALTER TABLE channels.ebay_listing_sync_events ADD CONSTRAINT ebay_listing_sync_events_event_check
  CHECK(event IN ('requested','claimed','stage_started','stage_completed','completed','recovering','awaiting_evidence','needs_attention','publication_retry_authorized'));

-- Retrying a publish with a lost response is an explicit acknowledgement, never
-- a fabricated success or deletion of the old attempt. Its receipt and requeue
-- must commit together under the same product, command and provider-work locks.
CREATE FUNCTION channels.guard_ebay_publication_retry_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job channels.ebay_listing_sync_jobs%ROWTYPE;
BEGIN
  IF NEW.event<>'publication_retry_authorized' THEN RETURN NEW; END IF;
  SELECT * INTO job FROM channels.ebay_listing_sync_jobs WHERE id=NEW.job_id;
  IF job.operation<>'publish' OR job.publication_target IS NULL OR job.publication_accepted IS NOT NULL OR job.state='completed'
    OR NEW.owner_token IS NOT NULL OR NEW.revision<>job.revision
    OR NEW.evidence->>'ownerTransactionId' IS DISTINCT FROM pg_current_xact_id()::text
    OR NEW.evidence->>'beforeRevision' IS DISTINCT FROM job.revision::text
    OR NEW.evidence->'identity' IS DISTINCT FROM job.identity OR NEW.evidence->'publicationTarget' IS DISTINCT FROM job.publication_target
    OR NOT COALESCE(NEW.evidence->>'reviewHash' ~ '^[a-f0-9]{64}$',false)
    OR NOT COALESCE(NEW.evidence->>'requestHash' ~ '^[a-f0-9]{64}$',false)
    OR EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=job.id AND e.event='stage_completed' AND e.evidence->>'key'='publish')
    OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=job.id AND e.event='stage_started' AND e.evidence->>'key'='publish'
      AND e.id>COALESCE((SELECT max(a.id) FROM channels.ebay_listing_sync_events a WHERE a.job_id=job.id AND a.event='publication_retry_authorized'),0))
    OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_commands c WHERE c.command_key=(NEW.evidence->>'commandKey')::uuid
      AND c.job_id=job.id AND c.identity_hash=job.identity_hash AND c.actor=NEW.evidence->>'actor')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[job.id::text,'listing:'||job.channel_id::text||':'||job.product_id::text,
      'enqueue:'||job.channel_id::text||':'||job.product_id::text,'command:'||(NEW.evidence->>'commandKey')]) required_lock
      WHERE NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=918427
        AND objid=hashtext(required_lock)::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted)) THEN
    RAISE EXCEPTION 'Publication retry requires its exact reviewed uncertainty and owned command' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_publication_retry_authorization_guard BEFORE INSERT ON channels.ebay_listing_sync_events
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_publication_retry_authorization();
CREATE FUNCTION channels.check_ebay_publication_retry_requeued() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.event='publication_retry_authorized' AND NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_jobs job
    WHERE job.id=NEW.job_id AND job.revision=NEW.revision+1 AND job.state='queued' AND job.owner_token IS NULL
      AND job.claimed_revision IS NULL AND job.publication_accepted IS NULL) THEN
    RAISE EXCEPTION 'Publication retry acknowledgement and requeue must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ebay_publication_retry_requeued AFTER INSERT ON channels.ebay_listing_sync_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION channels.check_ebay_publication_retry_requeued();

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
    AND (OLD.operation<>'publish' OR OLD.publication_target IS NOT NULL OR OLD.state<>'running' OR NEW.publication_target IS NULL
      OR NEW.owner_token IS DISTINCT FROM OLD.owner_token OR NEW.claimed_revision IS DISTINCT FROM OLD.claimed_revision
      OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=OLD.id
        AND e.revision=OLD.claimed_revision AND e.owner_token=OLD.owner_token AND e.event='stage_completed'
        AND e.evidence->>'key'='publication_target' AND e.evidence->>'preparedIntentHash'=NEW.publication_target_hash
        AND e.evidence->'identity'=NEW.publication_target)) THEN
    RAISE EXCEPTION 'Publication target requires its immutable owned preparation receipt' USING ERRCODE='23514';
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

CREATE OR REPLACE FUNCTION channels.check_ebay_listing_mapping_repair_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=918427 AND objid=hashtext('listing:'||NEW.channel_id::text||':'||NEW.product_id::text)::oid
      AND objsubid=2 AND mode='ExclusiveLock' AND granted)
    OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_commands command JOIN channels.ebay_listing_sync_jobs job ON job.id=command.job_id
      WHERE command.command_key=NEW.command_key AND command.job_id=NEW.job_id AND command.actor=NEW.actor
        AND job.identity=NEW.queued_identity AND job.channel_id=NEW.channel_id AND job.connection_id=NEW.connection_id
        AND job.product_id=NEW.product_id AND job.operation=NEW.operation)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.after_rows) final_row
      LEFT JOIN channels.channel_listings current_row ON current_row.channel_id=NEW.channel_id
        AND current_row.product_variant_id=(final_row->>'product_variant_id')::integer
      WHERE current_row.product_variant_id IS NULL OR to_jsonb(current_row) IS DISTINCT FROM final_row)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.before_rows) prior
      FULL JOIN jsonb_array_elements(NEW.after_rows) final_row ON prior->>'product_variant_id'=final_row->>'product_variant_id'
      WHERE prior IS NULL OR final_row IS NULL
        OR (prior-'external_sku'-'external_variant_id'-'external_product_id'-'external_url'-'updated_at')
          IS DISTINCT FROM (final_row-'external_sku'-'external_variant_id'-'external_product_id'-'external_url'-'updated_at')) THEN
    RAISE EXCEPTION 'Mapping repair must preserve local work and commit its exact owned follow-up and audit receipt together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
