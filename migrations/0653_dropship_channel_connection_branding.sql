-- Provider-neutral desired branding for customer-facing marketplace OAuth
-- consent screens. Rows are immutable state revisions; the provider adapter
-- determines whether a revision can be applied automatically or requires an
-- external provider-console action.

CREATE TABLE dropship.dropship_channel_connection_branding_revisions (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  platform varchar(30) NOT NULL,
  use_case varchar(80) NOT NULL,
  environment varchar(20) NOT NULL,
  revision integer NOT NULL,
  customer_facing_app_name varchar(200) NOT NULL,
  provider_resource_fingerprint varchar(64),
  provider_status varchar(40) NOT NULL,
  action varchar(40) NOT NULL,
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255),
  command_id integer NOT NULL REFERENCES dropship.dropship_admin_config_commands(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_channel_branding_platform_chk
    CHECK (platform IN ('ebay', 'shopify')),
  CONSTRAINT dropship_channel_branding_use_case_chk
    CHECK (btrim(use_case) <> ''),
  CONSTRAINT dropship_channel_branding_environment_chk
    CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT dropship_channel_branding_revision_chk
    CHECK (revision > 0),
  CONSTRAINT dropship_channel_branding_name_chk
    CHECK (
      btrim(customer_facing_app_name) <> ''
      AND char_length(customer_facing_app_name) <= 200
      AND customer_facing_app_name !~ '[[:cntrl:]]'
    ),
  CONSTRAINT dropship_channel_branding_provider_status_chk
    CHECK (provider_status IN (
      'pending_external_update',
      'manually_verified',
      'provider_applied',
      'provider_failed'
    )),
  CONSTRAINT dropship_channel_branding_provider_resource_chk
    CHECK (
      provider_resource_fingerprint IS NULL
      OR provider_resource_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT dropship_channel_branding_action_chk
    CHECK (action IN (
      'name_requested',
      'external_update_verified',
      'provider_update_applied',
      'provider_update_failed'
    )),
  CONSTRAINT dropship_channel_branding_action_status_chk
    CHECK (
      (action = 'name_requested' AND provider_status = 'pending_external_update')
      OR (action = 'external_update_verified' AND provider_status = 'manually_verified')
      OR (action = 'provider_update_applied' AND provider_status = 'provider_applied')
      OR (action = 'provider_update_failed' AND provider_status = 'provider_failed')
    ),
  CONSTRAINT dropship_channel_branding_verified_resource_chk
    CHECK (
      provider_status NOT IN ('manually_verified', 'provider_applied')
      OR provider_resource_fingerprint IS NOT NULL
    ),
  CONSTRAINT dropship_channel_branding_actor_chk
    CHECK (actor_type IN ('admin', 'system')),
  CONSTRAINT dropship_channel_branding_scope_revision_uq
    UNIQUE (platform, use_case, environment, revision),
  CONSTRAINT dropship_channel_branding_command_uq
    UNIQUE (command_id)
);

CREATE INDEX dropship_channel_branding_latest_idx
  ON dropship.dropship_channel_connection_branding_revisions(
    platform,
    use_case,
    environment,
    revision DESC
  );

CREATE OR REPLACE FUNCTION dropship.reject_channel_connection_branding_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'dropship_channel_connection_branding_revisions is append-only';
END;
$$;

CREATE TRIGGER dropship_channel_connection_branding_revisions_append_only
BEFORE UPDATE OR DELETE
ON dropship.dropship_channel_connection_branding_revisions
FOR EACH ROW
EXECUTE FUNCTION dropship.reject_channel_connection_branding_revision_mutation();

COMMENT ON TABLE dropship.dropship_channel_connection_branding_revisions IS
  'Immutable desired-state and provider-application history for names shown on marketplace OAuth consent screens.';

COMMENT ON COLUMN dropship.dropship_channel_connection_branding_revisions.provider_status IS
  'Provider application state. pending_external_update means Echelon saved the requested name but the provider console still controls the customer-facing consent title.';
