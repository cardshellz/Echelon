/**
 * Repository guarantees around the primary flag on warehouse.product_locations.
 *
 * Invariants protected:
 *   1. Deleting a variant's primary slot promotes its best remaining active,
 *      bin-backed sibling inside the same transaction, and re-stamps open
 *      UNASSIGNED lines with that bin afterwards. Deleting a secondary slot,
 *      or a row that no longer exists, promotes nothing.
 *   2. Promotion ranks a usable pick face first and is scoped to the variant
 *      (or the SKU for legacy rows), never the product.
 *   3. setPrimaryLocation never demotes by product id — the pre-2026-05-14
 *      product-wide demotion is gone for good.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../orders/bin-location-backfill", () => ({
  backfillOpenOrderItemBinAssignment: vi.fn(async () => 0),
}));

import {
  deleteProductLocation,
  promoteBestRemainingSlot,
} from "../../infrastructure/warehouse.repository";
import { backfillOpenOrderItemBinAssignment } from "../../../orders/bin-location-backfill";

const REPOSITORY_SRC = readFileSync(
  resolve(__dirname, "../../infrastructure/warehouse.repository.ts"),
  "utf-8",
);

function sqlTextOf(query: any): string {
  const chunks: unknown[] = query?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).value)) {
        return (chunk as any).value.join("");
      }
      if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).queryChunks)) {
        return sqlTextOf(chunk);
      }
      return "";
    })
    .join("");
}

function makeTx(results: Array<{ rows: unknown[] }>) {
  const execute = vi.fn();
  for (const result of results) execute.mockResolvedValueOnce(result);
  execute.mockResolvedValue({ rows: [] });
  const inner = { execute };
  const tx = { execute, transaction: vi.fn(async (fn: (t: any) => Promise<any>) => fn(inner)) };
  return { tx, execute };
}

describe("deleteProductLocation", () => {
  it("promotes the best remaining sibling when the deleted slot was primary, then backfills open lines", async () => {
    vi.mocked(backfillOpenOrderItemBinAssignment).mockClear();
    const { tx, execute } = makeTx([
      { rows: [{ id: 404, product_variant_id: 65, sku: "ARM-ENV-GRD-C60", is_primary: 1 }] },
      { rows: [{ id: 405, sku: "ARM-ENV-GRD-C60", location: "G-02", zone: "G" }] },
    ]);

    const deleted = await deleteProductLocation(404, tx as any);

    expect(deleted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sqlTextOf(execute.mock.calls[0][0])).toContain("DELETE FROM warehouse.product_locations");
    const promotion = sqlTextOf(execute.mock.calls[1][0]);
    expect(promotion).toContain("SET is_primary = 1");
    expect(promotion).toContain("pl.status = 'active'");
    expect(promotion).toContain("pl.warehouse_location_id IS NOT NULL");
    expect(promotion).toContain("pl.product_variant_id = ");
    expect(promotion).not.toContain("product_id = ");
    expect(promotion).toMatch(/wl\.location_type = 'pick'[\s\S]*pl\.is_primary DESC,[\s\S]*pl\.updated_at DESC,[\s\S]*pl\.id ASC/);
    expect(backfillOpenOrderItemBinAssignment).toHaveBeenCalledWith({
      sku: "ARM-ENV-GRD-C60",
      locationCode: "G-02",
      zone: "G",
    });
  });

  it("promotes nothing when the deleted slot was secondary", async () => {
    vi.mocked(backfillOpenOrderItemBinAssignment).mockClear();
    const { tx, execute } = makeTx([
      { rows: [{ id: 403, product_variant_id: 64, sku: "ARM-ENV-GRD-P10", is_primary: 0 }] },
    ]);

    expect(await deleteProductLocation(403, tx as any)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(backfillOpenOrderItemBinAssignment).not.toHaveBeenCalled();
  });

  it("returns false and promotes nothing when the row does not exist", async () => {
    vi.mocked(backfillOpenOrderItemBinAssignment).mockClear();
    const { tx, execute } = makeTx([{ rows: [] }]);

    expect(await deleteProductLocation(1, tx as any)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(backfillOpenOrderItemBinAssignment).not.toHaveBeenCalled();
  });

  it("does not backfill when the primary was deleted but no eligible sibling remains", async () => {
    vi.mocked(backfillOpenOrderItemBinAssignment).mockClear();
    const { tx } = makeTx([
      { rows: [{ id: 1250, product_variant_id: 59, sku: "SHLZ-MAG-STND-P5", is_primary: 1 }] },
      { rows: [] },
    ]);

    expect(await deleteProductLocation(1250, tx as any)).toBe(true);
    expect(backfillOpenOrderItemBinAssignment).not.toHaveBeenCalled();
  });
});

describe("promoteBestRemainingSlot", () => {
  it("runs no SQL for a row that has neither a variant nor a SKU", async () => {
    const execute = vi.fn();
    expect(await promoteBestRemainingSlot({ execute } as any, { productVariantId: null, sku: null })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("matches legacy SKU-keyed rows when there is no variant id", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 7, sku: "LEGACY", location: "B-01", zone: "B" }] }));
    const promoted = await promoteBestRemainingSlot({ execute } as any, { productVariantId: null, sku: "legacy" });
    expect(promoted).toEqual({ id: 7, sku: "LEGACY", location: "B-01", zone: "B" });
    const text = sqlTextOf(execute.mock.calls[0][0]);
    expect(text).toContain("FALSE");
    expect(text).toContain("UPPER(pl.sku) = ");
  });
});

describe("setPrimaryLocation", () => {
  const body = REPOSITORY_SRC.match(/export async function setPrimaryLocation\([\s\S]*?\n}\n/)?.[0] ?? "";

  it("scopes demotion to the variant or SKU and never to the product", () => {
    expect(body).not.toBe("");
    expect(body).not.toContain("eq(productLocations.productId");
    expect(body).toContain("eq(productLocations.productVariantId, location.productVariantId)");
    expect(body).toContain("eq(productLocations.sku, location.sku.toUpperCase())");
    expect(body).toContain("ne(productLocations.id, productLocationId)");
    expect(body).toContain("refusing to scope a primary demotion");
  });

  it("no longer carries the dead product-wide writer", () => {
    expect(REPOSITORY_SRC).not.toContain("addProductToLocation");
  });
});
