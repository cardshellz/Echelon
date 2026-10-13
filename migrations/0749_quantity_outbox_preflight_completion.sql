-- A stock command rejected by its listing guard before HTTP is not an unknown
-- provider outcome. Preserve the attempt and require affirmative owner evidence
-- plus zero durable request records. Existing uncertain attempts are untouched.
-- Retains the reconciliation, terminal-response and eBay recovery guards from 0734.
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Provider attempts are retained permanently' USING ERRCODE='23514'; END IF;
  IF NEW.state='superseded_unknown' AND OLD.state IN ('running','uncertain') THEN
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
