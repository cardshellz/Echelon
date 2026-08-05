-- A provider list response may omit isReturnLabel. An omitted value is not
-- outbound authority: it stays non-dispatchable until a detail read confirms
-- whether the provider label is outbound or return transport.

ALTER TABLE wms.shipping_provider_labels
  DROP CONSTRAINT IF EXISTS shipping_provider_labels_direction_chk;

ALTER TABLE wms.shipping_provider_labels
  ADD CONSTRAINT shipping_provider_labels_direction_chk
  CHECK (label_direction IN ('outbound', 'return', 'unknown'));

COMMENT ON COLUMN wms.shipping_provider_labels.label_direction IS
  'Provider-declared transport direction. unknown and return labels cannot authorize outbound fulfillment.';