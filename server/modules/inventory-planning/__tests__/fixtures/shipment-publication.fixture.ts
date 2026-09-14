import type { CanonicalInventoryPublicationIntent } from "../../application/inventory-availability-runtime-publication.service";

export function shipmentPublicationIntent(quantity = "6"): CanonicalInventoryPublicationIntent {
  return {
    publicationTargetId: 5, publicationTargetRevision: "2", productVariantId: 105,
    sku: "EA", desiredQuantity: quantity, channelId: 3, channelName: "Shopify US",
    destinationKind: "channel_connection", channelConnectionId: 33, dropshipStoreConnectionId: null,
    providerKey: "shopify", providerScopeType: "location", externalScopeId: "location-1",
    externalInventoryItemId: "inventory-item-105", externalSku: "EA", sourceWarehouseIds: [1], blockerCodes: [],
  };
}

/** Real-query prerequisites, not a substitute for publication migration proof. */
export const shipmentPublicationFixtureSql = `
  CREATE SCHEMA channels;
  CREATE TABLE channels.sync_settings (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    singleton_key boolean NOT NULL UNIQUE CHECK (singleton_key),
    global_enabled boolean NOT NULL
  );
  INSERT INTO channels.sync_settings(singleton_key,global_enabled) VALUES(true,true);
  CREATE TABLE inventory.availability_activation_runs (
    id bigint PRIMARY KEY, mode text NOT NULL, state text NOT NULL,
    outbox_enqueued boolean NOT NULL DEFAULT false,
    provider_write_attempted boolean NOT NULL DEFAULT false, reason text NOT NULL DEFAULT 'test'
  );
  CREATE TABLE inventory.inventory_publication_targets (
    id integer PRIMARY KEY, revision bigint NOT NULL,
    destination_kind text NOT NULL, channel_id integer NOT NULL,
    channel_connection_id integer, dropship_store_connection_id integer,
    provider_scope_type text NOT NULL, external_scope_id text NOT NULL,
    publication_authority text NOT NULL, state text NOT NULL
  );
  INSERT INTO inventory.inventory_publication_targets(
    id,revision,destination_kind,channel_id,channel_connection_id,
    dropship_store_connection_id,provider_scope_type,external_scope_id,
    publication_authority,state
  ) VALUES(5,2,'channel_connection',3,33,NULL,'location','location-1','echelon','live');
  CREATE TABLE inventory.inventory_publication_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    activation_run_id bigint NOT NULL REFERENCES inventory.availability_activation_runs,
    publication_target_id integer NOT NULL, product_variant_id integer NOT NULL,
    desired_revision bigint NOT NULL, desired_quantity bigint NOT NULL CHECK (desired_quantity >= 0),
    destination_kind_snapshot text NOT NULL, channel_connection_id_snapshot integer,
    dropship_store_connection_id_snapshot integer, external_scope_id_snapshot text NOT NULL,
    external_inventory_item_id_snapshot text NOT NULL, publication_phase text NOT NULL,
    channel_id_snapshot integer NOT NULL, provider_key_snapshot text NOT NULL,
    provider_scope_type_snapshot text NOT NULL, external_sku_snapshot text,
    publication_target_revision_snapshot bigint NOT NULL, state text NOT NULL,
    idempotency_key text NOT NULL UNIQUE, payload_hash text NOT NULL, available_at timestamptz NOT NULL,
    lease_token text, lease_expires_at timestamptz, last_error_class text, last_error_message text,
    attempt_count integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
    acknowledged_at timestamptz, verified_at timestamptz,
    UNIQUE(publication_target_id, product_variant_id, desired_revision)
  );
  CREATE TABLE inventory.inventory_publication_attempts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, outbox_id bigint NOT NULL,
    attempt_number integer NOT NULL, outcome text NOT NULL, provider_request_key text NOT NULL,
    request_hash text NOT NULL, response_hash text, error_class text, error_message text,
    started_at timestamptz NOT NULL, completed_at timestamptz NOT NULL
  );
  CREATE TABLE inventory.inventory_publication_readbacks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, publication_target_id integer NOT NULL,
    product_variant_id integer NOT NULL, outbox_id bigint NOT NULL, observed_quantity bigint NOT NULL,
    matches_desired boolean NOT NULL, evidence_hash text NOT NULL,
    external_inventory_item_id_snapshot text NOT NULL, destination_kind_snapshot text NOT NULL,
    channel_connection_id_snapshot integer, dropship_store_connection_id_snapshot integer,
    provider_scope_type_snapshot text NOT NULL, external_scope_id_snapshot text NOT NULL,
    publication_target_revision_snapshot bigint NOT NULL, observed_at timestamptz NOT NULL
  );
`;
