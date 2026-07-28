-- Persist provider label direction so return transport can never acquire
-- outbound fulfillment authority.

ALTER TABLE wms.shipping_provider_labels
  ADD COLUMN IF NOT EXISTS label_direction VARCHAR(20) NOT NULL DEFAULT 'outbound';

ALTER TABLE wms.shipping_provider_labels
  DROP CONSTRAINT IF EXISTS shipping_provider_labels_direction_chk;

ALTER TABLE wms.shipping_provider_labels
  ADD CONSTRAINT shipping_provider_labels_direction_chk
  CHECK (label_direction IN ('outbound', 'return'));

CREATE INDEX IF NOT EXISTS idx_shipping_provider_labels_direction_status
  ON wms.shipping_provider_labels (label_direction, label_status, first_observed_at);

-- Previous remediation code already writes provider_voided_label and
-- provider_package_echo. Keep those audited terminal classifications valid and
-- add the first-class return-label resolution.
ALTER TABLE wms.reconciliation_exceptions
  DROP CONSTRAINT IF EXISTS wms_reconciliation_exceptions_classification_chk;

ALTER TABLE wms.reconciliation_exceptions
  ADD CONSTRAINT wms_reconciliation_exceptions_classification_chk
  CHECK (classification IN (
    'safe_auto_repair',
    'manual_review',
    'hard_block',
    'historical_ignore',
    'provider_voided_label',
    'provider_package_echo',
    'provider_return_label'
  ));

COMMENT ON COLUMN wms.shipping_provider_labels.label_direction IS
  'Provider-declared transport direction. Return labels may be tracked but cannot authorize outbound fulfillment.';
