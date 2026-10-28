import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StockLinkDestination } from "@shared/types/stock-link";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { classifyStockLinkFailure } from "../../../inventory-planning/domain/stock-link-errors";
import { ChannelIdentityService } from "../../channel-identity.service";
import { readChannelStockSelection } from "../../channel-stock-selection";
import { createShopifyStockLinkSource, shopifyStockLinkFingerprint } from "../../shopify-stock-link-source";

/**
 * Channels' read-only SQL for the stock-link engine's Shopify destinations (PLAN-CH2 v4.1 §6.2) on real PostgreSQL:
 * the carried set against the Channels selection itself, sweep paging, the raw feed cursor under other time zones and
 * date styles (TST-8), Card Shellz SKUs (N6), feed hints, the fingerprint against the adapter's own connection read,
 * and the FOR SHARE re-confirmation. Query-shape and transaction proof; not migration proof (the columns are the
 * production ones the statements name).
 */

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const ddl = `CREATE SCHEMA catalog; CREATE SCHEMA channels;
CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,status varchar(20) DEFAULT 'active',
  product_type text,category text,ebay_listing_excluded boolean DEFAULT false);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products(id),sku varchar(100),
  uom_type text NOT NULL DEFAULT 'pack',is_active boolean NOT NULL DEFAULT true,requires_shipping boolean DEFAULT true,
  track_inventory boolean DEFAULT true,sales_eligibility text DEFAULT 'sellable',ebay_listing_excluded boolean DEFAULT false);
CREATE TABLE catalog.product_line_products(product_id integer,product_line_id integer);
CREATE TABLE channels.channels(id integer PRIMARY KEY,name varchar(100) NOT NULL,provider varchar(30) NOT NULL);
CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer NOT NULL REFERENCES channels.channels(id),
  shop_domain varchar(255),access_token text,api_version varchar(20),shopify_location_id varchar(50));
CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer,is_listed integer);
CREATE TABLE channels.channel_variant_overrides(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer NOT NULL,
  product_variant_id integer REFERENCES catalog.product_variants(id),sku_override varchar(100),is_listed integer NOT NULL DEFAULT 1,
  UNIQUE(channel_id,product_variant_id));
CREATE TABLE channels.channel_feeds(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),channel_type varchar(30) NOT NULL DEFAULT 'shopify',
  channel_variant_id varchar(100),channel_product_id varchar(100),channel_sku varchar(100),channel_inventory_item_id varchar(100),
  is_active integer NOT NULL DEFAULT 1,quarantined_at timestamp,last_synced_qty integer,
  created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(channel_id,product_variant_id),
  CONSTRAINT channel_feeds_active_identity_chk CHECK (is_active = 0 OR NULLIF(btrim(channel_variant_id), '') IS NOT NULL));
CREATE TABLE channels.channel_listings(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer NOT NULL,
  product_variant_id integer,external_product_id varchar(100),external_variant_id varchar(100),external_sku varchar(100),
  sync_status varchar(20) DEFAULT 'pending',UNIQUE(channel_id,product_variant_id));`;

const US = { channelId: 35, connectionId: 7 };
const CANADA = { channelId: 36, connectionId: 8 };
const destination = (store = US, overrides: Partial<StockLinkDestination> = {}): StockLinkDestination => ({
  publicationTargetId: store === US ? 41 : 42, destinationKind: "channel_connection", providerKey: "shopify",
  channelId: store.channelId, channelConnectionId: store.connectionId, dropshipStoreConnectionId: null,
  providerScopeType: "location", externalScopeId: store === US ? "98765" : "55555", targetRevision: "3", ...overrides,
});

/** Every size of the grid with what the Channels selection says about it on the US store (asserted, not assumed). */
const GRID: readonly { variant: number; product: number; action: "publish" | "zero" | "read_only" | "none"; why: string }[] = [
  { variant: 101, product: 10, action: "publish", why: "active feed" },
  { variant: 102, product: 10, action: "zero", why: "inactive feed with a saved identity (a removed size)" },
  { variant: 103, product: 10, action: "read_only", why: "selected, listing identity, no feed row" },
  { variant: 104, product: 10, action: "read_only", why: "feed on the other store only" },
  { variant: 105, product: 10, action: "publish", why: "active quarantined feed (a blocker)" },
  { variant: 106, product: 10, action: "none", why: "archived variant with an active feed" },
  { variant: 107, product: 10, action: "zero", why: "unlisted on this channel, active feed" },
  { variant: 108, product: 10, action: "none", why: "inactive feed without identity" },
  { variant: 109, product: 10, action: "publish", why: "active feed, channel SKU override" },
  { variant: 110, product: 10, action: "zero", why: "not inventory managed, active feed" },
  { variant: 111, product: 11, action: "none", why: "archived product status" },
  { variant: 121, product: 12, action: "none", why: "inactive product" },
  { variant: 131, product: 13, action: "zero", why: "draft catalog product, active feed" },
];

