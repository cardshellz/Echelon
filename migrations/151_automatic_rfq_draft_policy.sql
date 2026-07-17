ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS rfq_draft_automation_mode VARCHAR(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS rfq_draft_minimum_confidence VARCHAR(10) NOT NULL DEFAULT 'high',
  ADD COLUMN IF NOT EXISTS rfq_draft_require_trusted_forecast BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS rfq_draft_maximum_lines_per_run INTEGER NOT NULL DEFAULT 100;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_settings_rfq_draft_automation_chk' AND conrelid = 'inventory.warehouse_settings'::regclass) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_rfq_draft_automation_chk
      CHECK (
        rfq_draft_automation_mode IN ('manual', 'preferred_vendor')
        AND rfq_draft_minimum_confidence IN ('high', 'medium')
        AND rfq_draft_maximum_lines_per_run BETWEEN 1 AND 500
      );
  END IF;
END $$;

COMMENT ON COLUMN inventory.warehouse_settings.rfq_draft_automation_mode IS
  'Controls automatic creation of draft-only RFQs. Automatic sending is intentionally unsupported.';
COMMENT ON COLUMN inventory.warehouse_settings.rfq_draft_minimum_confidence IS
  'Minimum demand-and-lead-time confidence allowed for automatic RFQ drafting; supplier price gaps do not reduce it.';
COMMENT ON COLUMN inventory.warehouse_settings.rfq_draft_require_trusted_forecast IS
  'When true, only forecast-trust severity ok can produce an automatic RFQ draft.';

