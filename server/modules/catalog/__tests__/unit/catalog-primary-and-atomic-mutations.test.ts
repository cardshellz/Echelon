import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { productMethods } from "../../catalog.storage";
import { ProductAssetError } from "../../product-asset-errors";
import { MAX_CATALOG_BATCH_SIZE } from "../../catalog.routes";

function createFakeAssetExecutor(existingAssetIdsForProduct: number[]) {
  const updates: Array<{ values: Record<string, unknown> }> = [];
  const executor = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () =>
          existingAssetIdsForProduct.map((id) => ({ id })),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push({ values });
        return {
          where: vi.fn(async () => []),
        };
      }),
    })),
  };
  return { executor, updates };
}

describe("Catalog Primary Asset & Atomic Mutation Guards (CAT-1: CWF-F01, CWF-F02, CWF-F04)", () => {
  describe("setPrimaryProductAsset (CWF-F02)", () => {
    it("rejects non-positive or non-integer productId or assetId with 400 ASSET_PRIMARY_INVALID before querying", async () => {
      const { executor, updates } = createFakeAssetExecutor([11]);

      await expect(
        productMethods.setPrimaryProductAsset(0, 11, executor),
      ).rejects.toMatchObject({
        name: "ProductAssetError",
        code: "ASSET_PRIMARY_INVALID",
        status: 400,
      });

      await expect(
        productMethods.setPrimaryProductAsset(100, -5, executor),
      ).rejects.toMatchObject({
        name: "ProductAssetError",
        code: "ASSET_PRIMARY_INVALID",
        status: 400,
      });

      expect(executor.select).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("throws 404 ASSET_NOT_FOUND when the target asset does not belong to the product without clearing the existing primary", async () => {
      const { executor, updates } = createFakeAssetExecutor([]);

      let thrown: unknown;
      try {
        await productMethods.setPrimaryProductAsset(100, 999999, executor);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ProductAssetError);
      expect(thrown).toMatchObject({
        code: "ASSET_NOT_FOUND",
        status: 404,
      });
      // Critical invariant: no UPDATE statement ran to wipe the existing primary asset!
      expect(executor.update).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("clears the old primary and sets the new primary when the target asset exists on the product", async () => {
      const { executor, updates } = createFakeAssetExecutor([42]);

      await productMethods.setPrimaryProductAsset(100, 42, executor);

      expect(executor.select).toHaveBeenCalledTimes(1);
      expect(updates).toEqual([
        { values: { isPrimary: 0 } },
        { values: { isPrimary: 1 } },
      ]);
    });
  });

  describe("Catalog route transactional and batch-bound invariants (CWF-F01, CWF-F02, CWF-F04)", () => {
    const routesSource = readFileSync(
      resolve(process.cwd(), "server/modules/catalog/catalog.routes.ts"),
      "utf8",
    );

    it("exports a bounded MAX_CATALOG_BATCH_SIZE of 500", () => {
      expect(MAX_CATALOG_BATCH_SIZE).toBe(500);
    });

    it("wraps non-legacy POST /api/products creation in db.transaction so product and variants commit or roll back together (CWF-F01)", () => {
      expect(routesSource).toContain(": await db.transaction((tx) => createProduct(tx));");
    });

    it("wraps DELETE /api/products/:id variant and product deletions in a single db.transaction (CWF-F01)", () => {
      const deleteIdx = routesSource.indexOf('app.delete("/api/products/:id"');
      expect(deleteIdx).toBeGreaterThan(-1);
      const deleteSlice = routesSource.slice(deleteIdx, deleteIdx + 900);
      expect(deleteSlice).toContain("await db.transaction(async (tx) =>");
      expect(deleteSlice).toContain("storage.getProductVariantsByProductId(id, tx)");
      expect(deleteSlice).toContain("storage.deleteProductVariant(variant.id, tx)");
      expect(deleteSlice).toContain("storage.deleteProduct(id, tx)");
    });

    it("maps ProductAssetError status and code in PUT /api/product-assets/:id/primary (CWF-F02)", () => {
      const primaryIdx = routesSource.indexOf('app.put("/api/product-assets/:id/primary"');
      expect(primaryIdx).toBeGreaterThan(-1);
      const primarySlice = routesSource.slice(primaryIdx, primaryIdx + 1400);
      expect(primarySlice).toContain("error instanceof ProductAssetError");
      expect(primarySlice).toContain("res.status(error.status).json({ error: error.message, code: error.code })");
    });

    it("enforces MAX_CATALOG_BATCH_SIZE on shipping-groups/assign and product-variants/bulk-parent and runs bulk-parent inside db.transaction (CWF-F04)", () => {
      const assignIdx = routesSource.indexOf('app.post("/api/shipping-groups/assign"');
      expect(assignIdx).toBeGreaterThan(-1);
      const assignSlice = routesSource.slice(assignIdx, assignIdx + 700);
      expect(assignSlice).toContain("requestedProductIds.length > MAX_CATALOG_BATCH_SIZE");
      expect(assignSlice).toContain("BATCH_LIMIT_EXCEEDED");

      const bulkParentIdx = routesSource.indexOf('app.post("/api/product-variants/bulk-parent"');
      expect(bulkParentIdx).toBeGreaterThan(-1);
      const bulkParentSlice = routesSource.slice(bulkParentIdx, bulkParentIdx + 1800);
      expect(bulkParentSlice).toContain("rows.length > MAX_CATALOG_BATCH_SIZE");
      expect(bulkParentSlice).toContain("BATCH_LIMIT_EXCEEDED");
      expect(bulkParentSlice).toContain("await db.transaction(async (tx) =>");
    });
  });
});
