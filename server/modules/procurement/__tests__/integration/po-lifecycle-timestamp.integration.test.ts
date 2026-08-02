import { resolve } from "node:path";
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purchaseOrders } from "@shared/schema";
import {
  nextPurchaseOrderUpdatedAt,
  purchaseOrderUpdatedAtMatchesApplicationVersion,
} from "../../purchase-order-lifecycle-version";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

describeWithDisposableDb.sequential("PO lifecycle timestamp PostgreSQL guarantees", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const productionUrls = [
      process.env.DATABASE_URL,
      process.env.EXTERNAL_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));
    if (productionUrls.includes(TEST_DB_URL!)) {
      throw new Error(
        "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL or EXTERNAL_DATABASE_URL",
      );
    }
    if (!DISPOSABLE_DB) {
      throw new Error("PO lifecycle integration tests require an explicitly disposable database");
    }

    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      ssl: sslConfig(TEST_DB_URL!),
    });
    await pool.query(`
      CREATE SCHEMA procurement;
      CREATE TABLE procurement.purchase_orders (
        id INTEGER PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        physical_status VARCHAR(30) NOT NULL,
        financial_status VARCHAR(30) NOT NULL DEFAULT 'unbilled',
        updated_at TIMESTAMP NOT NULL
      );
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DROP SCHEMA procurement CASCADE");
      await pool.end();
    }
  });

  it("matches a microsecond database version represented by a millisecond Date", async () => {
    await pool.query(`
      INSERT INTO procurement.purchase_orders (id, status, physical_status, updated_at)
      VALUES (1, 'draft', 'draft', TIMESTAMP '2026-08-02 15:47:55.211798')
    `);
    const db = drizzle(pool);
    const [observed] = await db
      .select({
        id: purchaseOrders.id,
        status: purchaseOrders.status,
        physicalStatus: purchaseOrders.physicalStatus,
        updatedAt: purchaseOrders.updatedAt,
      })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, 1));
    expect(observed.updatedAt.getUTCMilliseconds()).toBe(211);

    const before = await pool.query<{ exact_version: string }>(`
      SELECT to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US') AS exact_version
      FROM procurement.purchase_orders
      WHERE id = 1
    `);
    expect(before.rows[0].exact_version).toBe("2026-08-02 15:47:55.211798");

    const updated = await db
      .update(purchaseOrders)
      .set({
        status: "sent",
        physicalStatus: "sent",
        updatedAt: nextPurchaseOrderUpdatedAt(observed.updatedAt),
      })
      .where(and(
        eq(purchaseOrders.id, observed.id),
        eq(purchaseOrders.status, observed.status),
        eq(purchaseOrders.physicalStatus, observed.physicalStatus),
        purchaseOrderUpdatedAtMatchesApplicationVersion(observed.updatedAt),
      ))
      .returning({
        id: purchaseOrders.id,
        status: purchaseOrders.status,
        updatedAt: purchaseOrders.updatedAt,
      });

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ id: 1, status: "sent" });
    const after = await pool.query<{ exact_version: string }>(`
      SELECT to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US') AS exact_version
      FROM procurement.purchase_orders
      WHERE id = 1
    `);
    expect(after.rows[0].exact_version).toMatch(/\.\d{3}000$/);
  });

  it("does not match a version from a later millisecond", async () => {
    await pool.query(`
      INSERT INTO procurement.purchase_orders (id, status, physical_status, updated_at)
      VALUES (2, 'draft', 'draft', TIMESTAMP '2026-08-02 15:47:55.212001')
    `);
    const staleVersion = new Date("2026-08-02T15:47:55.211Z");
    const db = drizzle(pool);
    const updated = await db
      .update(purchaseOrders)
      .set({ status: "sent" })
      .where(and(
        eq(purchaseOrders.id, 2),
        purchaseOrderUpdatedAtMatchesApplicationVersion(staleVersion),
      ))
      .returning({ id: purchaseOrders.id });

    expect(updated).toEqual([]);
  });

  it("applies a draft edit against a microsecond database version", async () => {
    await pool.query(`
      INSERT INTO procurement.purchase_orders (id, status, physical_status, updated_at)
      VALUES (3, 'draft', 'draft', TIMESTAMP '2026-08-02 15:47:55.211798')
    `);
    const db = drizzle(pool);
    const [observed] = await db
      .select({
        id: purchaseOrders.id,
        status: purchaseOrders.status,
        physicalStatus: purchaseOrders.physicalStatus,
        financialStatus: purchaseOrders.financialStatus,
        updatedAt: purchaseOrders.updatedAt,
      })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, 3));

    const updated = await db
      .update(purchaseOrders)
      .set({ updatedAt: nextPurchaseOrderUpdatedAt(observed.updatedAt) })
      .where(and(
        eq(purchaseOrders.id, observed.id),
        eq(purchaseOrders.status, "draft"),
        eq(purchaseOrders.physicalStatus, "draft"),
        eq(purchaseOrders.financialStatus, "unbilled"),
        purchaseOrderUpdatedAtMatchesApplicationVersion(observed.updatedAt),
      ))
      .returning({
        id: purchaseOrders.id,
        updatedAt: purchaseOrders.updatedAt,
      });

    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(3);
    expect(updated[0].updatedAt.getTime()).toBeGreaterThanOrEqual(
      observed.updatedAt.getTime() + 1,
    );
    const exactVersion = await pool.query<{ exact_version: string }>(`
      SELECT to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US') AS exact_version
      FROM procurement.purchase_orders
      WHERE id = 3
    `);
    expect(exactVersion.rows[0].exact_version).toMatch(/\.\d{3}000$/);
  });
});
