-- Keep each bounded ShipStation shadow-audit page on its immutable ID keyset.
-- This index changes query access only; it does not change fulfillment authority
-- or enable the shadow job.

CREATE INDEX IF NOT EXISTS idx_shipping_provider_labels_shadow_scan
  ON wms.shipping_provider_labels (provider, id DESC);
