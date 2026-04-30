-- Dropship V2 auth identity foundation.
-- Supports cardshellz.io passkey-first login, password fallback, and email MFA
-- challenges for sensitive actions when no passkey is enrolled.

CREATE SCHEMA IF NOT EXISTS dropship;

CREATE TABLE IF NOT EXISTS dropship.dropship_auth_identities (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  member_id varchar(255) NOT NULL REFERENCES membership.members(id) ON DELETE CASCADE,
  primary_email varchar(255) NOT NULL,
  password_hash text,
  password_hash_algorithm varchar(40),
  password_updated_at timestamptz,
  last_card_shellz_proof_at timestamptz,
  passkey_enrolled_at timestamptz,
  status varchar(30) NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_auth_identity_status_chk CHECK (status IN ('active','locked','disabled')),
  CONSTRAINT dropship_auth_identity_password_chk CHECK (
    (password_hash IS NULL AND password_hash_algorithm IS NULL AND password_updated_at IS NULL)
    OR (password_hash IS NOT NULL AND password_hash_algorithm IS NOT NULL AND password_updated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_auth_identity_member_idx
  ON dropship.dropship_auth_identities(member_id);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_auth_identity_email_idx
  ON dropship.dropship_auth_identities(primary_email);

CREATE TABLE IF NOT EXISTS dropship.dropship_passkey_credentials (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  auth_identity_id integer NOT NULL REFERENCES dropship.dropship_auth_identities(id) ON DELETE CASCADE,
  member_id varchar(255) NOT NULL REFERENCES membership.members(id) ON DELETE CASCADE,
  credential_id varchar(512) NOT NULL,
  public_key text NOT NULL,
  sign_count integer NOT NULL DEFAULT 0,
  transports jsonb,
  aaguid varchar(80),
  backup_eligible boolean,
  backup_state boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT dropship_passkey_sign_count_chk CHECK (sign_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_passkey_credential_idx
  ON dropship.dropship_passkey_credentials(credential_id);
CREATE INDEX IF NOT EXISTS dropship_passkey_member_idx
  ON dropship.dropship_passkey_credentials(member_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_sensitive_action_challenges (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  member_id varchar(255) NOT NULL REFERENCES membership.members(id) ON DELETE CASCADE,
  action varchar(80) NOT NULL,
  method varchar(30) NOT NULL,
  challenge_hash varchar(255) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_sensitive_challenge_action_chk CHECK (action IN ('connect_store','disconnect_store','change_password','change_contact_email','add_funding_method','remove_funding_method','wallet_funding_high_value','bulk_listing_push','high_risk_order_acceptance')),
  CONSTRAINT dropship_sensitive_challenge_method_chk CHECK (method IN ('passkey','email_mfa')),
  CONSTRAINT dropship_sensitive_challenge_attempts_chk CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_sensitive_challenge_idem_idx
  ON dropship.dropship_sensitive_action_challenges(idempotency_key);
CREATE INDEX IF NOT EXISTS dropship_sensitive_challenge_member_idx
  ON dropship.dropship_sensitive_action_challenges(member_id, created_at);
