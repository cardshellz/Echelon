import { readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { omsWarehouseCancellationSql, omsWarehouseFinancialStopSql } from "../../order-merchandise-state.sql";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const prerequisites = `CREATE SCHEMA oms;
CREATE TABLE oms.oms_orders(id integer PRIMARY KEY,channel_id integer,status text,financial_status text);
INSERT INTO oms.oms_orders VALUES(1,36,'confirmed','paid'),(2,36,'confirmed','refunded'),
 (3,36,'refunded','refunded'),(4,36,'cancelled','paid'),(5,37,'confirmed','refunded'),(6,36,'shipped','paid');
CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY, quantity integer,channel_observed_quantity integer,paid_quantity integer);
CREATE TABLE oms.oms_order_line_authority_events(id bigint PRIMARY KEY);
CREATE TABLE oms.order_line_adjustments(id bigint PRIMARY KEY);
INSERT INTO oms.oms_order_lines VALUES(1,3,3,3);`;

(url && disposable ? describe : describe.skip).sequential(
  "channel merchandise additive migration in PostgreSQL",
  () => {
    let database: InventoryCutoverTestDatabase;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        prerequisites,
      );
      await database.pool.query(
        await readFile(
          new URL(
            "../../../../../migrations/900000029000019090001_channel_merchandise_quantity_authority.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    });
    afterAll(async () => {
      await database?.close();
    });
    afterEach(() => vi.unstubAllEnvs());
    async function cancelled(includeShipped = false) {
      const query = new PgDialect()
        .sqlToQuery(sql`SELECT id FROM oms.oms_orders source
      WHERE ${omsWarehouseCancellationSql("source", { legacyFinancialStatuses: ["refunded", "voided"], includeShipped })} ORDER BY id`);
      return (await database.pool.query(query.sql, query.params)).rows.map(
        (row) => row.id,
      );
    }
    it("preserves disabled channels and limits enabled cleanup to commercial cancellations", async () => {
      vi.stubEnv("OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED", "false");
      expect(await cancelled()).toEqual([2, 3, 4, 5]);
      vi.stubEnv("OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED", "true");
      vi.stubEnv("OMS_CHANNEL_MERCHANDISE_CHANNEL_IDS", "36");
      expect(await cancelled()).toEqual([4, 5]);
      expect(await cancelled(true)).toEqual([4, 5, 6]);
    });
    it.each([
      [false, 36, "refunded", true],
      [true, 36, "refunded", false],
      [true, 37, "refunded", true],
      [true, 36, "voided", true],
      [false, 36, "voided", true],
      [true, 36, "paid", false],
      [true, null, "refunded", true],
      [true, null, null, false],
    ] as const)("keeps physical read/projection gates separate: enabled=%s channel=%s cash=%s", async (enabled, channelId, financialStatus, blocked) => {
      vi.stubEnv("OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED", String(enabled));
      vi.stubEnv("OMS_CHANNEL_MERCHANDISE_CHANNEL_IDS", "36");
      const query = new PgDialect().sqlToQuery(sql`SELECT ${omsWarehouseFinancialStopSql(
        sql`${channelId}::integer`, sql`${financialStatus}::text`,
      )} AS blocked`);
      expect((await database.pool.query(query.sql, query.params)).rows).toEqual([{ blocked }]);
    });
    it("leaves historical quantities and payment evidence unchanged and unknown current quantities null", async () => {
      expect(
        (
          await database.pool.query(
            "SELECT * FROM oms.oms_order_lines WHERE id=1",
          )
        ).rows[0],
      ).toEqual({
        id: "1",
        quantity: 3,
        channel_observed_quantity: 3,
        paid_quantity: 3,
        channel_current_quantity: null,
        channel_quantity_updated_at: null,
      });
    });
    it.each([
      "channel_current_quantity=1",
      "channel_quantity_updated_at=now()",
      "channel_current_quantity=-1,channel_quantity_updated_at=now()",
      "channel_current_quantity=4,channel_quantity_updated_at=now()",
    ])(
      "rejects incomplete or impossible merchandise evidence: %s",
      async (update) => {
        await expect(
          database.pool.query(
            `UPDATE oms.oms_order_lines SET ${update} WHERE id=1`,
          ),
        ).rejects.toMatchObject({ code: "23514" });
      },
    );
    it("stores an explicit zero independently from historical purchased and paid units", async () => {
      await database.pool.query(
        "UPDATE oms.oms_order_lines SET channel_current_quantity=0,channel_quantity_updated_at='2026-10-24T12:00:00Z' WHERE id=1",
      );
      expect(
        (
          await database.pool.query(
            "SELECT quantity,paid_quantity,channel_current_quantity FROM oms.oms_order_lines WHERE id=1",
          )
        ).rows[0],
      ).toEqual({ quantity: 3, paid_quantity: 3, channel_current_quantity: 0 });
    });
    it("keeps a saved demand reduction stable after an idempotent retry", async () => {
      await database.pool.query(
        "INSERT INTO oms.order_line_adjustments VALUES(1,NULL)",
      );
      await database.pool.query(
        "UPDATE oms.order_line_adjustments SET merchandise_reduction_quantity=1 WHERE id=1",
      );
      await database.pool.query(
        "UPDATE oms.order_line_adjustments SET merchandise_reduction_quantity=1 WHERE id=1",
      );
      await expect(
        database.pool.query(
          "UPDATE oms.order_line_adjustments SET merchandise_reduction_quantity=0 WHERE id=1",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  },
);
