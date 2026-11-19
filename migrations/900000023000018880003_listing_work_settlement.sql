-- A historical pre-dispatch refusal is settled only by verified exact-scope
-- replacement evidence. Neither the failure nor its provider history is changed.
CREATE TABLE channels.ebay_listing_sync_settlements (
  failed_job_id uuid PRIMARY KEY REFERENCES channels.ebay_listing_sync_jobs(id),
  replacement_job_id uuid NOT NULL REFERENCES channels.ebay_listing_sync_jobs(id),
  before_record jsonb NOT NULL,
  actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 200),
  resolved_at timestamptz NOT NULL,
  CHECK(failed_job_id<>replacement_job_id)
);
CREATE FUNCTION channels.guard_ebay_listing_sync_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Listing work settlements are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM channels.ebay_listing_sync_jobs failed JOIN channels.ebay_listing_sync_jobs replacement
      ON replacement.id=NEW.replacement_job_id AND replacement.identity_hash=failed.identity_hash
      AND replacement.channel_id=failed.channel_id AND replacement.connection_id=failed.connection_id AND replacement.product_id=failed.product_id
    WHERE failed.id=NEW.failed_job_id AND failed.operation='sync' AND failed.state='needs_attention'
      AND replacement.operation='sync' AND replacement.state='completed' AND replacement.created_at>=failed.created_at
      AND to_jsonb(failed)=NEW.before_record
      AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=failed.id AND e.event='stage_started' AND e.evidence->>'key'='prepare_listing')
      AND NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=failed.id AND e.event IN ('stage_started','stage_completed')
        AND (e.evidence->>'key' IS DISTINCT FROM 'prepare_listing' OR e.event='stage_completed'))
      AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=replacement.id AND e.revision=replacement.revision
        AND e.event='stage_completed' AND e.evidence->>'key'='verification'
        AND e.evidence->>'preparedIntentHash'=replacement.verification_intent_hash)
  ) THEN RAISE EXCEPTION 'Settlement requires an unsent failure and its exact verified replacement' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_listing_sync_settlement_guard BEFORE INSERT OR UPDATE OR DELETE ON channels.ebay_listing_sync_settlements
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_listing_sync_settlement();
CREATE INDEX ebay_listing_sync_failed_scope ON channels.ebay_listing_sync_jobs(identity_hash)
  WHERE operation='sync' AND state='needs_attention';
