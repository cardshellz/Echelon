import { describe, expect, it, vi } from "vitest";
import { PostgresInventoryConversionReader } from "../../infrastructure/inventory-conversion-read.repository";

function client(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows })), release: vi.fn() };
}

describe("PostgresInventoryConversionReader", () => {
  it("does not expose a conversion prohibited by the canonical behavior", async () => {
    const row = { source_variant_id: 20, destination_variant_id: 1, operation_type: "break_pack", input_qty: 1, output_qty: 20,
      transformation_recipe_binding_id: null };
    const db = client([{ ...row, inventory_behavior: "physical_only" }, { ...row, inventory_behavior: "build_managed" },
      { ...row, inventory_behavior: "package_hierarchy" }]);
    const reader = new PostgresInventoryConversionReader({ connect: vi.fn(async () => db) } as never);
    await expect(reader.getAllowedConversions(17)).resolves.toEqual([{ sourceVariantId: 20, destinationVariantId: 1,
      operationType: "break_pack", inputQty: 1, outputQty: 20 }]);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("fails visibly and releases the connection if behavior is malformed", async () => {
    const db = client([{ inventory_behavior: "unexpected" }]);
    const reader = new PostgresInventoryConversionReader({ connect: vi.fn(async () => db) } as never);
    await expect(reader.getAllowedConversions(17)).rejects.toThrow();
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("returns only allowed paths from the sealed valid active model", async () => {
    const db = client([{ source_variant_id: "20", destination_variant_id: "1", operation_type: "break_pack", input_qty: "1", output_qty: "20" }]);
    const reader = new PostgresInventoryConversionReader({ connect: vi.fn(async () => db) } as never);
    await expect(reader.getAllowedConversions(17)).resolves.toEqual([{ sourceVariantId: 20, destinationVariantId: 1, operationType: "break_pack", inputQty: 1, outputQty: 20 }]);
    const queryCall = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(String(queryCall[0])).toContain("model.lifecycle_status = 'sealed'");
    expect(String(queryCall[0])).toContain("path.authority_state = 'allowed'");
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [17]);
    expect(db.release).toHaveBeenCalledOnce();
  });
  it("returns an empty array when no sealed model exists", async () => {
    const db = client([]);
    const reader = new PostgresInventoryConversionReader({ connect: vi.fn(async () => db) } as never);
    await expect(reader.getAllowedConversions(17)).resolves.toEqual([]);
  });
  it.each([0, -1, 1.2, Number.NaN, "17"]) ("rejects invalid product id %p before opening a connection", async (productId) => {
    const connect = vi.fn();
    const reader = new PostgresInventoryConversionReader({ connect });
    await expect(reader.getAllowedConversions(productId as number)).rejects.toThrow("productId must be a positive integer");
    expect(connect).not.toHaveBeenCalled();
  });
});
