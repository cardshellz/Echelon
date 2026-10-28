import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { executeMigrationWithRetry, type MigrationRetryNotice } from "../../../../../migrations/migration-executor";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "./inventory-cutover-composition-database.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "./inventory-cutover-admission.fixture";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture } from "./walmart-publication-inventory.fixture";
import { calculatePublicationVariantMappingDefinitionHash } from "../../domain/inventory-channel-exposure";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";
import { PublicationMappingPreparationStore } from "../../infrastructure/publication-mapping-preparation.repository";
import type { StockLinkCheckClaim } from "../../infrastructure/stock-link-checks.repository";

/**
 * Channels PR2's stock-link migration (PLAN-CH2 v4.1 §3), found by its name, never by its number: the number is
 * allocated under the stand-in PR 99999 and changes when the file is adopted under the real one
 * (docs/migration-allocation.md). Exactly one file may carry the name.
 */
export const STOCK_LINKS_MIGRATION_SUFFIX = "_stock_links.sql";

export const STOCK_LINKS_MIGRATION_FILE: string = (() => {
  const matches = readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.endsWith(STOCK_LINKS_MIGRATION_SUFFIX));
  if (matches.length !== 1) throw new Error(`Expected exactly one migration ending in ${STOCK_LINKS_MIGRATION_SUFFIX}; found ${matches.length}.`);
  return matches[0]!;
})();

export function stockLinksMigrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", STOCK_LINKS_MIGRATION_FILE), "utf8");
}

/** The executor's options for one file; a case that holds a lock passes its own (shorter) lock timeout and attempts. */
export interface StockLinksMigrationRun {
  maxAttempts?: number;
  lockTimeoutMs?: number;
  onRetry?: (notice: MigrationRetryNotice) => void;
  sleep?: () => Promise<void>;
}

/** Applies one migration file the way the release does: through the release executor, in one transaction. */
export async function applyThroughReleaseExecutor(client: PoolClient, file: string, sql: string,
  run: StockLinksMigrationRun = {}): Promise<number> {
  const result = await executeMigrationWithRetry({
    client, file, sql, contentHash: createHash("sha256").update(sql).digest("hex"),
    options: { maxAttempts: run.maxAttempts ?? 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1, lockTimeoutMs: run.lockTimeoutMs ?? 15_000 },
    onRetry: run.onRetry ?? (() => undefined), sleep: run.sleep ?? (async () => undefined),
  });
  return result.attempts;
}

/** The Shopify channel, connection and location of PR1's real-outbox suite (channel-stock-update-dead-letter). */
export const STOCK_LINK_SHOPIFY = Object.freeze({ channelId: 35, connectionId: 7, location: "98765", productId: 20, variantId: 101 });

/**
 * A database of its own on PR1's real-outbox schema path: the reduced cutover composition base, the Walmart publication
 * inventory fixture with the quantity recovery migrations, an activated canonical runtime, the real admission fence
 * (236) and direct enable (0721), the Shopify channel active. The stock-link migration is applied through the release
 * executor unless `applyStockLinks` is false (the migration case applies it itself, under a held lock).
 */
