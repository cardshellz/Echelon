import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;

/** The catalog candidate read names only these; any other name fails the test. */
const OBJECTS: ReadonlySet<string> = new Set([
  "catalog.products", "catalog.product_variants", "catalog.product_line_products", "catalog.product_assets",
  "ebay.ebay_category_mappings", "channels.channels", "public.shopify_variants",
]);

/**
 * The per-size retail lookup the batch read replaced, kept here as the
 * reference: for every size without a SKU tie, the batch read must give the
 * same price. (With a tie its LIMIT 1 took whichever row the plan reached first.)
 */
const PER_SIZE_RETAIL_SQL = `
SELECT pv.id, COALESCE((ROUND(rc.price::numeric * 100))::bigint, pv.price_cents) AS retail_cents
FROM catalog.product_variants pv
LEFT JOIN LATERAL (
  SELECT sv.price FROM public.shopify_variants sv
  WHERE (pv.shopify_variant_id IS NOT NULL AND sv.id::text = pv.shopify_variant_id::text)
     OR (NULLIF(BTRIM(pv.sku), '') IS NOT NULL AND UPPER(sv.sku) = UPPER(pv.sku))
  ORDER BY CASE WHEN sv.id::text = pv.shopify_variant_id::text THEN 0 ELSE 1 END
  LIMIT 1
) rc ON true
WHERE pv.id = ANY($1::int[])
ORDER BY pv.id`;

interface PlanNode { "Node Type": string; "Relation Name"?: string; "Actual Loops"?: number; Plans?: PlanNode[] }

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

