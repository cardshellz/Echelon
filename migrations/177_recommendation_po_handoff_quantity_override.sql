-- The Order Builder may hand an accepted recommendation off to a purchase
-- order at an edited quantity. The accepted recommendation decision stays
-- immutable; the handoff row records the attributable approval evidence
-- whenever the requested quantity EXCEEDS the accepted baseline. Reductions
-- need no evidence (the PO line quantity plus the immutable accepted snapshot
-- already establish the delta). The evidence shape mirrors migration 158's
-- RFQ allocation-override contract: all-null, or fully evidenced.

ALTER TABLE procurement.purchasing_recommendation_po_handoffs
  ADD COLUMN IF NOT EXISTS quantity_override_baseline_pieces INTEGER,
  ADD COLUMN IF NOT EXISTS quantity_override_requested_pieces INTEGER,
  ADD COLUMN IF NOT EXISTS quantity_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS quantity_override_approved_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS quantity_override_approved_at TIMESTAMP WITHOUT TIME ZONE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'purch_rec_po_handoff_qty_override_evidence_chk'
       AND conrelid = 'procurement.purchasing_recommendation_po_handoffs'::regclass
  ) THEN
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
          quantity_override_baseline_pieces > 0
          AND quantity_override_requested_pieces > quantity_override_baseline_pieces
          AND NULLIF(BTRIM(quantity_override_reason), '') IS NOT NULL
          AND LENGTH(BTRIM(quantity_override_reason)) >= 3
          AND NULLIF(BTRIM(quantity_override_approved_by), '') IS NOT NULL
          AND quantity_override_approved_at IS NOT NULL
        )
      );
  END IF;
END $$;

-- Rows remain append-only: migration 130's
-- purchasing_recommendation_po_handoff_immutable_trg already rejects every
-- UPDATE and DELETE, so override evidence can never be revised after insert.
