-- Healthy top-offs (Order Builder): a healthy, analyzable SKU's accepted
-- recommendation carries a ZERO-piece baseline (the engine suggests nothing),
-- so every top-off quantity exceeds it and must record the migration-177
-- override-evidence pair. Migration 177's CHECK additionally required the
-- baseline itself to be positive, which made zero-baseline evidence
-- unrepresentable and blocked the owner's MOQ / free-freight top-off flow.
--
-- Relax ONLY the baseline floor (> 0 becomes >= 0). Everything else is
-- unchanged: evidence is all-or-nothing, allowed only when the requested
-- quantity strictly exceeds the baseline, and always names an approver, a
-- reason (>= 3 chars), and a timestamp. Existing rows satisfy the widened
-- constraint by construction (every baseline written so far is positive).

ALTER TABLE procurement.purchasing_recommendation_po_handoffs
  DROP CONSTRAINT IF EXISTS purch_rec_po_handoff_qty_override_evidence_chk;

ALTER TABLE procurement.purchasing_recommendation_po_handoffs
  ADD CONSTRAINT purch_rec_po_handoff_qty_override_evidence_chk
  CHECK (
    (
      quantity_override_baseline_pieces IS NULL
      AND quantity_override_requested_pieces IS NULL
      AND quantity_override_reason IS NULL
      AND quantity_override_approved_by IS NULL
      AND quantity_override_approved_at IS NULL
    )
    OR (
      quantity_override_baseline_pieces >= 0
      AND quantity_override_requested_pieces > quantity_override_baseline_pieces
      AND NULLIF(BTRIM(quantity_override_reason), '') IS NOT NULL
      AND LENGTH(BTRIM(quantity_override_reason)) >= 3
      AND NULLIF(BTRIM(quantity_override_approved_by), '') IS NOT NULL
      AND quantity_override_approved_at IS NOT NULL
    )
  );

-- Rows remain append-only: migration 130's
-- purchasing_recommendation_po_handoff_immutable_trg still rejects every
-- UPDATE and DELETE, so override evidence can never be revised after insert.
