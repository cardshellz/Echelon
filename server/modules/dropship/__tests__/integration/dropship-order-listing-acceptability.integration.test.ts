import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipOrderProcessingIntakeRecord } from "../../application/dropship-order-processing-service";
import { PgDropshipOrderProcessingRepository } from "../../infrastructure/dropship-order-processing.repository";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingPushRunsBaseFixtureSql } from "../fixtures/listing-push-runs.fixture";

/**
 * Orders during re-sends against a real PostgreSQL (step 1 plan S2-5 §4.7,
 * SAFETY16, D30): the real quoting candidate query over listing rows in every
 * status the 0086 CHECK allows. A listing being re-sent (queued, pushing,
 * failed, blocked) that carries its eBay listing id is quoted; one without an
 * id, or ended, is refused as before; the catalog check still applies.
 *
 * Deviation (recorded in BUILD-NOTES A2): the plan names
 * dropship-canonical-acceptance-stage.integration.test.ts, whose fixture has
 * no listing or catalog tables, so it cannot run either candidate query. The
 * acceptance path's wiring is covered by the stubbed-transaction suite
 * (dropship-order-acceptance.repository.transaction.test.ts); its candidate
 * SQL selects the same listing columns as this one.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const NOW = new Date("2026-10-20T12:00:00.000Z");
const VENDOR = 10;
const STORE = 22;
const SIZE = 1001;

/** The columns listActiveDropshipCatalogRules reads that the shared fixture's reduced rules table lacks (0086). */
const orderFixtureSql = `
  ${listingPushRunsBaseFixtureSql}
  ALTER TABLE dropship.dropship_catalog_rules ADD COLUMN revision_id integer, ADD COLUMN notes text,
    ADD COLUMN metadata jsonb, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
`;

describeDatabase.sequential("orders on listings being re-sent (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, orderFixtureSql);
    pool = database.pool;
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE dropship.dropship_vendor_listings, dropship.dropship_catalog_rules,
      dropship.dropship_store_connections, dropship.dropship_vendors, catalog.product_variants, catalog.products
      RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform) VALUES (${STORE}, ${VENDOR}, 'ebay');
      INSERT INTO dropship.dropship_catalog_rules (scope_type, action) VALUES ('catalog', 'include');
      INSERT INTO catalog.products (id, sku, name, category) VALUES (1, 'ENV', 'Envelope', 'Supplies');
      INSERT INTO catalog.product_variants (id, product_id, sku, name) VALUES (${SIZE}, 1, 'ENV-50', 'Pack of 50');
    `);
  });

  async function listing(status: string, externalListingId: string | null): Promise<void> {
    await pool.query(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
      VALUES ($1, $2, $3, 'ebay', $4, $5)`, [VENDOR, STORE, SIZE, status, externalListingId]);
  }

  function intake(line: { productVariantId?: number; externalListingId?: string }): DropshipOrderProcessingIntakeRecord {
    return {
      intakeId: 77, vendorId: VENDOR, storeConnectionId: STORE, platform: "ebay", externalOrderId: "EBAY-ORDER-77",
      status: "processing", paymentHoldExpiresAt: null,
      normalizedPayload: { lines: [{ ...line, quantity: 1 }], shipTo: { country: "US" } } as DropshipOrderProcessingIntakeRecord["normalizedPayload"],
    };
  }

  const quote = (line: { productVariantId?: number; externalListingId?: string }) =>
    new PgDropshipOrderProcessingRepository(pool).resolveQuoteItems({ intake: intake(line), now: NOW });

  it.each(["queued", "pushing", "failed", "blocked", "active", "paused", "drift_detected"])(
    "quotes an order on a %s listing that carries its eBay listing id",
    async (status) => {
      await listing(status, "110012345678");
      await expect(quote({ productVariantId: SIZE })).resolves.toEqual([{ lineIndex: 0, productVariantId: SIZE, quantity: 1 }]);
    },
  );

  it("finds a re-sent listing by the eBay listing id an eBay order line carries", async () => {
    await listing("queued", "110012345678");
    await expect(quote({ externalListingId: "110012345678" })).resolves.toEqual([{ lineIndex: 0, productVariantId: SIZE, quantity: 1 }]);
  });

  it.each([
    ["queued", null],
    ["failed", "   "],
    ["ended", "110012345678"],
    ["not_listed", null],
    ["preview_ready", null],
  ])("refuses an order on a %s listing with id %j, as before", async (status, externalListingId) => {
    await listing(status, externalListingId);
    await expect(quote({ productVariantId: SIZE })).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PROCESSING_LISTING_NOT_QUOTABLE",
      context: { intakeId: 77, listingStatus: status },
    });
  });

  it("still refuses a re-sent listing whose size Card Shellz no longer offers", async () => {
    await listing("queued", "110012345678");
    await pool.query(`TRUNCATE dropship.dropship_catalog_rules`);
    await expect(quote({ productVariantId: SIZE })).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PROCESSING_VARIANT_NOT_ELIGIBLE",
    });
  });
});
