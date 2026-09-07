-- Test-owned schema only; setup-integration requires an explicitly disposable DB.
CREATE TABLE channels.channel_connections (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  shop_domain varchar(255), access_token text, refresh_token text, webhook_secret varchar(255),
  api_version varchar(20), scopes text, shopify_location_id varchar(50), expires_at timestamp,
  last_sync_at timestamp, sync_status varchar(20) DEFAULT 'never', sync_error text, metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (id, channel_id)
);
CREATE TABLE channels.channel_feeds (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer REFERENCES channels.channels(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  channel_type varchar(30) NOT NULL DEFAULT 'shopify', channel_variant_id varchar(100) NOT NULL,
  channel_product_id varchar(100), channel_sku varchar(100), channel_inventory_item_id varchar(100),
  is_active integer NOT NULL DEFAULT 1, last_synced_at timestamp, last_synced_qty integer,
  consecutive_push_failures integer NOT NULL DEFAULT 0, quarantined_at timestamp, quarantine_reason text,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, product_variant_id)
);
CREATE TABLE channels.channel_listings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  external_product_id varchar(100), external_variant_id varchar(100), external_sku varchar(100), external_url text,
  last_synced_qty integer, last_synced_price bigint, last_synced_at timestamp,
  sync_status varchar(20) DEFAULT 'pending', sync_error text,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, product_variant_id)
);
CREATE TABLE IF NOT EXISTS public.audit_events (
  id bigserial PRIMARY KEY, timestamp timestamptz NOT NULL DEFAULT now(), level text NOT NULL DEFAULT 'AUDIT',
  actor text NOT NULL, action text NOT NULL, target text, changes jsonb, context jsonb
);
-- This suite exercises the publication owner's read/lock contract, not activation.
-- The full publication schema/constraints have a separate foundation integration suite.
CREATE TABLE inventory.availability_runtime_authority (
  singleton_key boolean PRIMARY KEY DEFAULT true CHECK(singleton_key),
  authority varchar(20) NOT NULL DEFAULT 'legacy' CHECK(authority IN ('legacy', 'canonical'))
);
CREATE TABLE inventory.inventory_publication_targets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  state varchar(20) NOT NULL DEFAULT 'disabled' CHECK(state IN ('disabled', 'active'))
);
