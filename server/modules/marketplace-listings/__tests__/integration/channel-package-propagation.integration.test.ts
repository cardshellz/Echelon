import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingIntentBase } from "../fixtures/listing-intent.fixture";
import { PostgresListingIntentPropagationRepository } from "../../infrastructure/pg-listing-intent-propagation.repository";
import { coercePackageAttributesOnVariantPayload, serializePackageAttributeUpdates } from "../../../catalog/package-attributes";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(url && disposable ? describe : describe.skip).sequential("catalog package propagation through production PostgreSQL triggers", () => {
  let database: InventoryCutoverTestDatabase;
  const now = new Date("2026-10-24T22:00:00Z");
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, listingIntentBase);
    await database.pool.query(`ALTER TABLE catalog.product_variants ADD COLUMN weight_grams numeric(10,2),
      ADD COLUMN length_mm numeric(10,2), ADD COLUMN width_mm numeric(10,2), ADD COLUMN height_mm numeric(10,2);
      UPDATE catalog.product_variants SET weight_grams=3175.25,length_mm=152.40,width_mm=101.60,height_mm=25.40 WHERE id=101;`);
    await database.pool.query(await readFile("migrations/900000018000018580002_listing_intent_propagation.sql", "utf8"));
    await database.pool.query(await readFile("migrations/900000019000018700001_listing_intent_lifecycle_disposition.sql", "utf8"));
    await database.pool.query(await readFile("migrations/900000030000019110001_catalog_shipping_package_type.sql", "utf8"));
  });
  afterEach(async () => { await database?.close(); });
  const packageRow = async () => (await database.pool.query("SELECT weight_grams,length_mm,width_mm,height_mm,shipping_package_type FROM catalog.product_variants WHERE id=101")).rows[0];

  it("adds no invented facts and preserves every existing decimal measurement", async () => {
    expect(await packageRow()).toEqual({ weight_grams: "3175.25", length_mm: "152.40", width_mm: "101.60", height_mm: "25.40", shipping_package_type: null });
    expect((await database.pool.query("SELECT * FROM marketplace.listing_intent_changes")).rowCount).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='catalog.product_variants'::regclass AND tgname='listing_intent_invalidation'")).rows[0].count).toBe(1);
  });
  it("captures a package correction once, fans out through the existing shared owner, and deduplicates re-expansion", async () => {
    const patch = serializePackageAttributeUpdates(coercePackageAttributesOnVariantPayload({ shippingPackageType: "parcel" }));
    await database.pool.query("UPDATE catalog.product_variants SET shipping_package_type=$1 WHERE id=101", [patch.shippingPackageType]);
    const changes = (await database.pool.query("SELECT * FROM marketplace.listing_intent_changes")).rows;
    expect(changes).toHaveLength(1);
    expect(changes[0].changed_fields).toEqual(["shipping_package_type"]);
    const repository = new PostgresListingIntentPropagationRepository(database.pool);
    await Promise.all([repository.expand(20, now), repository.expand(20, now)]);
    const rows = (await database.pool.query("SELECT destination_key,product_id FROM marketplace.listing_intent_deliveries ORDER BY destination_key")).rows;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map(row => row.destination_key)).size).toBe(rows.length);
    expect(rows.every(row => row.product_id === 20)).toBe(true);
    await repository.expand(20, now);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM marketplace.listing_intent_deliveries")).rows[0].count).toBe(rows.length);
    expect(await packageRow()).toMatchObject({ weight_grams: "3175.25", length_mm: "152.40", shipping_package_type: "parcel" });
  });
  it("retains measurement propagation, ignores no-op saves, and rolls back source and intent together", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE catalog.product_variants SET length_mm=200,shipping_package_type='letter' WHERE id=101");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await database.pool.query("SELECT * FROM marketplace.listing_intent_changes")).rowCount).toBe(0);
    await database.pool.query("UPDATE catalog.product_variants SET length_mm=200,width_mm=180,height_mm=20,weight_grams=3175.25 WHERE id=101");
    await database.pool.query("UPDATE catalog.product_variants SET length_mm=200 WHERE id=101");
    const changes = (await database.pool.query("SELECT changed_fields FROM marketplace.listing_intent_changes")).rows;
    expect(changes).toEqual([{ changed_fields: ["height_mm", "length_mm", "width_mm"] }]);
    await expect(database.pool.query("UPDATE catalog.product_variants SET shipping_package_type='guess' WHERE id=101")).rejects.toMatchObject({ code: "23514" });
  });
});
