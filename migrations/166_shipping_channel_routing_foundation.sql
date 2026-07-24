-- Canonical channel shipping routing (compatibility expansion phase).
--
-- This migration is intentionally additive and seeds no policy rows. Existing
-- shipping-channel profiles and string-keyed rate-book assignments remain the
-- runtime authority until a later shadow comparison and explicit cutover.

CREATE TABLE shipping.destination_scopes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  metadata JSONB,
  created_by VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_destination_scope_status_chk
    CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT shipping_destination_scope_code_chk
    CHECK (
      code = btrim(code)
      AND code ~ '^[a-z0-9][a-z0-9-]{0,99}$'
    ),
  CONSTRAINT shipping_destination_scope_actor_chk
    CHECK (created_by = btrim(created_by) AND created_by <> '')
);

CREATE UNIQUE INDEX shipping_destination_scope_code_idx
  ON shipping.destination_scopes(code);

CREATE TABLE shipping.destination_scope_members (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  destination_scope_id INTEGER NOT NULL
    REFERENCES shipping.destination_scopes(id) ON DELETE CASCADE,
  destination_country VARCHAR(2) NOT NULL,
  destination_region VARCHAR(10),
  postal_prefix VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_destination_scope_member_country_chk
    CHECK (destination_country ~ '^[A-Z]{2}$'),
  CONSTRAINT shipping_destination_scope_member_region_chk
    CHECK (
      destination_region IS NULL
      OR destination_region ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
    ),
  CONSTRAINT shipping_destination_scope_member_postal_chk
    CHECK (
      postal_prefix IS NULL
      OR (
        postal_prefix = btrim(postal_prefix)
        AND postal_prefix ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
      )
    )
);

CREATE UNIQUE INDEX shipping_destination_scope_member_idx
  ON shipping.destination_scope_members(
    destination_scope_id,
    destination_country,
    COALESCE(destination_region, ''),
    COALESCE(postal_prefix, '')
  );

CREATE INDEX shipping_destination_scope_member_lookup_idx
  ON shipping.destination_scope_members(
    destination_country,
    destination_region,
    postal_prefix,
    destination_scope_id
  );

CREATE TABLE shipping.channel_policies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL
    REFERENCES channels.channels(id) ON DELETE RESTRICT,
  purpose VARCHAR(60) NOT NULL,
  version INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  metadata JSONB,
  created_by VARCHAR(200) NOT NULL,
  activated_by VARCHAR(200),
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_channel_policy_purpose_chk
    CHECK (purpose IN ('customer_checkout', 'vendor_fulfillment_charge')),
  CONSTRAINT shipping_channel_policy_status_chk
    CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT shipping_channel_policy_version_chk
    CHECK (version > 0),
  CONSTRAINT shipping_channel_policy_actor_chk
    CHECK (
      created_by = btrim(created_by)
      AND created_by <> ''
      AND (
        activated_by IS NULL
        OR (activated_by = btrim(activated_by) AND activated_by <> '')
      )
    ),
  CONSTRAINT shipping_channel_policy_lifecycle_chk
    CHECK (
      (
        status = 'draft'
        AND activated_by IS NULL
        AND activated_at IS NULL
        AND retired_at IS NULL
      )
      OR (
        status = 'active'
        AND activated_by IS NOT NULL
        AND activated_at IS NOT NULL
        AND retired_at IS NULL
      )
      OR (
        status = 'retired'
        AND activated_by IS NOT NULL
        AND activated_at IS NOT NULL
        AND retired_at IS NOT NULL
        AND retired_at >= activated_at
      )
    )
);

CREATE UNIQUE INDEX shipping_channel_policy_version_idx
  ON shipping.channel_policies(channel_id, purpose, version);

CREATE UNIQUE INDEX shipping_channel_policy_active_idx
  ON shipping.channel_policies(channel_id, purpose)
  WHERE status = 'active';

CREATE INDEX shipping_channel_policy_lookup_idx
  ON shipping.channel_policies(channel_id, purpose, status);

CREATE TABLE shipping.channel_policy_routes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy_id INTEGER NOT NULL
    REFERENCES shipping.channel_policies(id) ON DELETE CASCADE,
  source_destination_scope_id INTEGER
    REFERENCES shipping.destination_scopes(id) ON DELETE RESTRICT,
  origin_warehouse_id INTEGER
    REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  mode VARCHAR(30) NOT NULL,
  eligibility_mode VARCHAR(30) NOT NULL,
  rate_book_id INTEGER
    REFERENCES shipping.rate_books(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_channel_policy_route_mode_chk
    CHECK (mode IN ('engine_quoted', 'channel_managed', 'disabled')),
  CONSTRAINT shipping_channel_policy_route_eligibility_chk
    CHECK (eligibility_mode IN ('engine', 'channel', 'intersection', 'none')),
  CONSTRAINT shipping_channel_policy_route_rate_book_chk
    CHECK (
      (
        mode = 'engine_quoted'
        AND rate_book_id IS NOT NULL
        AND eligibility_mode <> 'none'
      )
      OR (
        mode = 'channel_managed'
        AND rate_book_id IS NULL
        AND eligibility_mode <> 'none'
      )
      OR (
        mode = 'disabled'
        AND rate_book_id IS NULL
        AND eligibility_mode = 'none'
      )
    )
);

CREATE UNIQUE INDEX shipping_channel_policy_route_scope_idx
  ON shipping.channel_policy_routes(
    policy_id,
    COALESCE(origin_warehouse_id, 0),
    COALESCE(source_destination_scope_id, 0)
  );

CREATE INDEX shipping_channel_policy_route_lookup_idx
  ON shipping.channel_policy_routes(
    policy_id,
    origin_warehouse_id,
    source_destination_scope_id
  );

CREATE TABLE shipping.channel_policy_route_destinations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id INTEGER NOT NULL
    REFERENCES shipping.channel_policy_routes(id) ON DELETE CASCADE,
  destination_country VARCHAR(2) NOT NULL,
  destination_region VARCHAR(10),
  postal_prefix VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_channel_policy_route_destination_country_chk
    CHECK (destination_country ~ '^[A-Z]{2}$'),
  CONSTRAINT shipping_channel_policy_route_destination_region_chk
    CHECK (
      destination_region IS NULL
      OR destination_region ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
    ),
  CONSTRAINT shipping_channel_policy_route_destination_postal_chk
    CHECK (
      postal_prefix IS NULL
      OR (
        postal_prefix = btrim(postal_prefix)
        AND postal_prefix ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
      )
    )
);

CREATE UNIQUE INDEX shipping_channel_policy_route_destination_idx
  ON shipping.channel_policy_route_destinations(
    route_id,
    destination_country,
    COALESCE(destination_region, ''),
    COALESCE(postal_prefix, '')
  );

CREATE INDEX shipping_channel_policy_route_destination_lookup_idx
  ON shipping.channel_policy_route_destinations(
    destination_country,
    destination_region,
    postal_prefix,
    route_id
  );

COMMENT ON TABLE shipping.destination_scopes IS
  'Reusable country, region, and postal-prefix destination definitions for channel routing.';
COMMENT ON TABLE shipping.channel_policies IS
  'Versioned channel and business-purpose shipping authority policies; activation is atomic per channel and purpose.';
COMMENT ON TABLE shipping.channel_policy_routes IS
  'Warehouse and destination-specific engine-quoted, channel-managed, or disabled decisions within one policy revision.';
COMMENT ON TABLE shipping.channel_policy_route_destinations IS
  'Frozen destination membership copied into a policy route so reusable scope edits cannot change an active revision.';
