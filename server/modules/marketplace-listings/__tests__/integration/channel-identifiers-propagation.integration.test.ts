import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingIntentBase } from "../fixtures/listing-intent.fixture";
import { PostgresListingIntentPropagationRepository } from "../../infrastructure/pg-listing-intent-propagation.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const migration = "migrations/900000038000019430001_catalog_variant_mpn_listing_intent.sql";

(url && disposable ? describe : describe.skip).sequential("canonical variant identifiers through shared PostgreSQL propagation", () => {
  let database: InventoryCutoverTestDatabase;
  const now = new Date("2026-10-29T12:00:00Z");
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, listingIntentBase);
    await database.pool.query(`ALTER TABLE catalog.product_variants ADD COLUMN mpn varchar(100),
      ADD COLUMN weight_grams numeric(10,2), ADD COLUMN length_mm numeric(10,2),
      ADD COLUMN width_mm numeric(10,2), ADD COLUMN height_mm numeric(10,2);
      UPDATE catalog.product_variants SET mpn='EXISTING-PART' WHERE id=101;`);
    for (const file of [
      "900000018000018580002_listing_intent_propagation.sql",
      "900000019000018700001_listing_intent_lifecycle_disposition.sql",
      "900000030000019110001_catalog_shipping_package_type.sql",
      "900000032000019150001_retire_catalog_shipping_package_type.sql",
    ]) await database.pool.query(await readFile(`migrations/${file}`, "utf8"));
  });
  afterEach(async () => { await database?.close(); });
  const install = async () => database.pool.query(await readFile(migration, "utf8"));
  const triggerArguments = async (): Promise<string[]> => {
    const row = (await database.pool.query("SELECT encode(tgargs,'escape') AS args FROM pg_trigger WHERE tgrelid='catalog.product_variants'::regclass AND tgname='listing_intent_invalidation'")).rows[0];
    return row.args.split("\\000");
  };

  it("extends the one existing trigger idempotently without changing saved values or historical evidence", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET name='Current name' WHERE id=101");
    const argumentsBefore = await triggerArguments();
    const evidence = (await database.pool.query("SELECT * FROM marketplace.listing_intent_changes ORDER BY id")).rows;
    expect(argumentsBefore[1].split(",")).not.toContain("mpn");
    expect(evidence).toHaveLength(1);
    await install();
    await install();
    const argumentsAfter = await triggerArguments();
    expect(argumentsAfter[0]).toBe(argumentsBefore[0]);
    expect(argumentsAfter.slice(2)).toEqual(argumentsBefore.slice(2));
    expect(argumentsAfter[1].split(",")).toEqual([...new Set([...argumentsBefore[1].split(","), "mpn"])].sort());
    expect((await database.pool.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='catalog.product_variants'::regclass AND tgname='listing_intent_invalidation'")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT mpn FROM catalog.product_variants WHERE id=101")).rows[0].mpn).toBe("EXISTING-PART");
    expect((await database.pool.query("SELECT * FROM marketplace.listing_intent_changes ORDER BY id")).rows).toEqual(evidence);
  });

  it("captures edits and clearing transactionally, ignores no-ops and fans out once to every connected channel", async () => {
    await install();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE catalog.product_variants SET mpn='ROLLED-BACK' WHERE id=101");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await database.pool.query("SELECT mpn FROM catalog.product_variants WHERE id=101")).rows[0].mpn).toBe("EXISTING-PART");
    expect((await database.pool.query("SELECT * FROM marketplace.listing_intent_changes")).rowCount).toBe(0);
    await database.pool.query("UPDATE catalog.product_variants SET mpn='NEW-PART' WHERE id=101");
    await database.pool.query("UPDATE catalog.product_variants SET mpn='NEW-PART' WHERE id=101");
    expect((await database.pool.query("SELECT changed_fields FROM marketplace.listing_intent_changes")).rows).toEqual([{ changed_fields: ["mpn"] }]);
    const repository = new PostgresListingIntentPropagationRepository(database.pool);
    await Promise.all([repository.expand(20, now), repository.expand(20, now)]);
    const deliveries = (await database.pool.query("SELECT destination_key,destination,product_id FROM marketplace.listing_intent_deliveries ORDER BY destination_key")).rows;
    expect(deliveries.filter(row => row.destination.kind === "channel").map(row => row.destination.channelId).sort()).toEqual([34, 35, 36]);
    expect(deliveries.filter(row => row.destination.kind === "dropship").map(row => row.destination.connectionId)).toEqual([40]);
    expect(new Set(deliveries.map(row => row.destination_key)).size).toBe(deliveries.length);
    expect(deliveries.every(row => row.product_id === 20)).toBe(true);
    await repository.expand(20, now);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM marketplace.listing_intent_deliveries")).rows[0].count).toBe(deliveries.length);
    await database.pool.query("UPDATE catalog.product_variants SET mpn=NULL WHERE id=101");
    expect((await database.pool.query("SELECT mpn FROM catalog.product_variants WHERE id=101")).rows[0].mpn).toBeNull();
    expect((await database.pool.query("SELECT changed_fields FROM marketplace.listing_intent_changes ORDER BY id")).rows).toEqual([
      { changed_fields: ["mpn"] }, { changed_fields: ["mpn"] },
    ]);
  });

  it.each([
    ["product", "id,name", "id,product_id"],
    ["variant", "", "id,product_id"],
    ["variant", "id,name", ""],
  ])("refuses incompatible capture arguments %s/%s/%s without replacing the owner", async (kind, watched, scope) => {
    // Values are test-owned constants; the production migration never accepts
    // arbitrary identifiers or repairs an incompatible source configuration.
    await database.pool.query(`CREATE OR REPLACE TRIGGER listing_intent_invalidation
      AFTER INSERT OR UPDATE OR DELETE ON catalog.product_variants FOR EACH ROW
      EXECUTE FUNCTION marketplace.capture_listing_intent_change('${kind}','${watched}','${scope}','')`);
    const before = await triggerArguments();
    await expect(install()).rejects.toMatchObject({ code: "P0001", message: "Expected Catalog listing-intent trigger is missing or incompatible" });
    expect(await triggerArguments()).toEqual(before);
    expect((await database.pool.query("SELECT mpn FROM catalog.product_variants WHERE id=101")).rows[0].mpn).toBe("EXISTING-PART");
    expect((await database.pool.query("SELECT * FROM marketplace.listing_intent_changes")).rowCount).toBe(0);
  });
});
