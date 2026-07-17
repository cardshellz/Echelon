import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const migrationSql = readFileSync(resolve(process.cwd(), "migrations/147_purchase_rfq_requests.sql"), "utf8");

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false };
}

async function expectDatabaseError(operation: () => Promise<unknown>, code: string) {
  let error: unknown;
  try { await operation(); } catch (caught) { error = caught; }
  expect(error).toBeTruthy();
  expect((error as { code?: string }).code).toBe(code);
}

describeWithDisposableDb.sequential("purchase recommendation and RFQ PostgreSQL guarantees", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  let pool: pg.Pool;
  let productId: number;
  let variantId: number;
  let vendorA: number;
  let vendorB: number;
  let vendorProductA: number;
  let vendorProductB: number;
  let runId: number;
  let recommendationLineId: number;

  beforeAll(async () => {
    const productionUrls = [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean);
    if (productionUrls.includes(TEST_DB_URL!)) throw new Error("ECHELON_TEST_DATABASE_URL must not equal a production database URL");
    pool = new pg.Pool({ connectionString: TEST_DB_URL, ssl: sslConfig(TEST_DB_URL!) });
    await pool.query("CREATE SCHEMA catalog; CREATE SCHEMA procurement; CREATE SCHEMA warehouse;");
    await pool.query(`
      CREATE TABLE catalog.products (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, sku VARCHAR(100));
      CREATE TABLE catalog.product_variants (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES catalog.products(id)
      );
      CREATE TABLE warehouse.warehouses (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
      CREATE TABLE procurement.vendors (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE procurement.vendor_products (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id INTEGER NOT NULL REFERENCES procurement.vendors(id),
        product_id INTEGER NOT NULL REFERENCES catalog.products(id),
        product_variant_id INTEGER REFERENCES catalog.product_variants(id),
        unit_cost_cents BIGINT,
        unit_cost_mills BIGINT
      );
    `);
    await pool.query(migrationSql);
    productId = (await pool.query("INSERT INTO catalog.products (sku) VALUES ($1) RETURNING id", [`RFQ-${suffix}`])).rows[0].id;
    variantId = (await pool.query("INSERT INTO catalog.product_variants (product_id) VALUES ($1) RETURNING id", [productId])).rows[0].id;
    vendorA = (await pool.query("INSERT INTO procurement.vendors (name) VALUES ($1) RETURNING id", [`Vendor A ${suffix}`])).rows[0].id;
    vendorB = (await pool.query("INSERT INTO procurement.vendors (name) VALUES ($1) RETURNING id", [`Vendor B ${suffix}`])).rows[0].id;
    vendorProductA = (await pool.query(
      "INSERT INTO procurement.vendor_products (vendor_id, product_id, product_variant_id) VALUES ($1,$2,$3) RETURNING id",
      [vendorA, productId, variantId],
    )).rows[0].id;
    vendorProductB = (await pool.query(
      "INSERT INTO procurement.vendor_products (vendor_id, product_id, product_variant_id) VALUES ($1,$2,$3) RETURNING id",
      [vendorB, productId, variantId],
    )).rows[0].id;
    runId = (await pool.query(
      `INSERT INTO procurement.purchase_recommendation_runs
        (calculation_version, as_of, lookback_days, policy_snapshot)
       VALUES ('test-v2', NOW(), 30, '{"seasonality":true}'::jsonb) RETURNING id`,
    )).rows[0].id;
    recommendationLineId = (await pool.query(
      `INSERT INTO procurement.purchase_recommendation_lines
        (run_id, recommendation_key, product_id, product_variant_id, sku, product_name, recommended_pieces, evidence_snapshot)
       VALUES ($1, $2, $3, $4, $5, 'Test Product', 100, '{"demand":"snapshot"}'::jsonb) RETURNING id`,
      [runId, `recommendation-${suffix}`, productId, variantId, `RFQ-${suffix}`],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DROP SCHEMA procurement CASCADE; DROP SCHEMA warehouse CASCADE; DROP SCHEMA catalog CASCADE;");
      await pool.end();
    }
  });

  async function createRfq(vendorId: number, key: string) {
    return (await pool.query(
      `INSERT INTO procurement.request_for_quotes (rfq_number, vendor_id, idempotency_key)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RFQ-${key}`, vendorId, key],
    )).rows[0].id as number;
  }

  async function addLine(rfqId: number, vendorProductId: number, pieces: number) {
    return pool.query(
      `INSERT INTO procurement.request_for_quote_lines
        (rfq_id, recommendation_line_id, vendor_product_id, requested_pieces)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [rfqId, recommendationLineId, vendorProductId, pieces],
    );
  }

  it("stores immutable calculation evidence separately from sourcing quantities", async () => {
    const rfqId = await createRfq(vendorA, `evidence-${suffix}`);
    await addLine(rfqId, vendorProductA, 25);
    const stored = await pool.query(
      `SELECT r.recommended_pieces, r.evidence_snapshot, q.requested_pieces, vp.unit_cost_mills
         FROM procurement.purchase_recommendation_lines r
         JOIN procurement.request_for_quote_lines q ON q.recommendation_line_id = r.id
         JOIN procurement.vendor_products vp ON vp.id = q.vendor_product_id
        WHERE q.rfq_id = $1`,
      [rfqId],
    );
    expect(stored.rows[0]).toMatchObject({
      recommended_pieces: 100,
      requested_pieces: 25,
      unit_cost_mills: null,
      evidence_snapshot: { demand: "snapshot" },
    });
  });

  it("allows a recommendation to be split across suppliers but not over-allocated", async () => {
    const allocated = await pool.query(
      `SELECT COALESCE(SUM(requested_pieces),0)::int AS qty FROM procurement.request_for_quote_lines
       WHERE recommendation_line_id=$1 AND status IN ('draft','sent','quoted','accepted','ordered')`,
      [recommendationLineId],
    );
    const remaining = 100 - allocated.rows[0].qty;
    const first = Math.floor(remaining / 2);
    const second = remaining - first;
    const rfqA = await createRfq(vendorA, `split-a-${suffix}`);
    const rfqB = await createRfq(vendorB, `split-b-${suffix}`);
    await addLine(rfqA, vendorProductA, first);
    await addLine(rfqB, vendorProductB, second);
    const overflow = await createRfq(vendorA, `overflow-${suffix}`);
    await expectDatabaseError(() => addLine(overflow, vendorProductA, 1), "23514");
  });

  it("serializes concurrent allocation so only the available quantity can commit", async () => {
    const secondRun = (await pool.query(
      `INSERT INTO procurement.purchase_recommendation_runs
        (calculation_version, as_of, lookback_days, policy_snapshot)
       VALUES ('concurrency-v2', NOW(), 30, '{}'::jsonb) RETURNING id`,
    )).rows[0].id;
    const secondLine = (await pool.query(
      `INSERT INTO procurement.purchase_recommendation_lines
        (run_id, recommendation_key, product_id, product_variant_id, sku, product_name, recommended_pieces, evidence_snapshot)
       VALUES ($1,$2,$3,$4,$5,'Concurrent Product',10,'{}'::jsonb) RETURNING id`,
      [secondRun, `concurrent-${suffix}`, productId, variantId, `RFQ-${suffix}`],
    )).rows[0].id;
    const rfqA = await createRfq(vendorA, `concurrent-a-${suffix}`);
    const rfqB = await createRfq(vendorB, `concurrent-b-${suffix}`);
    const insert = (rfqId: number, vendorProductId: number) => pool.query(
      `INSERT INTO procurement.request_for_quote_lines
        (rfq_id, recommendation_line_id, vendor_product_id, requested_pieces)
       VALUES ($1,$2,$3,10)`,
      [rfqId, secondLine, vendorProductId],
    );
    const settled = await Promise.allSettled([insert(rfqA, vendorProductA), insert(rfqB, vendorProductB)]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("makes recommendation evidence append-only and idempotency keys supplier-scoped", async () => {
    await expectDatabaseError(
      () => pool.query("UPDATE procurement.purchase_recommendation_lines SET evidence_snapshot='{}'::jsonb WHERE id=$1", [recommendationLineId]),
      "23514",
    );
    await expectDatabaseError(
      () => pool.query("DELETE FROM procurement.purchase_recommendation_runs WHERE id=$1", [runId]),
      "23514",
    );
    await createRfq(vendorA, `idem-${suffix}`);
    await expectDatabaseError(() => createRfq(vendorA, `idem-${suffix}`), "23505");
    await expect(createRfq(vendorB, `idem-${suffix}`)).resolves.toBeTypeOf("number");
  });
});
