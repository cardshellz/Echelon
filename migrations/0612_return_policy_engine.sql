CREATE SCHEMA IF NOT EXISTS returns;

CREATE TABLE returns.return_policies (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(160) NOT NULL,
  scope_kind varchar(40) NOT NULL,
  scope_key varchar(255) NOT NULL,
  business_context varchar(30),
  channel_id integer REFERENCES channels.channels(id),
  vendor_id integer REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id),
  version integer NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  return_window_days integer NOT NULL,
  return_destination varchar(30) NOT NULL,
  approval_authority varchar(30) NOT NULL,
  label_provider varchar(30) NOT NULL,
  return_shipping_payer varchar(30) NOT NULL,
  inspection_requirement varchar(30) NOT NULL,
  inspection_owner varchar(30) NOT NULL,
  customer_refund_authority varchar(30) NOT NULL,
  vendor_settlement_trigger varchar(40) NOT NULL,
  returnless_refund_allowed boolean NOT NULL DEFAULT false,
  notes text,
  supersedes_policy_id integer REFERENCES returns.return_policies(id),
  created_by varchar(255) NOT NULL,
  retired_by varchar(255),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_policies_scope_kind_chk CHECK (scope_kind IN ('global','business_context','channel_context','vendor_context','vendor_channel_context','store')),
  CONSTRAINT return_policies_context_chk CHECK (business_context IS NULL OR business_context IN ('retail','dropship')),
  CONSTRAINT return_policies_status_chk CHECK (status IN ('active','retired')),
  CONSTRAINT return_policies_window_chk CHECK (return_window_days BETWEEN 0 AND 3650),
  CONSTRAINT return_policies_destination_chk CHECK (return_destination IN ('card_shellz','vendor','marketplace')),
  CONSTRAINT return_policies_approval_chk CHECK (approval_authority IN ('card_shellz','marketplace','vendor')),
  CONSTRAINT return_policies_label_chk CHECK (label_provider IN ('shipstation','marketplace','vendor','none')),
  CONSTRAINT return_policies_payer_chk CHECK (return_shipping_payer IN ('card_shellz','vendor','customer','marketplace','carrier')),
  CONSTRAINT return_policies_inspection_requirement_chk CHECK (inspection_requirement IN ('required','conditional','none')),
  CONSTRAINT return_policies_inspection_owner_chk CHECK (inspection_owner IN ('card_shellz','vendor','marketplace')),
  CONSTRAINT return_policies_refund_authority_chk CHECK (customer_refund_authority IN ('card_shellz','marketplace','vendor')),
  CONSTRAINT return_policies_settlement_trigger_chk CHECK (vendor_settlement_trigger IN ('inspection_approved','customer_refunded','carrier_claim_paid','none')),
  CONSTRAINT return_policies_scope_dimensions_chk CHECK (
    (scope_kind = 'global' AND business_context IS NULL AND channel_id IS NULL AND vendor_id IS NULL AND store_connection_id IS NULL)
    OR (scope_kind = 'business_context' AND business_context IS NOT NULL AND channel_id IS NULL AND vendor_id IS NULL AND store_connection_id IS NULL)
    OR (scope_kind = 'channel_context' AND business_context IS NOT NULL AND channel_id IS NOT NULL AND vendor_id IS NULL AND store_connection_id IS NULL)
    OR (scope_kind = 'vendor_context' AND business_context = 'dropship' AND channel_id IS NULL AND vendor_id IS NOT NULL AND store_connection_id IS NULL)
    OR (scope_kind = 'vendor_channel_context' AND business_context = 'dropship' AND channel_id IS NOT NULL AND vendor_id IS NOT NULL AND store_connection_id IS NULL)
    OR (scope_kind = 'store' AND business_context = 'dropship' AND channel_id IS NOT NULL AND vendor_id IS NOT NULL AND store_connection_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX return_policies_active_scope_uq ON returns.return_policies(scope_key) WHERE status = 'active';
CREATE UNIQUE INDEX return_policies_scope_version_uq ON returns.return_policies(scope_key, version);
CREATE INDEX return_policies_resolution_idx ON returns.return_policies(status, business_context, channel_id, vendor_id, store_connection_id);

CREATE TABLE returns.return_policy_commands (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key varchar(160) NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL,
  response jsonb NOT NULL,
  actor varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
