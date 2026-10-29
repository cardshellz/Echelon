import { readFile } from "node:fs/promises";
import { createInventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

export const CONNECTION_MIGRATION = "migrations/900000037000019410001_shopify_product_connections.sql";

// Catalog's named-schema fixture supplies real inventory/order contracts. Only
// the additional source tables used by this connection owner are supplied here.
const connectionSources = `
CREATE SCHEMA membership;
CREATE TABLE catalog.shipping_groups(id int PRIMARY KEY,code text NOT NULL);
CREATE TABLE channels.channel_connections(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id int NOT NULL REFERENCES channels.channels(id),
  shop_domain text,access_token text,api_version text,UNIQUE(id,channel_id));
CREATE TABLE channels.channel_product_identities(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id int NOT NULL REFERENCES channels.channels(id),
  product_id int NOT NULL REFERENCES catalog.products(id),external_product_id text NOT NULL,created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(channel_id,product_id),UNIQUE(channel_id,external_product_id));
CREATE TABLE channels.channel_feeds(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id int NOT NULL REFERENCES channels.channels(id),
  product_variant_id int NOT NULL REFERENCES catalog.product_variants(id),channel_type text NOT NULL DEFAULT 'shopify',
  channel_product_id text,channel_variant_id text,channel_inventory_item_id text,channel_sku text,is_active int NOT NULL DEFAULT 1,
  consecutive_push_failures int NOT NULL DEFAULT 0,quarantined_at timestamp,quarantine_reason text,
  last_synced_at timestamp,last_synced_qty int,created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE channels.channel_listings(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id int NOT NULL REFERENCES channels.channels(id),
  product_variant_id int NOT NULL REFERENCES catalog.product_variants(id),external_product_id text,external_variant_id text,external_sku text,external_url text,
  sync_status text NOT NULL DEFAULT 'pending',sync_error text,last_synced_at timestamp,last_synced_qty int,last_synced_price bigint,created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE channels.channel_pricing(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id int NOT NULL REFERENCES channels.channels(id),
  product_variant_id int REFERENCES catalog.product_variants(id),price bigint NOT NULL,compare_at_price bigint,cost bigint,
  currency varchar(3) NOT NULL DEFAULT 'USD',created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(channel_id,product_variant_id));
CREATE TABLE catalog.product_assets(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,product_id int NOT NULL REFERENCES catalog.products(id),
  product_variant_id int REFERENCES catalog.product_variants(id),asset_type text NOT NULL DEFAULT 'image',url text,alt_text text,
  position int NOT NULL DEFAULT 0,is_primary int NOT NULL DEFAULT 0,storage_type text NOT NULL DEFAULT 'url',mime_type text,file_data bytea);
CREATE TABLE membership.shopify_metafield_outbox(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,target_type text,target_id text,
  namespace text,key text,value jsonb,operation text,dedupe_key text,status text NOT NULL DEFAULT 'pending',scheduled_for timestamptz,
  attempts int NOT NULL DEFAULT 0,last_error text);
CREATE UNIQUE INDEX metafield_pending_key ON membership.shopify_metafield_outbox(dedupe_key) WHERE status='pending';
CREATE TABLE public.audit_events(id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL DEFAULT now(),level text NOT NULL DEFAULT 'AUDIT',
  actor text NOT NULL,action text NOT NULL,target text,changes jsonb,context jsonb);
INSERT INTO channels.channels(id,name,provider,status,is_default) OVERRIDING SYSTEM VALUE VALUES(7,'Shopify','shopify','active',1),(8,'Shopify second store','shopify','active',0);
INSERT INTO channels.channel_connections(id,channel_id,shop_domain,access_token,api_version) OVERRIDING SYSTEM VALUE
  VALUES(9,7,'test-store.myshopify.com','private-token',NULL),(10,8,'second-store.myshopify.com','second-token','2026-01');
`;

export async function createProductConnectionTestDatabase() {
  const base = await readFile("test/fixtures/named-schema-integration.sql", "utf8");
  const database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL,
    process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true", base + connectionSources);
  try {
    await database.pool.query(await readFile(CONNECTION_MIGRATION, "utf8"));
    return database;
  } catch (error) { await database.close(); throw error; }
}

/** Install the unchanged real gate function and its feed transition trigger;
 * unrelated publication planners are outside this owner's test schema. */
export async function installProductConnectionSelectionGate(pool: { query(text: string): Promise<unknown> }) {
  const migration = await readFile("migrations/0743_publication_selection_work.sql", "utf8");
  const start = migration.indexOf("CREATE FUNCTION inventory.gate_publication_selection_change()");
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < start) throw new Error("Real publication selection gate source not found");
  await pool.query(migration.slice(start, end + 4));
  await pool.query(`CREATE TRIGGER connection_selection_gate BEFORE UPDATE OF is_active ON channels.channel_feeds
    FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active) EXECUTE FUNCTION inventory.gate_publication_selection_change()`);
}
