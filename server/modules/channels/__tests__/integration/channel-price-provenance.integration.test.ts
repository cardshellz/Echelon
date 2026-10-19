import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { resolveChannelListingPrice } from "../../channel-pricing-resolver";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced source schema exercises production Drizzle reads against real PostgreSQL.
// The propagation suite separately exercises the production capture migration.
const fixture = `
  CREATE SCHEMA catalog; CREATE SCHEMA channels;
  CREATE TABLE catalog.products(id integer PRIMARY KEY, product_type text);
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY, sku text, shopify_variant_id text, price_cents bigint);
  CREATE TABLE public.shopify_variants(id text PRIMARY KEY, sku text, price numeric(10,2));
  CREATE TABLE channels.channel_pricing(channel_id integer, product_variant_id integer, price bigint,
    UNIQUE(channel_id,product_variant_id));
  CREATE TABLE channels.channel_pricing_rules(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id integer, scope text, scope_id text, rule_type text, value numeric(10,2),
    created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
  INSERT INTO catalog.products VALUES(20,'packs');
  INSERT INTO catalog.product_variants VALUES(101,'PACK',NULL,549);
`;

(url && disposable ? describe : describe.skip).sequential("Channel price source ownership (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase;
  const input = { channelId: 17, productId: 20, variantId: 101 };
  const resolvePrice = (channelId = input.channelId) => resolveChannelListingPrice(drizzle(database.pool, { schema }), { ...input, channelId });
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, fixture); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE channels.channel_pricing, channels.channel_pricing_rules, public.shopify_variants");
    await database.pool.query("UPDATE catalog.product_variants SET shopify_variant_id=NULL,price_cents=549");
  });

  it("keeps explicit channel cents authoritative without applying a markup twice or crossing channels", async () => {
    await database.pool.query("INSERT INTO channels.channel_pricing VALUES(17,101,1201),(18,101,993)");
    await database.pool.query("INSERT INTO channels.channel_pricing_rules(channel_id,scope,rule_type,value) VALUES(17,'channel','percentage',15)");
    await database.pool.query("INSERT INTO public.shopify_variants VALUES('store-a','PACK',5.49),('store-b','PACK',9.99)");
    expect(await resolvePrice()).toMatchObject({ priceCents: 1201, appliedRule: null,
      provenance: { kind: "channel_price", channelId: 17, variantId: 101 } });
    expect((await resolvePrice(18)).priceCents).toBe(993);
  });

  it("requires an exact source when a SKU has multiple retail matches, even at the same price", async () => {
    await database.pool.query("INSERT INTO public.shopify_variants VALUES('store-a','PACK',5.49),('store-b','pack',5.49)");
    await expect(resolvePrice()).rejects.toMatchObject({ code: "RETAIL_PRICE_SOURCE_REQUIRED" });
    await database.pool.query("UPDATE catalog.product_variants SET shopify_variant_id='store-b'");
    expect(await resolvePrice()).toMatchObject({ priceCents: 549,
      provenance: { kind: "retail_cache", variantId: 101, retailVariantId: "store-b", selection: "catalog_retail_link" } });
  });

  it("retains the exact retail identity and existing half-up channel rule precedence", async () => {
    await database.pool.query("INSERT INTO public.shopify_variants VALUES('retail-1','PACK',5.49)");
    await database.pool.query("INSERT INTO channels.channel_pricing_rules(channel_id,scope,scope_id,rule_type,value) VALUES(17,'channel',NULL,'percentage',15),(18,'channel',NULL,'percentage',99)");
    expect(await resolvePrice()).toMatchObject({ priceCents: 631, basePriceCents: 549,
      provenance: { kind: "retail_cache", variantId: 101, retailVariantId: "retail-1", selection: "unique_retail_sku" },
      appliedRule: { scope: "channel", value: "15.00" } });
  });

  it("uses Catalog only when neither an explicit price nor a retail price is available", async () => {
    expect(await resolvePrice()).toMatchObject({ priceCents: 549,
      provenance: { kind: "catalog_variant", variantId: 101 }, appliedRule: null });
    await database.pool.query("UPDATE catalog.product_variants SET price_cents=NULL");
    expect(await resolvePrice()).toMatchObject({ priceCents: null, source: null, provenance: null });
  });

  it("deleting a variant or product rule exposes the next existing scope with its own provenance", async () => {
    await database.pool.query(`INSERT INTO channels.channel_pricing_rules(channel_id,scope,scope_id,rule_type,value) VALUES
      (17,'channel',NULL,'percentage',15),(17,'category','packs','override',7),(17,'product','20','override',8),(17,'variant','101','override',9)`);
    expect(await resolvePrice()).toMatchObject({ priceCents: 900, appliedRule: { scope: "variant" } });
    await database.pool.query("DELETE FROM channels.channel_pricing_rules WHERE scope='variant'");
    expect(await resolvePrice()).toMatchObject({ priceCents: 800, appliedRule: { scope: "product" } });
    await database.pool.query("DELETE FROM channels.channel_pricing_rules WHERE scope='product'");
    expect(await resolvePrice()).toMatchObject({ priceCents: 700, appliedRule: { scope: "category" } });
    await database.pool.query("DELETE FROM channels.channel_pricing_rules WHERE scope='category'");
    expect(await resolvePrice()).toMatchObject({ priceCents: 631, appliedRule: { scope: "channel" } });
  });

  it("does not choose an arbitrary rule or silently publish an invalid explicit price", async () => {
    await database.pool.query("INSERT INTO channels.channel_pricing_rules(channel_id,scope,rule_type,value) VALUES(17,'channel','percentage',10),(17,'channel','percentage',20)");
    await expect(resolvePrice()).rejects.toMatchObject({ code: "CHANNEL_PRICING_RULE_AMBIGUOUS" });
    await database.pool.query("INSERT INTO channels.channel_pricing VALUES(17,101,-1)");
    await expect(resolvePrice()).rejects.toMatchObject({ code: "CHANNEL_PRICE_INVALID" });
  });

  it("rejects invalid retail prices and unsupported rule types without hiding them with Catalog fallback", async () => {
    await database.pool.query("INSERT INTO public.shopify_variants VALUES('retail-1','PACK',-1)");
    await expect(resolvePrice()).rejects.toMatchObject({ code: "RETAIL_PRICE_INVALID" });
    await database.pool.query("DELETE FROM public.shopify_variants");
    await database.pool.query("INSERT INTO channels.channel_pricing_rules(channel_id,scope,rule_type,value) VALUES(17,'channel','unknown',10)");
    await expect(resolvePrice()).rejects.toMatchObject({ code: "CHANNEL_PRICING_RULE_INVALID" });
  });

  it("keeps one source snapshot during concurrent price changes and sees the new source on the next review", async () => {
    await database.pool.query("INSERT INTO public.shopify_variants VALUES('retail-1','PACK',5.49)");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshotDb = drizzle(client, { schema });
      const first = await resolveChannelListingPrice(snapshotDb, input);
      await database.pool.query("UPDATE public.shopify_variants SET price=6.31");
      expect(await resolveChannelListingPrice(snapshotDb, input)).toEqual(first);
      await client.query("COMMIT");
      expect((await resolvePrice()).priceCents).toBe(631);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("does not round unsafe integer channel cents and preserves valid zero", async () => {
    await database.pool.query("INSERT INTO channels.channel_pricing VALUES(17,101,9007199254740992)");
    await expect(resolvePrice()).rejects.toMatchObject({ code: "CHANNEL_PRICE_INVALID" });
    await database.pool.query("UPDATE channels.channel_pricing SET price=0");
    expect((await resolvePrice()).priceCents).toBe(0);
  });
});
