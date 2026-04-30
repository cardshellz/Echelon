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
    'add_funding_method',
    'remove_funding_method',
    'wallet_funding_high_value',
    'bulk_listing_push',
    'high_risk_order_acceptance'
  ));
