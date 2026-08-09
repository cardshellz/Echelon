-- Preserve the source of every RMA item. Normal return items point to the
-- exact normalized order line; manual exceptions carry a required audit reason.

ALTER TABLE dropship.dropship_rma_items
  ADD COLUMN IF NOT EXISTS source varchar(30) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS order_line_index integer,
  ADD COLUMN IF NOT EXISTS external_line_item_id varchar(255),
  ADD COLUMN IF NOT EXISTS manual_description varchar(500),
  ADD COLUMN IF NOT EXISTS exception_reason text;

ALTER TABLE dropship.dropship_rma_items
  DROP CONSTRAINT IF EXISTS dropship_rma_item_source_chk,
  ADD CONSTRAINT dropship_rma_item_source_chk
    CHECK (source IN ('legacy', 'order', 'manual_exception')),
  DROP CONSTRAINT IF EXISTS dropship_rma_item_source_fields_chk,
  ADD CONSTRAINT dropship_rma_item_source_fields_chk CHECK (
    (source = 'legacy' AND order_line_index IS NULL)
    OR
    (source = 'order' AND order_line_index IS NOT NULL AND order_line_index >= 0
      AND exception_reason IS NULL)
    OR
    (source = 'manual_exception' AND order_line_index IS NULL
      AND (product_variant_id IS NOT NULL OR (manual_description IS NOT NULL
        AND length(btrim(manual_description)) > 0))
      AND exception_reason IS NOT NULL AND length(btrim(exception_reason)) > 0)
  );

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rma_item_order_line_idx
  ON dropship.dropship_rma_items(rma_id, order_line_index)
  WHERE source = 'order';

COMMENT ON COLUMN dropship.dropship_rma_items.source IS
  'legacy for pre-migration rows, order for a canonical intake line, manual_exception for an audited admin exception.';
COMMENT ON COLUMN dropship.dropship_rma_items.order_line_index IS
  'Zero-based line index in dropship_order_intake.normalized_payload.lines when source=order.';
COMMENT ON COLUMN dropship.dropship_rma_items.external_line_item_id IS
  'Marketplace line identifier captured from the normalized order line when available.';
COMMENT ON COLUMN dropship.dropship_rma_items.manual_description IS
  'Operator-entered item description for a manual exception without a catalog variant.';
COMMENT ON COLUMN dropship.dropship_rma_items.exception_reason IS
  'Required operator justification when source=manual_exception.';