describeDatabase.sequential("catalog candidate retail price PostgreSQL guarantees", () => {
  const schema = `dropship_catalog_retail_${process.pid}`;
  let pool: pg.Pool;
  let created = false;
  const qualify = (sql: string) => sql.replace(/\b(catalog|channels|public|ebay)\.([a-z_]+)\b/g, (name, _namespace, object) => {
    if (!OBJECTS.has(name)) throw new Error(`Unexpected database object: ${name}`);
    return `"${schema}"."${object}"`;
  });
  const execute = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);
  /** The repository's own SQL against the isolated schema, recording each statement and its values. */
  function repository(statements: Array<{ sql: string; values?: unknown[] }> = []) {
    const run = (target: Pick<pg.PoolClient, "query">, sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      return target.query(qualify(sql), values);
    };
    return new PgDropshipListingPreviewRepository({
      query: (sql: string, values?: unknown[]) => run(pool, sql, values),
      connect: async () => {
        const client = await pool.connect();
        return { query: (sql: string, values?: unknown[]) => run(client, sql, values), release: () => client.release() };
      },
    } as unknown as Pool);
  }
  async function retailById(ids: number[]) {
    const candidates = await repository().listCatalogCandidates(ids);
    return Object.fromEntries(candidates.map((row) => [row.productVariantId, row.defaultRetailPriceCents]));
  }
  async function perSizeRetailById(ids: number[]) {
    const rows = (await execute(PER_SIZE_RETAIL_SQL, [ids])).rows as Array<{ id: number; retail_cents: string | null }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.retail_cents === null ? null : Number(row.retail_cents)]));
  }

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Catalog retail tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_catalog_retail_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 3, connectionTimeoutMillis: 5000,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: true } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    // The columns the candidate read uses, with the owning schema's types
    // (catalog migrations and shared/schema/shopify.schema.ts for the cache).
    await execute(`
      CREATE TABLE catalog.products (id integer PRIMARY KEY, sku varchar(100), name text NOT NULL, title text,
        description text, category varchar(100), ebay_browse_category_id varchar(50), ebay_browse_category_name text,
        brand text, condition text, item_specifics jsonb, is_active boolean NOT NULL DEFAULT true, product_type varchar(100));
      CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products(id),
        sku varchar(100), name text NOT NULL, gtin text, mpn text, weight_grams numeric(10,2),
        is_active boolean NOT NULL DEFAULT true, units_per_variant integer NOT NULL DEFAULT 1,
        uom_type varchar(30) NOT NULL DEFAULT 'pack', price_cents integer, shopify_variant_id varchar(100),
        requires_shipping boolean NOT NULL DEFAULT true, track_inventory boolean DEFAULT true,
        sales_eligibility varchar(30) NOT NULL DEFAULT 'sellable');
      CREATE TABLE catalog.product_line_products (product_id integer NOT NULL, product_line_id integer NOT NULL);
      CREATE TABLE catalog.product_assets (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, product_id integer NOT NULL,
        product_variant_id integer, asset_type varchar(30) NOT NULL, url text, is_primary boolean NOT NULL DEFAULT false,
        position integer NOT NULL DEFAULT 0);
      CREATE TABLE channels.channels (id integer PRIMARY KEY, name text, provider text, type text, status text);
      CREATE TABLE ebay.ebay_category_mappings (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, channel_id integer NOT NULL,
        product_type_slug varchar(100) NOT NULL, ebay_browse_category_id varchar(50), ebay_browse_category_name text);
      CREATE TABLE public.shopify_variants (id varchar(100) PRIMARY KEY, product_id text NOT NULL, sku text, price numeric(10,2));
    `);
  });
  beforeEach(async () => {
    await execute(`TRUNCATE ${[...OBJECTS].join(", ")} RESTART IDENTITY CASCADE;
      INSERT INTO catalog.products (id, name) VALUES (1, 'Toploaders');`);
  });
  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  it("gives every size the retail price the per-size lookup gave", async () => {
    // (id, sku, own Shopify variant id, catalog price cents)
    await execute(`
      INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, price_cents) VALUES
        (1, 1, 'SKU-1', 'own id only', 's1', NULL),
        (2, 1, 'SKU-2', 'sku only', NULL, NULL),
        (3, 1, 'SKU-3', 'own id with no price, a priced sku match', 's3', 777),
        (4, 1, 'SKU-4', 'own id not in the cache', 'missing', NULL),
        (5, 1, '  ', 'blank sku', NULL, 500),
        (6, 1, 'abc-6', 'sku in another case', NULL, NULL),
        (7, 1, ' SKU-7 ', 'sku with spaces, never trimmed', NULL, NULL),
        (8, 1, 'SKU-8', 'cache sku missing', NULL, NULL),
        (9, 1, 'SKU-9', 'own id and sku on one row', 's9', NULL),
        (10, 1, 'SKU-10', 'own id beats another sku match', 's10a', NULL),
        (11, 1, NULL, 'nothing to match', NULL, NULL),
        (12, 1, 'SKU-12', 'empty own id', '', NULL),
        (13, 1, 'SKU-13', 'not sellable, still priced the same', 's13', NULL);
      UPDATE catalog.product_variants SET sales_eligibility = 'not_sellable' WHERE id = 13;
      INSERT INTO public.shopify_variants (id, product_id, sku, price) VALUES
        ('s1', 'p', 'OTHER-1', 1.01), ('s2', 'p', 'SKU-2', 2.02), ('s3', 'p', 'X', NULL), ('s3b', 'p', 'SKU-3', 3.03),
        ('s4', 'p', 'SKU-4', 4.04), ('s6', 'p', 'ABC-6', 6.06), ('s7', 'p', 'SKU-7', 7.07), ('s8', 'p', NULL, 8.08),
        ('s9', 'p', 'SKU-9', 9.09), ('s10a', 'p', 'Y', 10.01), ('s10b', 'p', 'SKU-10', 10.02), ('s12', 'p', 'SKU-12', 12.12),
        ('s13', 'p', 'SKU-13', 13.13);
    `);
    const ids = Array.from({ length: 12 }, (_, index) => index + 1);
    expect(await retailById(ids)).toEqual({
      1: 101, 2: 202, 3: 777, 4: 404, 5: 500, 6: 606, 7: null, 8: null, 9: 909, 10: 1001, 11: null, 12: 1212,
    });
    expect(await retailById(ids)).toEqual(await perSizeRetailById(ids));
    // The sellable filter still applies after the batch's prices are found.
    expect(await retailById([13])).toEqual({});
  });

  it("picks the lowest Shopify id when several cache rows share a size's SKU, whatever order they were stored in", async () => {
    await execute(`
      INSERT INTO catalog.product_variants (id, product_id, sku, name) VALUES (1, 1, 'DUP-1', 'tie'), (2, 1, 'dup-2', 'tie in any case');
      INSERT INTO public.shopify_variants (id, product_id, sku, price) VALUES
        ('v9', 'p', 'DUP-1', 9.00), ('v1', 'p', 'dup-1', 1.00), ('v5', 'p', 'Dup-1', 5.00),
        ('w2', 'p', 'DUP-2', 2.00), ('w0', 'p', 'Dup-2', 0.50);
    `);
    expect(await retailById([1, 2])).toEqual({ 1: 100, 2: 50 });
  });

  it("finds a batch's prices without scanning the cache once per size", async () => {
    // 1,000 sizes, half matched by their own Shopify id and half by SKU, in a cache of 2,000.
    await execute(`
      INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id)
        SELECT x, 1, 'SKU-' || x, 'Size ' || x, CASE WHEN x % 2 = 0 THEN 'own-' || x END FROM generate_series(1, 1000) x;
      INSERT INTO public.shopify_variants (id, product_id, sku, price)
        SELECT 'own-' || x, 'p', 'OWN-' || x, 1.00 FROM generate_series(1, 1000) x;
      INSERT INTO public.shopify_variants (id, product_id, sku, price)
        SELECT 'sku-' || x, 'p', 'sku-' || x, 2.00 FROM generate_series(1, 1000) x;
      ANALYZE ${[...OBJECTS].join(", ")};
    `);
    const ids = Array.from({ length: 250 }, (_, index) => index + 1);
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const candidates = await repository(statements).listCatalogCandidates(ids);
    expect(candidates).toHaveLength(250);
    expect(candidates.every((row) => row.defaultRetailPriceCents === (row.productVariantId % 2 === 0 ? 100 : 200))).toBe(true);
    const [read] = statements;
    const explained = await execute(`EXPLAIN (ANALYZE, FORMAT JSON) ${read.sql}`, read.values);
    const nodes = planNodes((explained.rows[0]["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0].Plan);
    const cacheScans = nodes.filter((node) => node["Relation Name"] === "shopify_variants");
    expect(cacheScans.length).toBeGreaterThan(0);
    // A sequential scan of the cache may run once per batch, never once per size.
    expect(cacheScans.filter((node) => node["Node Type"] === "Seq Scan" && (node["Actual Loops"] ?? 1) > 1)).toEqual([]);
  });
});
