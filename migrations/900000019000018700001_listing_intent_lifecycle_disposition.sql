-- Lifecycle disposition retains every source fact and earlier refusal event.
-- Existing blocked rows receive one lifecycle assessment; no provider command,
-- catalog selection, inventory balance or outstanding obligation is changed.
ALTER TABLE marketplace.listing_intent_deliveries
  ADD COLUMN lifecycle jsonb,
  ADD COLUMN lifecycle_checked_at timestamptz,
  DROP CONSTRAINT listing_intent_deliveries_state_check,
  ADD CONSTRAINT listing_intent_deliveries_state_check CHECK(state IN
    ('pending','delivered','needs_review','blocked','waiting_lifecycle','not_applicable'));

CREATE FUNCTION marketplace.valid_listing_intent_lifecycle(value jsonb, terminal boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND jsonb_typeof(value)='object'
    AND value->>'assessedAt' IS NOT NULL AND value->>'selectionFingerprint' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(value->'members')='array' AND jsonb_array_length(value->'members')>0
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'members') member
      WHERE member->>'productVariantId' IS NULL OR member->>'state' IS NULL
        OR member->>'state' NOT IN ('settled','pending','attention')
        OR (terminal AND member->>'state'<>'settled'));
$$;
ALTER TABLE marketplace.listing_intent_deliveries ADD CONSTRAINT listing_intent_lifecycle_evidence_check
  CHECK(state NOT IN ('waiting_lifecycle','not_applicable') OR
    marketplace.valid_listing_intent_lifecycle(lifecycle,state='not_applicable') IS TRUE);
CREATE FUNCTION marketplace.listing_intent_lifecycle_members(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_agg((member->>'productVariantId')::integer ORDER BY (member->>'productVariantId')::integer)
    FROM jsonb_array_elements(value->'members') member;
$$;
ALTER TABLE marketplace.listing_intent_deliveries ADD CONSTRAINT listing_intent_lifecycle_scope_check
  CHECK(lifecycle IS NULL OR marketplace.listing_intent_lifecycle_members(lifecycle)=variant_ids);

CREATE FUNCTION marketplace.guard_listing_intent_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='not_applicable' AND (NEW.state,NEW.lifecycle,NEW.command_key,NEW.retry_generation)
    IS DISTINCT FROM (OLD.state,OLD.lifecycle,OLD.command_key,OLD.retry_generation)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LISTING_INTENT_LIFECYCLE_EVIDENCE_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER listing_intent_lifecycle_immutable BEFORE UPDATE ON marketplace.listing_intent_deliveries
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_intent_lifecycle();
CREATE INDEX listing_intent_deliveries_lifecycle_due ON marketplace.listing_intent_deliveries(next_attempt_at,id)
  WHERE state='waiting_lifecycle' OR (state='blocked' AND lifecycle_checked_at IS NULL);

-- Completion checks only inspect attempts newer than an exact provider readback.
-- Keep this bounded by time rather than scanning immutable request history.
CREATE INDEX quantity_publication_attempts_completed_at_idx
  ON inventory.quantity_publication_attempts(completed_at) WHERE completed_at IS NOT NULL;
