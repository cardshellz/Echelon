-- Migration 091: Track accepted recommendation handoff into draft PO review.

ALTER TABLE procurement.purchasing_recommendation_decisions
  DROP CONSTRAINT IF EXISTS purchasing_recommendation_decisions_decision_chk;

ALTER TABLE procurement.purchasing_recommendation_decisions
  ADD CONSTRAINT purchasing_recommendation_decisions_decision_chk
  CHECK (decision IN ('reviewed', 'accepted_for_po', 'deferred', 'dismissed', 'po_handoff_created'));
