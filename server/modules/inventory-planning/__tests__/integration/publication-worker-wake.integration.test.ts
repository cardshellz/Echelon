import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresOrderClaimVariantReader } from "../../infrastructure/order-claim-variant.reader";
import { startPublicationWakeListener, type PublicationWakeListenerHandle } from "../../infrastructure/publication-wake-listener";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;

const MIGRATION = readFileSync(
  path.resolve(__dirname, "../../../../../migrations/900000059000020450001_publication_worker_wake.sql"), "utf8");
/** Only the columns the migration's triggers and the claim reader touch. */
const SCHEMA = `
  CREATE SCHEMA inventory;
  CREATE TABLE inventory.publication_selection_work (
    product_id integer PRIMARY KEY, revision bigint NOT NULL DEFAULT 1, acknowledged_revision bigint NOT NULL DEFAULT 0);
  CREATE TABLE inventory.inventory_publication_outbox (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, desired_quantity bigint NOT NULL);
  CREATE TABLE inventory.availability_claims (id bigint PRIMARY KEY, order_id integer NOT NULL, status text NOT NULL);
  CREATE TABLE inventory.availability_claim_lines (id bigint PRIMARY KEY, claim_id bigint NOT NULL, target_variant_id integer NOT NULL);
  CREATE TABLE inventory.availability_claim_resources (id bigint PRIMARY KEY, claim_id bigint NOT NULL, source_variant_id integer NOT NULL);
`;
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

dbDescribe.sequential("committed publication work wakes the worker", () => {
  let database: InventoryCutoverTestDatabase;
  let listener: PublicationWakeListenerHandle;
  let wakes = 0;

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, SCHEMA + MIGRATION);
    wakes = 0;
    listener = startPublicationWakeListener(database.pool, () => { wakes += 1; }, { log: () => {} });
    await settle();
    expect(wakes).toBe(1); // the connect-time wake
    wakes = 0;
  }, 60_000);
  afterEach(async () => {
    await listener?.stop();
    await database?.close();
  });

  it("wakes when a product is first marked changed and when its revision rises", async () => {
    await database.pool.query("INSERT INTO inventory.publication_selection_work(product_id) VALUES (20)");
    await settle();
    expect(wakes).toBe(1);
    await database.pool.query("UPDATE inventory.publication_selection_work SET revision=revision+1 WHERE product_id=20");
    await settle();
    expect(wakes).toBe(2);
  });

  it("does not wake when the worker acknowledges a revision", async () => {
    await database.pool.query("INSERT INTO inventory.publication_selection_work(product_id) VALUES (20)");
    await settle();
    wakes = 0;
    await database.pool.query("UPDATE inventory.publication_selection_work SET acknowledged_revision=revision WHERE product_id=20");
    await settle();
    expect(wakes).toBe(0);
  });

  it("wakes when a quantity is queued for a channel", async () => {
    await database.pool.query("INSERT INTO inventory.inventory_publication_outbox(desired_quantity) VALUES (5)");
    await settle();
    expect(wakes).toBe(1);
  });

  it("wakes only once the writing transaction commits, and never for a rollback", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO inventory.publication_selection_work(product_id) VALUES (21)");
      await settle();
      expect(wakes).toBe(0);
      await client.query("ROLLBACK");
      await settle();
      expect(wakes).toBe(0);
      await client.query("BEGIN");
      await client.query("INSERT INTO inventory.publication_selection_work(product_id) VALUES (21)");
      await client.query("INSERT INTO inventory.inventory_publication_outbox(desired_quantity) VALUES (0)");
      await client.query("COMMIT");
      await settle();
      // PostgreSQL folds identical notifications from one transaction into one.
      expect(wakes).toBe(1);
    } finally { client.release(); }
  });

  it("lists every SKU an order's claims sold or drew stock from, including released claims", async () => {
    await database.pool.query(`
      INSERT INTO inventory.availability_claims(id,order_id,status) VALUES (1,500,'superseded'),(2,500,'active'),(3,501,'active');
      INSERT INTO inventory.availability_claim_lines(id,claim_id,target_variant_id) VALUES (1,1,101),(2,2,101),(3,3,300);
      INSERT INTO inventory.availability_claim_resources(id,claim_id,source_variant_id) VALUES (1,1,102),(2,2,101),(3,3,300);
    `);
    const reader = new PostgresOrderClaimVariantReader(database.pool);
    await expect(reader.listClaimedVariantIds([500])).resolves.toEqual([101, 102]);
    await expect(reader.listClaimedVariantIds([500, 501, 500])).resolves.toEqual([101, 102, 300]);
    await expect(reader.listClaimedVariantIds([999])).resolves.toEqual([]);
    await expect(reader.listClaimedVariantIds([])).resolves.toEqual([]);
    await expect(reader.listClaimedVariantIds([0])).rejects.toThrow();
  });
});
