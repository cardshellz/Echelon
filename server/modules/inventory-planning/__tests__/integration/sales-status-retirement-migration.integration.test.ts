import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const migration = (file: string) => readFileSync(resolve(process.cwd(), "migrations", file), "utf8");
const CREATE = "900000057000020130001_inventory_sales_statuses.sql";
const RETIRE = "900000061000020670001_retire_inventory_sales_statuses.sql";

/** Only what the sales status tables reference; the two migrations under test are the real files. */
const baseSql = `
  CREATE SCHEMA inventory; CREATE SCHEMA channels; CREATE SCHEMA catalog;
  CREATE TABLE channels.channels (id integer PRIMARY KEY);
  CREATE TABLE catalog.products (id integer PRIMARY KEY);
  CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL);
  INSERT INTO channels.channels VALUES (36), (67);
  INSERT INTO catalog.products VALUES (11);
  INSERT INTO catalog.product_variants VALUES (21, 11), (22, 11);
`;

const INSERT = `INSERT INTO inventory.sales_statuses (channel_id, product_id, product_variant_id, status, revision, updated_by, updated_at)
  VALUES ($1, NULL, $2, $3, nextval('inventory.sales_status_revision_seq'), 'admin', '2026-11-08T03:32:53Z')`;

/**
 * The release that removes sales status stops reading inventory.sales_statuses,
 * so a SKU still stopped there would start selling. This proves the migration
 * refuses that release, and that afterwards the table cannot gain a setting
 * nothing would honour.
 */
(url && disposable ? describe : describe.skip).sequential("retiring sales status", () => {
  let database: InventoryCutoverTestDatabase;

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, baseSql);
    await database.pool.query(migration(CREATE));
  }, 60_000);
  afterEach(async () => { await database?.close(); });

  /** One transaction per migration, as the release runner applies it. */
  async function release(): Promise<void> {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration(RETIRE));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  const retired = async () => (await database.pool.query(
    "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'sales_statuses_retired_chk'")).rows[0].n === 1;
  const settings = async () => (await database.pool.query(
    "SELECT channel_id, product_variant_id, status FROM inventory.sales_statuses ORDER BY id")).rows;

  it("refuses the release while a SKU is still stopped, and changes nothing", async () => {
    await database.pool.query(INSERT, [null, 22, "stopped"]);

    await expect(release()).rejects.toMatchObject({
      code: "55000", message: "SALES_STATUS_STOPS_REMAIN",
      detail: "1 stopped sales status setting(s) remain in inventory.sales_statuses.",
    });

    expect(await retired()).toBe(false);
    expect(await settings()).toEqual([{ channel_id: null, product_variant_id: 22, status: "stopped" }]);
    // The old release keeps working: the stop can still be cleared, after which the release goes through.
    await database.pool.query("DELETE FROM inventory.sales_statuses");
    await release();
    expect(await retired()).toBe(true);
  });

  it("refuses for a stop on one channel as well as on all channels", async () => {
    await database.pool.query(INSERT, [67, 21, "stopped"]);
    await expect(release()).rejects.toMatchObject({ message: "SALES_STATUS_STOPS_REMAIN" });
    expect(await retired()).toBe(false);
  });

  it("releases with no settings and then refuses every new or changed setting", async () => {
    await release();

    expect(await retired()).toBe(true);
    await expect(database.pool.query(INSERT, [null, 22, "stopped"])).rejects.toMatchObject({ constraint: "sales_statuses_retired_chk" });
    await expect(database.pool.query(INSERT, [36, 22, "selling"])).rejects.toMatchObject({ constraint: "sales_statuses_retired_chk" });
    expect(await settings()).toEqual([]);
  });

  it("leaves a harmless Selling exception and the history in place, frozen but removable", async () => {
    await database.pool.query(INSERT, [36, 22, "selling"]);
    await database.pool.query(`INSERT INTO inventory.sales_status_events
      (idempotency_key, request_hash, channel_id, product_id, product_variant_id, before_status, after_status,
       before_revision, after_revision, note, actor, occurred_at)
      VALUES ('k1', repeat('a', 64), 36, 11, 22, NULL, 'selling', NULL, 1, NULL, 'admin', '2026-11-08T03:32:53Z')`);

    await release();

    expect(await settings()).toEqual([{ channel_id: 36, product_variant_id: 22, status: "selling" }]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.sales_status_events")).rows[0].n).toBe(1);
    await expect(database.pool.query(
      "UPDATE inventory.sales_statuses SET status = 'stopped', revision = nextval('inventory.sales_status_revision_seq')"))
      .rejects.toMatchObject({ constraint: "sales_statuses_retired_chk" });
    await database.pool.query("DELETE FROM inventory.sales_statuses");
    expect(await settings()).toEqual([]);
  });
});
