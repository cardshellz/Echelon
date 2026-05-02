ALTER TABLE dropship.dropship_rmas
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(200),
  ADD COLUMN IF NOT EXISTS request_hash varchar(64);

ALTER TABLE dropship.dropship_sensitive_action_challenges
  DROP CONSTRAINT IF EXISTS dropship_sensitive_challenge_action_chk;

ALTER TABLE dropship.dropship_sensitive_action_challenges
  ADD CONSTRAINT dropship_sensitive_challenge_action_chk
  CHECK (action IN (
    'account_bootstrap',
    'connect_store',
    'disconnect_store',
    'change_password',
    'change_contact_email',
    'password_reset',
    'register_passkey',
    'add_funding_method',
    'remove_funding_method',
    'wallet_funding_high_value',
    'bulk_listing_push',
    'high_risk_order_acceptance',
    'manage_notification_preferences'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rma_idem_idx
  ON dropship.dropship_rmas(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE dropship.dropship_rma_inspections
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(200),
  ADD COLUMN IF NOT EXISTS request_hash varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rma_inspection_one_per_rma_idx
  ON dropship.dropship_rma_inspections(rma_id);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rma_inspection_idem_idx
  ON dropship.dropship_rma_inspections(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE dropship.dropship_notification_events
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(200),
  ADD COLUMN IF NOT EXISTS request_hash varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_notification_idem_channel_idx
  ON dropship.dropship_notification_events(idempotency_key, channel)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS dropship_notification_unread_idx
  ON dropship.dropship_notification_events(vendor_id, read_at, created_at)
  WHERE read_at IS NULL;