describe.skipIf(!url || !disposable)("Shopify stock-link source (channels PR2, P6)", () => {
  let database: InventoryCutoverTestDatabase;
  const source = createShopifyStockLinkSource();
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, ddl); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE channels.channel_listings, channels.channel_feeds, channels.channel_variant_overrides,
      channels.channel_product_overrides, channels.channel_connections, channels.channels, catalog.product_line_products,
      catalog.product_variants, catalog.products RESTART IDENTITY;
      INSERT INTO channels.channels VALUES (35,'Shopify US','shopify'),(36,'Shopify Canada','shopify');
      INSERT INTO channels.channel_connections VALUES (7,35,'card-shellz.myshopify.com','test-only-us-token','2024-01','98765'),
        (8,36,'card-shellz-ca.myshopify.com','test-only-ca-token',NULL,'55555');
      INSERT INTO catalog.products(id,is_active,status) VALUES (10,true,'active'),(11,true,'archived'),(12,false,'active'),(13,true,'draft');
      INSERT INTO catalog.product_variants(id,product_id,sku,is_active,requires_shipping) VALUES
        (101,10,'P-101',true,true),(102,10,' p-102 ',true,true),(103,10,'P-103',true,true),(104,10,'P-104',true,true),
        (105,10,'P-105',true,true),(106,10,'P-106',false,true),(107,10,'P-107',true,true),(108,10,'P-108',true,true),
        (109,10,'P-109',true,true),(110,10,'P-110',true,false),(111,11,'P-111',true,true),(121,12,'P-121',true,true),
        (131,13,NULL,true,true);
      INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,sku_override,is_listed) VALUES
        (35,107,NULL,0),(35,109,'OVR-109',1),(36,101,'CA-101',1);
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_variant_id,channel_sku,channel_inventory_item_id,is_active,quarantined_at,updated_at) VALUES
        (35,101,'v101','P-101','  101001 ',1,NULL,'2026-10-27 10:00:00.123456'),
        (35,102,'v102','P-102','101002',0,NULL,'2026-10-27 10:00:00.123456'),
        (35,105,'v105','P-105','gid://shopify/InventoryItem/101005',1,'2026-10-26 09:00:00','2026-10-27 10:30:00.000001'),
        (35,106,'v106','P-106','101006',1,NULL,'2026-10-27 08:00:00'),
        (35,107,'v107','P-107','101007',1,NULL,'2026-10-27 08:00:00'),
        (35,108,NULL,NULL,NULL,0,NULL,'2026-10-27 09:00:00'),
        (35,109,'v109','OVR-109','101009',1,NULL,'2026-10-27 08:00:00'),
        (35,110,'v110','P-110','101010',1,NULL,'2026-10-27 08:00:00'),
        (35,111,'v111','P-111','101011',1,NULL,'2026-10-27 08:00:00'),
        (35,121,'v121','P-121','101021',1,NULL,'2026-10-27 08:00:00'),
        (35,131,'v131',NULL,'101031',1,NULL,'2026-10-27 08:00:00'),
        (36,104,'v104','P-104','201004',1,NULL,'2026-10-27 08:00:00'),
        (36,101,'v101-ca','CA-101','201001',1,NULL,'2026-10-27 08:00:00');
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_product_id,external_variant_id,external_sku) VALUES
        (35,103,'p103','v103','P-103');`);
  });

  async function inReadOnlyTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function sweep(store = US, limit = 500): Promise<number[]> {
    const ids: number[] = [];
    let after = 0;
    for (;;) {
      const page = await source.listCandidates(database.pool, destination(store), after, limit);
      ids.push(...page.candidates.map(candidate => candidate.productVariantId));
      if (page.nextAfterVariantId === null) return ids;
      after = page.nextAfterVariantId;
    }
  }

  it("carries every size the Channels selection would publish or zero, and nothing archived or without identity", async () => {
    for (const row of GRID) {
      const selection = await readChannelStockSelection(database.pool, { channelId: US.channelId, channelConnectionId: US.connectionId,
        productId: row.product, productVariantIds: [row.variant] });
      expect([row.variant, row.why, selection.variants[0]!.action]).toEqual([row.variant, row.why, row.action]);
    }
    const carried = await sweep();
    expect(carried).toEqual([101, 102, 103, 105, 107, 109, 110, 131]);
    for (const row of GRID) {
      if (row.action === "publish" || row.action === "zero") expect(carried).toContain(row.variant);
    }
    // The one documented difference (file comment): a selected size with only a listing identity is read_only, but
    // carried here; the engine reads the selection of every size it decides, so it is never linked.
    expect(carried.filter(id => !["publish", "zero"].includes(GRID.find(row => row.variant === id)!.action))).toEqual([103]);
    expect(await sweep(CANADA)).toEqual([101, 104]);
  });

  it("pages the sweep in variant order, with the next cursor only after a full page", async () => {
    const first = await source.listCandidates(database.pool, destination(), 0, 3);
    expect(first).toEqual({ candidates: [{ productVariantId: 101, productId: 10 }, { productVariantId: 102, productId: 10 },
      { productVariantId: 103, productId: 10 }], nextAfterVariantId: 103 });
    expect(await sweep(US, 3)).toEqual([101, 102, 103, 105, 107, 109, 110, 131]);
    expect(await source.listCandidates(database.pool, destination(), 131, 3)).toEqual({ candidates: [], nextAfterVariantId: null });
    expect(await sweep(US, 4)).toEqual([101, 102, 103, 105, 107, 109, 110, 131]);
  });

  it("lists every carried size's Card Shellz SKU as stored, with this channel's override only (N6)", async () => {
    expect(await source.listCarriedSkus(database.pool, destination())).toEqual([
      { productVariantId: 101, sku: "P-101" }, { productVariantId: 102, sku: " p-102 " }, { productVariantId: 103, sku: "P-103" },
      { productVariantId: 105, sku: "P-105" }, { productVariantId: 107, sku: "P-107" }, { productVariantId: 109, sku: "OVR-109" },
      { productVariantId: 110, sku: "P-110" }, { productVariantId: 131, sku: null },
    ]);
    expect(await source.listCarriedSkus(database.pool, destination(CANADA))).toEqual([
      { productVariantId: 101, sku: "CA-101" }, { productVariantId: 104, sku: "P-104" }]);
  });

  it("reads asked sizes' SKUs and this channel's trimmed feed hint; a missing size is absent", async () => {
    expect(await source.readSkus(database.pool, destination(), [999, 109, 101, 104, 105])).toEqual([
      { productVariantId: 101, productId: 10, cardShellzSku: "P-101", feedHintItemId: "101001" },
      { productVariantId: 104, productId: 10, cardShellzSku: "P-104", feedHintItemId: null },
      { productVariantId: 105, productId: 10, cardShellzSku: "P-105", feedHintItemId: "gid://shopify/InventoryItem/101005" },
      { productVariantId: 109, productId: 10, cardShellzSku: "OVR-109", feedHintItemId: "101009" },
    ]);
    expect(await source.readSkus(database.pool, destination(CANADA), [101])).toEqual([
      { productVariantId: 101, productId: 10, cardShellzSku: "CA-101", feedHintItemId: "201001" }]);
    expect(await source.readSkus(database.pool, destination(), [])).toEqual([]);
  });

  it("finds changed feeds by the raw cursor with a 10-minute overlap, oldest first, with whether each is carried (TST-8)", async () => {
    const all = await source.listRecentlyChanged(database.pool, destination(), { raw: null, id: null }, 500);
    expect(all.map(row => [row.productVariantId, row.changedAtRaw, row.carried])).toEqual([
      [106, "2026-10-27 08:00:00.000000", false], [107, "2026-10-27 08:00:00.000000", true], [109, "2026-10-27 08:00:00.000000", true],
      [110, "2026-10-27 08:00:00.000000", true], [111, "2026-10-27 08:00:00.000000", false], [121, "2026-10-27 08:00:00.000000", false],
      [131, "2026-10-27 08:00:00.000000", true], [108, "2026-10-27 09:00:00.000000", false], [101, "2026-10-27 10:00:00.123456", true],
      [102, "2026-10-27 10:00:00.123456", true], [105, "2026-10-27 10:30:00.000001", true],
    ]);
    expect(all.every(row => row.productId > 0 && row.feedId > 0 && row.fresh)).toBe(true);
    const last = all[all.length - 1]!;
    // From the last raw value read: the overlap re-reads that feed (not fresh); nothing older than 10 minutes before it.
    expect((await source.listRecentlyChanged(database.pool, destination(), { raw: last.changedAtRaw, id: last.feedId }, 500))
      .map(row => [row.productVariantId, row.fresh])).toEqual([[105, false]]);
    // Ties on the same raw time go by feed id; Postgres' own text of a stored cursor (no trailing zeros) reads the same.
    // The changes after the cursor come first, then the overlap's (P7: a full overlap never holds the cursor back).
    const tie = all.find(row => row.productVariantId === 101)!;
    expect((await source.listRecentlyChanged(database.pool, destination(), { raw: "2026-10-27 10:10:00.123456", id: tie.feedId }, 500))
      .map(row => [row.productVariantId, row.fresh])).toEqual([[105, true], [102, false]]);
    expect((await source.listRecentlyChanged(database.pool, destination(), { raw: "2026-10-27 10:10:00", id: 1 }, 500))
      .map(row => [row.productVariantId, row.fresh])).toEqual([[105, true], [101, false], [102, false]]);
    // A page smaller than the overlap still returns the fresh change first.
    expect((await source.listRecentlyChanged(database.pool, destination(), { raw: "2026-10-27 10:10:00", id: 1 }, 1))
      .map(row => row.productVariantId)).toEqual([105]);
    expect((await source.listRecentlyChanged(database.pool, destination(), { raw: null, id: null }, 2)).map(row => row.productVariantId))
      .toEqual([106, 107]);
    expect((await source.listRecentlyChanged(database.pool, destination(CANADA), { raw: null, id: null }, 500)).map(row => row.productVariantId))
      .toEqual([104, 101]);
  });

  it("returns the same raw values and finds the same feeds under another session time zone and date style", async () => {
    const plain = await source.listRecentlyChanged(database.pool, destination(), { raw: "2026-10-27 08:30:00.5", id: 1 }, 500);
    const client = await database.pool.connect();
    try {
      await client.query("SET TIME ZONE 'America/New_York'");
      await client.query("SET DateStyle = 'SQL, DMY'");
      const shifted = await source.listRecentlyChanged(client, destination(), { raw: "2026-10-27 08:30:00.5", id: 1 }, 500);
      expect(shifted).toEqual(plain);
      expect(plain.map(row => row.productVariantId)).toEqual([108, 101, 102, 105]);
    } finally {
      await client.query("RESET ALL");
      client.release();
    }
  });

  it("fingerprints the stored login exactly as the adapter fingerprints the connection it reads with", async () => {
    const identities = new ChannelIdentityService(drizzle(database.pool));
    for (const store of [US, CANADA]) {
      const adapterRead = shopifyStockLinkFingerprint(await identities.shopifyConnection(store.channelId, store.connectionId));
      expect(await source.readFingerprint(database.pool, destination(store))).toBe(adapterRead);
    }
    const before = await source.readFingerprint(database.pool, destination());
    expect(before).not.toContain("test-only-us-token");
    await database.pool.query("UPDATE channels.channel_connections SET api_version='2025-07' WHERE id=7");
    expect(await source.readFingerprint(database.pool, destination())).toBe(before);
    for (const change of ["access_token='rotated'", "shop_domain='other.myshopify.com'", "shopify_location_id='11111'", "shopify_location_id=NULL"]) {
      await database.pool.query(`UPDATE channels.channel_connections SET ${change} WHERE id=7`);
      expect(await source.readFingerprint(database.pool, destination())).not.toBe(before);
      await database.pool.query("UPDATE channels.channel_connections SET access_token='test-only-us-token', shop_domain='card-shellz.myshopify.com', shopify_location_id='98765' WHERE id=7");
      expect(await source.readFingerprint(database.pool, destination())).toBe(before);
    }
    // A connection of another channel, or no row at all, never fingerprints as a usable login.
    const unusable = shopifyStockLinkFingerprint({ id: 7, shopDomain: null, accessToken: null, shopifyLocationId: null });
    await database.pool.query("UPDATE channels.channel_connections SET channel_id=36 WHERE id=7");
    expect(await source.readFingerprint(database.pool, destination())).toBe(unusable);
  });

  it("re-confirms under FOR SHARE: a login or SKU change waits for the command; the SKUs are the stored ones", async () => {
    const client = await database.pool.connect();
    const other = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const confirmation = await source.lockForConfirmation(client, destination(), [109, 101, 999]);
      expect(confirmation).toEqual({ fingerprint: await source.readFingerprint(database.pool, destination()),
        skus: [{ productVariantId: 101, cardShellzSku: "P-101" }, { productVariantId: 109, cardShellzSku: "OVR-109" }] });
      await other.query("SET lock_timeout = '200ms'");
      for (const change of [
        "UPDATE channels.channel_connections SET access_token='rotated' WHERE id=7",
        "UPDATE catalog.product_variants SET sku='P-101-NEW' WHERE id=101",
        "UPDATE channels.channel_variant_overrides SET sku_override='OVR-NEW' WHERE channel_id=35 AND product_variant_id=109",
      ]) {
        const refused = await other.query(change).then(() => null, (error: unknown) => error);
        expect(refused).toMatchObject({ code: "55P03" });
        expect(classifyStockLinkFailure(refused)).toMatchObject({ kind: "busy" });
      }
      // The other store's rows and unasked sizes are not held.
      await other.query("UPDATE channels.channel_connections SET access_token='ca-rotated' WHERE id=8");
      await other.query("UPDATE catalog.product_variants SET sku='P-103-NEW' WHERE id=103");
      await client.query("COMMIT");
      await other.query("UPDATE catalog.product_variants SET sku='P-101-NEW' WHERE id=101");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      other.release();
    }
    const after = await source.lockForConfirmation(database.pool, destination(), [101]);
    expect(after.skus).toEqual([{ productVariantId: 101, cardShellzSku: "P-101-NEW" }]);
    expect((await source.lockForConfirmation(database.pool, destination(), [])).skus).toEqual([]);
  });

  it("only reads: every method but the FOR SHARE re-confirmation runs inside a READ ONLY transaction, on the caller's snapshot", async () => {
    const statements: string[] = [];
    await inReadOnlyTransaction(async (client) => {
      const recording = { query: (text: string, values?: readonly unknown[]) => {
        statements.push(text.trim());
        return client.query(text, values as unknown[]);
      } } as unknown as PoolClient;
      await source.listCandidates(recording, destination(), 0, 500);
      await source.listRecentlyChanged(recording, destination(), { raw: null, id: null }, 500);
      await source.listCarriedSkus(recording, destination());
      await source.readSkus(recording, destination(), [101]);
      await source.readFingerprint(recording, destination());
    });
    expect(statements).toHaveLength(5);
    expect(statements.every(text => /^SELECT\b/.test(text))).toBe(true);

    // The caller's transaction is the one read: a change committed after its snapshot is not seen.
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      expect((await source.readSkus(client, destination(), [101]))[0]!.cardShellzSku).toBe("P-101");
      await database.pool.query("UPDATE catalog.product_variants SET sku='P-101-LATER' WHERE id=101");
      expect((await source.readSkus(client, destination(), [101]))[0]!.cardShellzSku).toBe("P-101");
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each([
    { name: "a Dropship destination", value: destination(US, { destinationKind: "dropship_store_connection", channelConnectionId: null, dropshipStoreConnectionId: 4 }) },
    { name: "another provider", value: destination(US, { providerKey: "walmart" }) },
  ])("refuses $name before any SQL (fatal contract)", async ({ value }) => {
    const statements: string[] = [];
    const client = { query: async (text: string) => { statements.push(text); return { rows: [] }; } };
    for (const call of [() => source.listCandidates(client, value, 0, 10), () => source.listCarriedSkus(client, value),
      () => source.readFingerprint(client, value), () => source.lockForConfirmation(client, value, [101])]) {
      const error = await call().then(() => null, (cause: unknown) => cause);
      expect(error).toMatchObject({ code: "STOCK_LINK_ADAPTER_CONTRACT" });
      expect(classifyStockLinkFailure(error)).toMatchObject({ kind: "fatal", scope: "destination" });
    }
    expect(statements).toEqual([]);
  });

  it.each([
    { name: "a zero page", call: () => source.listCandidates(database.pool, destination(), 0, 0) },
    { name: "a page over 500", call: () => source.listCandidates(database.pool, destination(), 0, 501) },
    { name: "a negative sweep cursor", call: () => source.listCandidates(database.pool, destination(), -1, 10) },
    { name: "a cursor time without its id", call: () => source.listRecentlyChanged(database.pool, destination(), { raw: "2026-10-27 08:00:00", id: null }, 10) },
    { name: "a zoned cursor time", call: () => source.listRecentlyChanged(database.pool, destination(), { raw: "2026-10-27T08:00:00Z", id: 1 }, 10) },
    { name: "repeated sizes", call: () => source.readSkus(database.pool, destination(), [101, 101]) },
    { name: "501 sizes", call: () => source.lockForConfirmation(database.pool, destination(), Array.from({ length: 501 }, (_, index) => index + 1)) },
  ])("refuses $name (fatal contract)", async ({ call }) => {
    expect(await call().then(() => null, (cause: unknown) => cause)).toMatchObject({ code: "STOCK_LINK_ADAPTER_CONTRACT" });
  });
});
