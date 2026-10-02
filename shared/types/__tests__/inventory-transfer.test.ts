import { describe, expect, it } from "vitest";
import { inventoryTransferRequestSchema } from "../inventory-transfer";

const valid = { fromLocationId: 1, toLocationId: 2, variantId: 3, quantity: 50 };
describe("inventory transfer boundary", () => {
  it("preserves existing commands and accepts explicit warehouse arrival", () => {
    expect(inventoryTransferRequestSchema.parse(valid)).toEqual(valid);
    expect(inventoryTransferRequestSchema.parse({ ...valid, quantity: "50", crossWarehouseArrivalConfirmed: true }))
      .toEqual({ ...valid, crossWarehouseArrivalConfirmed: true });
  });
  it.each([0, -1, 1.5, "1.5", "50cases", true, null, "", 2_147_483_648])("rejects invalid quantity %s", (quantity) => {
    expect(inventoryTransferRequestSchema.safeParse({ ...valid, quantity }).success).toBe(false);
  });
  it.each(["true", 1, null])("does not coerce arrival confirmation %s", (crossWarehouseArrivalConfirmed) => {
    expect(inventoryTransferRequestSchema.safeParse({ ...valid, crossWarehouseArrivalConfirmed }).success).toBe(false);
  });
  it("rejects same-location transfers", () => {
    expect(inventoryTransferRequestSchema.safeParse({ ...valid, toLocationId: 1 }).success).toBe(false);
  });
});
