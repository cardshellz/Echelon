import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { listingMemberIdentitySchema } from "@shared/types/listing-member-lifecycle";
import { canonicalJson } from "@shared/utils/canonical-json";
import { installStockSelectionFixture } from "../../../inventory-planning/__tests__/fixtures/stock-selection.fixture";

export const listingMemberBaseSql = `CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA dropship;
  CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text);
  CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer,shop_domain text,metadata jsonb,access_token text,api_version text);
  CREATE TABLE channels.walmart_connections(connection_id integer,partner_id text,environment text,market text);
  CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products(id),sku text,uom_type text,
    is_active boolean,requires_shipping boolean,track_inventory boolean,sales_eligibility text,updated_at timestamptz DEFAULT now());
  CREATE TABLE dropship.dropship_store_connections(id integer PRIMARY KEY,vendor_id integer,platform text,shop_domain text,
    external_account_id text,provider_environment text,status text);
  CREATE TABLE dropship.dropship_vendor_listings(id integer PRIMARY KEY,vendor_id integer,store_connection_id integer,product_variant_id integer,
    external_listing_id text,external_offer_id text);
  CREATE TABLE dropship.dropship_listing_push_jobs(id integer PRIMARY KEY,vendor_id integer,store_connection_id integer);
  CREATE TABLE dropship.dropship_listing_push_job_items(id integer PRIMARY KEY,job_id integer,listing_id integer,product_variant_id integer,
    action text,status text,result jsonb);`;

export async function installListingMemberLifecycleFixture(pool: Pool, options: { includeAliasMigration?: boolean } = {}) {
  await installStockSelectionFixture(pool);
  await pool.query(`ALTER TABLE channels.channel_feeds ADD COLUMN channel_product_id text;
    CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer,environment text,external_account_id text,
      external_account_identity_scheme text,external_account_verified_at timestamptz);`);
  for (const file of ["0707_channel_listing_publication.sql", "0724_channel_listing_updates.sql",
    "259_channel_listing_lifecycle.sql", "0748_walmart_listing_presence.sql",
    "900000013000018480001_shared_listing_member_lifecycle.sql", "900000022000018880002_listing_member_recovery.sql",
    ...(options.includeAliasMigration === false ? [] : ["900000057000020020002_listing_member_identity_aliases.sql"])])
    await pool.query(readFileSync(resolve("migrations", file), "utf8"));
}

/** Construct persisted pre-cutover archive requests, including the historical
 * malformed-identity diagnostic shape. The application no longer creates them. */
export async function seedLegacyRetirements(pool: Pool, now: Date, limit: number) {
  const client = await pool.connect();
  try {
    const sources = (await client.query<{ identity: unknown; source_revision: string }>(`SELECT s.identity,s.source_revision
      FROM marketplace.listing_member_retirement_sources s WHERE NOT EXISTS(SELECT 1 FROM marketplace.listing_member_retirements r
        WHERE md5(r.source_identity::text)=md5(s.identity::text) AND r.source_identity=s.identity AND r.source_revision=s.source_revision)
      ORDER BY s.product_variant_id,s.identity::text LIMIT $1`, [limit])).rows;
    for (const source of sources) {
      const parsed = listingMemberIdentitySchema.safeParse(source.identity);
      let identity = parsed.success ? parsed.data : null;
      let invalidMessage: string | null = null;
      if (!parsed.success) {
        const local = listingMemberIdentitySchema.pick({ destinationKind: true, connectionId: true, channelId: true,
          vendorId: true, productId: true, productVariantId: true }).passthrough().parse(source.identity);
        const field = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
          const result = schema.safeParse(value); return result.success ? result.data : fallback;
        };
        const shape = listingMemberIdentitySchema.shape;
        identity = listingMemberIdentitySchema.parse({ destinationKind: local.destinationKind, connectionId: local.connectionId,
          channelId: local.channelId, vendorId: local.vendorId, productId: local.productId, productVariantId: local.productVariantId,
          provider: field(shape.provider, local.provider, "invalid"), accountId: field(shape.accountId, local.accountId, null),
          environment: field(shape.environment, local.environment, "production"), market: field(shape.market, local.market, "invalid"),
          externalSku: field(shape.externalSku, local.externalSku, null), externalProductId: field(shape.externalProductId, local.externalProductId, null),
          externalVariantId: field(shape.externalVariantId, local.externalVariantId, null),
          externalInventoryItemId: field(shape.externalInventoryItemId, local.externalInventoryItemId, null), identityConflict: true });
        const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? "identity")))].slice(0, 16);
        invalidMessage = `The saved listing identity has invalid fields: ${fields.join(", ")}. `
          + "Correct the saved listing connection or mapping before removal. This archived variant remains excluded; no provider request was sent.";
      }
      if (!identity) throw new Error("Legacy retirement fixture could not construct an identity");
      const key = createHash("sha256").update(canonicalJson(source.identity)).digest("hex");
      await client.query("BEGIN");
      try {
        const inserted = (await client.query<{ id: string }>(`INSERT INTO marketplace.listing_member_retirements
          (id,identity_key,identity,source_identity,source_revision,product_id,product_variant_id,state,code,message,next_attempt_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT(identity_key,source_revision) DO NOTHING RETURNING id`,
        [randomUUID(), key, identity, source.identity, source.source_revision, identity.productId, identity.productVariantId,
          invalidMessage ? "failed" : "pending", invalidMessage ? "LISTING_MEMBER_IDENTITY_INVALID" : null, invalidMessage,
          invalidMessage ? null : now, now])).rows[0];
        if (inserted) await client.query(`INSERT INTO marketplace.listing_member_retirement_events(operation_id,version,actor,before_state,after_state,occurred_at)
          SELECT id,version,'system:listing-lifecycle',NULL,to_jsonb(r),$2 FROM marketplace.listing_member_retirements r WHERE id=$1`, [inserted.id, now]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally { client.release(); }
}
