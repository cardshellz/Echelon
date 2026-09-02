/**
 * Primary-flag guarantees of the slot assignment writer.
 *
 * Invariants protected:
 *   1. The writer keeps one slot per variant and that slot is always primary:
 *      isPrimary=0 (which once stranded a SKU's only slot) is refused before
 *      any database work, and non-integer flags are refused too.
 *   2. Sibling demotion runs on every save and is scoped to the variant (or
 *      legacy SKU-keyed rows), never to the product — the pre-2026-05-14 bug.
 *   3. The saved row is written with is_primary = 1.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../orders/bin-location-backfill", () => ({
  backfillOpenOrderItemBinAssignment: vi.fn(async () => 0),
}));

import { BinAssignmentService } from "../../bin-assignment.service";
import { BinAssignmentValidationError } from "../../bin-assignment-contracts";
import { backfillOpenOrderItemBinAssignment } from "../../../orders/bin-location-backfill";

function sqlTextOf(query: any): string {
  const chunks: unknown[] = query?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).value)) {
        return (chunk as any).value.join("");
      }
      return "";
    })
    .join("");
}

function makeHarness(existingRows: Array<{ id: number }> = [{ id: 997 }]) {
  const setCalls: Record<string, unknown>[] = [];
  const valuesCalls: Record<string, unknown>[] = [];
  const tx = {
    execute: vi.fn()
      .mockResolvedValueOnce({ rows: existingRows }) // canonical-row lookup
      .mockResolvedValue({ rows: [] }),              // demotion + anything after
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: existingRows[0]?.id ?? 1250, sku: "SHLZ-MAG-STND-P5", location: "E-12", zone: "E", ...values }]),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        valuesCalls.push(values);
        return { returning: vi.fn(async () => [{ id: 1250, sku: "SHLZ-MAG-STND-P5", location: "E-12", zone: "E", ...values }]) };
      }),
    })),
  };
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (fn: (t: any) => Promise<any>) => fn(tx)),
  };
  const storage = {
    getProductVariantById: vi.fn(async (id: number) => ({ id, sku: "SHLZ-MAG-STND-P5", productId: 30, name: "Mag Stand P5" })),
    getProductVariantBySku: vi.fn(),
    getWarehouseLocationById: vi.fn(async (id: number) => ({
      id, code: "E-12", zone: "E", warehouseId: 1, isActive: 1, locationType: "pick", isPickable: 1,
    })),
    getWarehouseLocationByCode: vi.fn(),
    getProductById: vi.fn(async (id: number) => ({ id, name: "Mag Stand", sku: "SHLZ-MAG-STND" })),
    getProductLocationById: vi.fn(),
    deleteProductLocation: vi.fn(),
  };
  const service = new BinAssignmentService(db as any, storage as any);
  return { service, db, tx, storage, setCalls, valuesCalls };
}

describe("BinAssignmentService.assignVariantToLocation :: primary flag", () => {
  it("refuses isPrimary=0 before reading or writing anything", async () => {
    const { service, db, storage } = makeHarness();
    await expect(
      service.assignVariantToLocation({ productVariantId: 59, warehouseLocationId: 1, isPrimary: 0 }),
    ).rejects.toMatchObject({ name: "BinAssignmentValidationError", code: "BIN_ASSIGNMENT_PRIMARY_REQUIRED" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(storage.getProductVariantById).not.toHaveBeenCalled();
    expect(storage.getWarehouseLocationById).not.toHaveBeenCalled();
  });

  it.each([2, -1, "1", true])("refuses a non-literal flag %j before touching the database", async (flag) => {
    const { service, db } = makeHarness();
    await expect(
      service.assignVariantToLocation({ productVariantId: 59, warehouseLocationId: 1, isPrimary: flag as any }),
    ).rejects.toBeInstanceOf(BinAssignmentValidationError);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("demotes only this variant's rows, then writes the canonical row as primary", async () => {
    const { service, tx, setCalls } = makeHarness([{ id: 997 }]);

    const saved = await service.assignVariantToLocation({ productVariantId: 59, warehouseLocationId: 1 });

    const demotion = sqlTextOf(tx.execute.mock.calls[1][0]);
    expect(demotion).toContain("SET is_primary = 0");
    expect(demotion).toContain("status = 'active'");
    expect(demotion).toContain("product_variant_id = ");
    expect(demotion).toContain("product_variant_id IS NULL");
    expect(demotion).not.toContain("product_id = ");

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({ isPrimary: 1, status: "active", location: "E-12", productVariantId: 59 });
    expect(saved).toMatchObject({ id: 997, isPrimary: 1 });
    expect(backfillOpenOrderItemBinAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ sku: "SHLZ-MAG-STND-P5", locationCode: "E-12" }),
    );
  });

  it("inserts a primary row when the variant has no active slot yet, after the same demotion", async () => {
    const { service, tx, valuesCalls } = makeHarness([]);

    const saved = await service.assignVariantToLocation({ productVariantId: 59, warehouseLocationId: 1, isPrimary: 1 });

    expect(sqlTextOf(tx.execute.mock.calls[1][0])).toContain("SET is_primary = 0");
    expect(valuesCalls).toHaveLength(1);
    expect(valuesCalls[0]).toMatchObject({ isPrimary: 1, status: "active", productVariantId: 59, warehouseLocationId: 1 });
    expect(saved).toMatchObject({ id: 1250, isPrimary: 1 });
  });
});
