-- Migration 132: Bind automatic recommendation decisions to one immutable auto-draft run.

ALTER TABLE procurement.purchasing_recommendation_decisions
  DROP CONSTRAINT IF EXISTS purch_rec_decisions_auto_draft_run_chk;

ALTER TABLE procurement.purchasing_recommendation_decisions
  ADD CONSTRAINT purch_rec_decisions_auto_draft_run_chk
  CHECK (source <> 'auto_draft' OR auto_draft_run_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS purch_rec_decisions_auto_draft_run_rec_kind_decision_uidx
  ON procurement.purchasing_recommendation_decisions (
    auto_draft_run_id,
    recommendation_id,
    kind,
    decision
  )
  WHERE source = 'auto_draft'
    AND status = 'active'
    AND auto_draft_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION procurement.validate_purchasing_recommendation_po_handoff()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  accepted_decision TEXT;
  accepted_status TEXT;
  accepted_source TEXT;
  accepted_run_id INTEGER;
  handoff_decision TEXT;
  handoff_status TEXT;
  handoff_source TEXT;
  handoff_run_id INTEGER;
BEGIN
  SELECT decision, status, source, auto_draft_run_id
    INTO accepted_decision, accepted_status, accepted_source, accepted_run_id
  FROM procurement.purchasing_recommendation_decisions
  WHERE id = NEW.accepted_decision_id;

  IF NOT FOUND OR accepted_decision <> 'accepted_for_po' OR accepted_status <> 'active' THEN
    RAISE EXCEPTION 'accepted_decision_id must reference an active accepted_for_po decision'
      USING ERRCODE = '23514';
  END IF;

  SELECT decision, status, source, auto_draft_run_id
    INTO handoff_decision, handoff_status, handoff_source, handoff_run_id
  FROM procurement.purchasing_recommendation_decisions
  WHERE id = NEW.handoff_decision_id;

  IF NOT FOUND OR handoff_decision <> 'po_handoff_created' OR handoff_status <> 'active' THEN
    RAISE EXCEPTION 'handoff_decision_id must reference an active po_handoff_created decision'
      USING ERRCODE = '23514';
  END IF;

  IF accepted_source IS DISTINCT FROM handoff_source
     OR accepted_run_id IS DISTINCT FROM handoff_run_id THEN
    RAISE EXCEPTION 'accepted and handoff decisions must share source and auto-draft run provenance'
      USING ERRCODE = '23514';
  END IF;

  IF accepted_source = 'auto_draft' AND accepted_run_id IS NULL THEN
    RAISE EXCEPTION 'automatic recommendation handoffs require an auto-draft run'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
