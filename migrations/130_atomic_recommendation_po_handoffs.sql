-- Migration 130: Atomically map each accepted recommendation decision to its PO line.

CREATE UNIQUE INDEX IF NOT EXISTS purch_rec_decisions_id_rec_kind_uidx
  ON procurement.purchasing_recommendation_decisions (id, recommendation_id, kind);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_lines_po_id_line_id_uidx
  ON procurement.purchase_order_lines (purchase_order_id, id);

CREATE TABLE IF NOT EXISTS procurement.purchasing_recommendation_po_handoffs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  accepted_decision_id INTEGER NOT NULL,
  handoff_decision_id INTEGER NOT NULL,
  purchase_order_id INTEGER NOT NULL,
  purchase_order_line_id INTEGER NOT NULL,
  recommendation_id VARCHAR(160) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT purchasing_recommendation_po_handoffs_distinct_decisions_chk
    CHECK (accepted_decision_id <> handoff_decision_id),
  CONSTRAINT purch_rec_po_handoff_accepted_decision_fk
    FOREIGN KEY (accepted_decision_id, recommendation_id, kind)
    REFERENCES procurement.purchasing_recommendation_decisions (id, recommendation_id, kind)
    ON DELETE RESTRICT,
  CONSTRAINT purch_rec_po_handoff_decision_fk
    FOREIGN KEY (handoff_decision_id, recommendation_id, kind)
    REFERENCES procurement.purchasing_recommendation_decisions (id, recommendation_id, kind)
    ON DELETE RESTRICT,
  CONSTRAINT purch_rec_po_handoff_po_line_fk
    FOREIGN KEY (purchase_order_id, purchase_order_line_id)
    REFERENCES procurement.purchase_order_lines (purchase_order_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS purch_rec_po_handoff_accepted_decision_uidx
  ON procurement.purchasing_recommendation_po_handoffs (accepted_decision_id);

CREATE UNIQUE INDEX IF NOT EXISTS purch_rec_po_handoff_decision_uidx
  ON procurement.purchasing_recommendation_po_handoffs (handoff_decision_id);

CREATE UNIQUE INDEX IF NOT EXISTS purch_rec_po_handoff_po_line_uidx
  ON procurement.purchasing_recommendation_po_handoffs (purchase_order_line_id);

CREATE INDEX IF NOT EXISTS purch_rec_po_handoff_po_idx
  ON procurement.purchasing_recommendation_po_handoffs (purchase_order_id);

CREATE INDEX IF NOT EXISTS purch_rec_po_handoff_rec_kind_idx
  ON procurement.purchasing_recommendation_po_handoffs (recommendation_id, kind);

CREATE OR REPLACE FUNCTION procurement.validate_purchasing_recommendation_po_handoff()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM procurement.purchasing_recommendation_decisions decision
    WHERE decision.id = NEW.accepted_decision_id
      AND decision.decision = 'accepted_for_po'
      AND decision.status = 'active'
  ) THEN
    RAISE EXCEPTION 'accepted_decision_id must reference an active accepted_for_po decision'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM procurement.purchasing_recommendation_decisions decision
    WHERE decision.id = NEW.handoff_decision_id
      AND decision.decision = 'po_handoff_created'
      AND decision.status = 'active'
  ) THEN
    RAISE EXCEPTION 'handoff_decision_id must reference an active po_handoff_created decision'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER purchasing_recommendation_po_handoff_validate_trg
  BEFORE INSERT ON procurement.purchasing_recommendation_po_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION procurement.validate_purchasing_recommendation_po_handoff();

CREATE OR REPLACE FUNCTION procurement.reject_purchasing_recommendation_po_handoff_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'purchasing recommendation PO handoffs are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER purchasing_recommendation_po_handoff_immutable_trg
  BEFORE UPDATE OR DELETE ON procurement.purchasing_recommendation_po_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION procurement.reject_purchasing_recommendation_po_handoff_mutation();