export async function createStockLinkDatabase(options: { applyStockLinks?: boolean } = {}): Promise<InventoryCutoverTestDatabase> {
  const database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL,
    process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true", cutoverCompositionBaseSql);
  try {
    const { pool } = database;
    await installWalmartPublicationInventoryFixture(pool, { includeWalmartMapping: false, includeQuantityRecoveryMigrations: true });
    await activateWalmartPublicationInventoryFixture(pool);
    await installCutoverAdmissionFixturePrerequisites(pool);
    for (const file of ["236_inventory_cutover_admission.sql", "0721_inventory_publication_direct_enable.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    }
    await pool.query("UPDATE channels.channels SET status='active' WHERE id=$1", [STOCK_LINK_SHOPIFY.channelId]);
    // The release runner's ledger (public._migrations), as the executor writes it.
    await pool.query("CREATE TABLE IF NOT EXISTS public._migrations (filename text PRIMARY KEY, content_hash text NOT NULL)");
    if (options.applyStockLinks !== false) {
      const client = await pool.connect();
      try {
        await applyThroughReleaseExecutor(client, STOCK_LINKS_MIGRATION_FILE, stockLinksMigrationSql());
      } finally {
        client.release();
      }
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

/** One live Shopify location destination (numeric Shopify ids) with a sealed source binding, as PR1's suite creates it. */
export async function createLiveShopifyTarget(pool: Pool, options: { channelId?: number; connectionId?: number; location?: string } = {}): Promise<number> {
  const channelId = options.channelId ?? STOCK_LINK_SHOPIFY.channelId;
  const connectionId = options.connectionId ?? STOCK_LINK_SHOPIFY.connectionId;
  const location = options.location ?? STOCK_LINK_SHOPIFY.location;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = (await client.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,
      fulfillment_node_id,provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
      VALUES($1,$2,1,'location',$3,'echelon','disabled','Shopify warehouse location','fixture') RETURNING id`,
    [channelId, connectionId, location])).rows[0]!.id;
    // The binding head must be coherent at commit (deferred trigger): seal and activate it in this transaction.
    const binding = (await client.query<{ id: string }>(`INSERT INTO inventory.publication_source_binding_versions
      (publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES($1,1,repeat('b',64),'Shopify source',$2,repeat('b',64),'fixture') RETURNING id::text`,
    [id, `stock-link-binding-${connectionId}-${location}`])).rows[0]!;
    await client.query(`INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
      VALUES($1,$2,1,'fixture','Shopify source')`, [id, binding.id]);
    await client.query(`INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority)
      VALUES($1,$2,1,1)`, [binding.id, id]);
    await client.query("UPDATE inventory.publication_source_binding_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp() WHERE id=$1", [binding.id]);
    await client.query(`UPDATE inventory.publication_source_binding_heads SET active_binding_id=draft_binding_id,draft_binding_id=NULL,revision=revision+1
      WHERE publication_target_id=$1`, [id]);
    await client.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='fixture',
      activated_at=transaction_timestamp() WHERE id=$1`, [id]);
    await client.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [id]);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A Shopify feed of one size on the destination's channel: an active feed is what makes the size `publish`
 * (CH/channel-stock-selection.domain.ts). `quarantined` adds the selection's quarantine blocker. */
export async function addShopifyFeed(pool: Pool, productVariantId: number, inventoryItemId: string, options: {
  channelId?: number; sku?: string; quarantined?: boolean } = {}): Promise<void> {
  await pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active,quarantined_at)
    VALUES($1,$2,$3,$4,1,CASE WHEN $5 THEN transaction_timestamp() END)`,
  [options.channelId ?? STOCK_LINK_SHOPIFY.channelId, productVariantId, options.sku ?? `SKU-${productVariantId}`, inventoryItemId,
    options.quarantined === true]);
}

/** A first sealed link (version 1) of one size to one store item, sealed at `sealedAt` (default well before the suite's
 * clock) so a case can place the seal before or after the engine's injected clock. Returns the mapping id. */
export async function sealStockLink(pool: Pool, targetId: number, productVariantId: number, inventoryItemId: string, options: {
  /** null: a link saved without a store SKU (made before PR2, V6). */
  sku?: string | null; sealedAt?: string } = {}): Promise<number> {
  const sku = options.sku === undefined ? `SKU-${productVariantId}` : options.sku;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: targetId, productVariantId,
      externalInventoryItemId: inventoryItemId, externalSku: sku });
    const mapping = (await client.query<{ id: number }>(`INSERT INTO inventory.publication_variant_mapping_versions
      (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES($1,$2,1,$3,$4,$5,'Fixture store item',$6,$5,'fixture') RETURNING id`,
    [targetId, productVariantId, inventoryItemId, sku, hash, `stock-link-fixture-${targetId}-${productVariantId}`])).rows[0]!;
    await client.query(`INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
      VALUES($1,$2,$3,1,'fixture','Fixture store item')`, [targetId, productVariantId, mapping.id]);
    await client.query("UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=$2 WHERE id=$1",
      [mapping.id, options.sealedAt ?? "2026-10-01T00:00:00.000Z"]);
    await client.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=draft_mapping_id,draft_mapping_id=NULL,revision=revision+1
      WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, productVariantId]);
    await client.query("COMMIT");
    return mapping.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The engine's configuration transaction (PLAN-CH2 v4.1 §4.3 steps 1-2): the mapping-preparation store's READ COMMITTED
 * transaction with the canonical cutover fence held. The pair and scope locks of step 6 belong to the command (P4). */
export async function inStockLinkTransaction<T>(pool: Pool, work: (client: PoolClient, scopeKeys: string[]) => Promise<T>): Promise<T> {
  return new PublicationMappingPreparationStore(pool).transaction("configuration", async (client, scopeKeys) => {
    await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
    return work(client, scopeKeys);
  });
}

export interface StockLinkHeadRow { revision: string; active_mapping_id: number | null; draft_mapping_id: number | null }

export async function readStockLinkHead(pool: Pick<Pool, "query">, targetId: number, productVariantId: number): Promise<StockLinkHeadRow | null> {
  return (await pool.query<StockLinkHeadRow>(`SELECT revision::text,active_mapping_id,draft_mapping_id
    FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=$1 AND product_variant_id=$2`,
  [targetId, productVariantId])).rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// P4 (PLAN-CH2 v4.1 §4.3): what the engine's command reads beside the mapping tables.
// ---------------------------------------------------------------------------

/** The fixture Shopify store's own login (channel_connections id 7 of channel 35). */
export const STOCK_LINK_SHOPIFY_LOGIN = Object.freeze({ shopDomain: "card-shellz.myshopify.com", accessToken: "fixture-token-1" });

/** The fixture's reduced channel_connections has only (id, channel_id): add the Shopify login columns the Channels
 * source's connection fingerprint covers (CH/infrastructure/shopify-stock-link-source.ts reads them; CH's
 * shopifyStockLinkFingerprint is the one function the adapter and the source share, P6). */
export async function installStockLinkConnectionColumns(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`ALTER TABLE channels.channel_connections ADD COLUMN IF NOT EXISTS shop_domain text,
      ADD COLUMN IF NOT EXISTS access_token text, ADD COLUMN IF NOT EXISTS shopify_location_id text`);
  await pool.query("UPDATE channels.channel_connections SET shop_domain=$1, access_token=$2, shopify_location_id=$3 WHERE id=$4",
    [STOCK_LINK_SHOPIFY_LOGIN.shopDomain, STOCK_LINK_SHOPIFY_LOGIN.accessToken, STOCK_LINK_SHOPIFY.location, STOCK_LINK_SHOPIFY.connectionId]);
}

/** The destination row the tick sets up (§7.2 step 1): switch on unless a case turns it off or halts it. */
export async function seedStockLinkDestination(pool: Pick<Pool, "query">, targetId: number, at: string,
  options: { autoLinkEnabled?: boolean; halted?: boolean } = {}): Promise<void> {
  await pool.query(`INSERT INTO inventory.stock_link_destinations(publication_target_id, auto_link_enabled, halted_at, halted_code,
    created_at, updated_at) VALUES($1, $2, CASE WHEN $3 THEN $4::timestamptz END, CASE WHEN $3 THEN 'STOCK_LINK_UNCLASSIFIED' END, $4, $4)
    ON CONFLICT (publication_target_id) DO UPDATE SET auto_link_enabled=EXCLUDED.auto_link_enabled, halted_at=EXCLUDED.halted_at,
      halted_code=EXCLUDED.halted_code, revision=stock_link_destinations.revision+1, updated_at=EXCLUDED.updated_at`,
  [targetId, options.autoLinkEnabled ?? true, options.halted === true, at]);
}

let fixtureLeaseSequence = 0;

/** The tick's claim of one size's check row (§7.2 step 4): the row (inserted if new, made claimable if stopped) gets a
 * fresh lease and revision + 1, as the claim writes them. `updated_at` is left as it was (D-P2-11's wait interval). */
export async function claimStockLinkCheck(pool: Pick<Pool, "query">, targetId: number, productVariantId: number, at: string,
  options: { status?: "waiting" | "linked" | "flagged"; reasonCode?: string | null } = {}): Promise<StockLinkCheckClaim> {
  fixtureLeaseSequence += 1;
  const leaseToken = `00000000-0000-4000-8000-${String(fixtureLeaseSequence).padStart(12, "0")}`;
  const status = options.status ?? "waiting";
  const reasonCode = options.reasonCode === undefined ? (status === "flagged" ? "STOCK_LINK_SKU_DUPLICATE" : null) : options.reasonCode;
  const row = (await pool.query<{ revision: string }>(`INSERT INTO inventory.stock_link_checks(publication_target_id, product_variant_id,
      status, reason_code, next_check_at, lease_token, lease_expires_at, created_at, updated_at)
    VALUES($1, $2, $3, $4, $5::timestamptz, $6, $5::timestamptz + interval '5 minutes', $5, $5)
    ON CONFLICT (publication_target_id, product_variant_id) DO UPDATE SET status=EXCLUDED.status, reason_code=EXCLUDED.reason_code,
      error_class=NULL, next_check_at=COALESCE(stock_link_checks.next_check_at, EXCLUDED.next_check_at),
      lease_token=EXCLUDED.lease_token, lease_expires_at=EXCLUDED.lease_expires_at, revision=stock_link_checks.revision+1
    RETURNING revision::text`, [targetId, productVariantId, status, reasonCode, at, leaseToken])).rows[0]!;
  return { productVariantId, leaseToken, revision: row.revision };
}

export interface StockLinkCheckRow {
  status: string; reason_code: string | null; error_class: string | null; attempt_count: number; first_failure_at: Date | null;
  busy_since: Date | null; next_check_at: Date | null; lease_token: string | null; revision: string; waiting_item_id: string | null;
  observed_sku: string | null; message: string | null;
}

export async function readStockLinkCheck(pool: Pick<Pool, "query">, targetId: number, productVariantId: number): Promise<StockLinkCheckRow | null> {
  return (await pool.query<StockLinkCheckRow>(`SELECT status, reason_code, error_class, attempt_count, first_failure_at, busy_since,
      next_check_at, lease_token::text, revision::text, waiting_item_id, observed_sku, message
    FROM inventory.stock_link_checks WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, productVariantId])).rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// P7 (PLAN-CH2 v4.1 §7.2): what the tick's discovery reads through the Channels source (CH/infrastructure/
// shopify-stock-link-source.ts): the production columns of products, feeds and listings that the reduced fixture
// schema leaves out (types as shared/schema/catalog.schema.ts and channels.schema.ts declare them, the same reduced DDL
// as the source's own PG suite).
// ---------------------------------------------------------------------------

export async function installStockLinkTickColumns(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'active';
    ALTER TABLE channels.channel_feeds ADD COLUMN IF NOT EXISTS channel_variant_id varchar(100),
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS channels.channel_listings(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer NOT NULL,
      product_variant_id integer,external_product_id varchar(100),external_variant_id varchar(100),external_sku varchar(100),
      UNIQUE(channel_id,product_variant_id))`);
}
