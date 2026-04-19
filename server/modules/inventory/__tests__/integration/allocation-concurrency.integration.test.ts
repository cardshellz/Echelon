import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestDb, runMigrations, truncateTestData, closeTestDb } from "../../../../../test/setup-integration";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { InventoryRepository } from "../../infrastructure/inventory.repository";
import { 
  inventoryLevels, 
  products, 
  productVariants, 
  warehouses, 
  warehouseLocations 
} from "@shared/schema";
import { sql } from "drizzle-orm";

describe("Allocation Concurrency (P0-c-3)", () => {
  let db: any;
  let useCases: InventoryUseCases;

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();

    // The repo and useCases point to the test db instance
    const repo = new InventoryRepository(db as any);
    useCases = new InventoryUseCases(db as any, repo);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("should rigidly serialize competing picks using SELECT FOR UPDATE", async () => {
    await truncateTestData();

    // 1. Setup seed data
    const [warehouse] = await db.insert(warehouses)
      .values({ name: "Test Hub", status: "active", isFulfillmentHub: true })
      .returning();

    const [location] = await db.insert(warehouseLocations)
      .values({ 
        warehouseId: warehouse.id, 
        name: "A-1-1", 
        type: "pick", 
        zone: "A" 
      })
      .returning();

    const [product] = await db.insert(products)
      .values({ name: "TEST PRODUCT", baseUnit: "piece", inventoryType: "inventory" })
      .returning();

    const [variant] = await db.insert(productVariants)
      .values({ 
        productId: product.id, 
        name: "Default", 
        sku: "CONCURRENCY-1", 
        unitsPerVariant: 1 
      })
      .returning();

    // 2. Pre-seed inventory: exactly 5 available units
    await db.insert(inventoryLevels)
      .values({
        warehouseLocationId: location.id,
        productVariantId: variant.id,
        variantQty: 5,
        reservedQty: 0,
        pickedQty: 0,
        packedQty: 0, 
        backorderQty: 0
      });

    // 3. Dispatch 10 parallel overlapping asynchronous pick requests asking for 1 unit each
    const promises = Array.from({ length: 10 }).map(async (_, idx) => {
      try {
        await useCases.pickItem({
          warehouseLocationId: location.id,
          productVariantId: variant.id,
          qty: 1,
          referenceId: `PICK-${idx}`,
        });
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    const results = await Promise.all(promises);

    // 4. Assert isolation invariants 
    // Exact 5 successes, exact 5 errors from the quantity guard.
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes).toHaveLength(5);
    expect(failures).toHaveLength(5);
    
    // Validate failures are because of guard failure ("Insufficient variant qty: needs X, has Y")
    failures.forEach((f) => {
      expect(f.error).toMatch(/Insufficient variant qty/i);
    });

    // 5. Final constraint check
    const finalRowQuery = await db.execute(sql`
      SELECT variant_qty, picked_qty FROM inventory.inventory_levels 
      WHERE warehouse_location_id = ${location.id} 
        AND product_variant_id = ${variant.id}
    `);
    
    const finalRow = finalRowQuery.rows[0] as any;
    expect(Number(finalRow.variant_qty)).toBe(0);
    expect(Number(finalRow.picked_qty)).toBe(5);
  });
});
