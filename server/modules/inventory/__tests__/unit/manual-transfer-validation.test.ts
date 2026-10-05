import { describe, expect, it, vi } from "vitest";
import { ManualInventoryTransferService } from "../../application/manual-inventory-transfer.service";

describe("manual transfer input boundary", () => {
  const input = {
    commandKey: "transfer:test",
    fromLocationId: 9,
    toLocationId: 10,
    variantId: 174,
    quantity: 50,
  };
  it.each([
    { quantity: 1.5 },
    { quantity: 0 },
    { quantity: "50cases" },
    { crossWarehouseArrivalConfirmed: "true" },
    { toLocationId: 9 },
    { commandKey: undefined },
    { variantId: -1 },
    { quantity: 2_147_483_648 },
  ])(
    "rejects invalid intent before reserving a command or changing stock: %o",
    async (patch) => {
      const database = { transaction: vi.fn(), execute: vi.fn() };
      const inventory = { withTx: vi.fn() };
      const effects = { deliver: vi.fn() };
      const service = new ManualInventoryTransferService(
        database as never,
        inventory as never,
        effects,
        () => new Date("2026-10-04T12:00:00Z"),
      );
      await expect(
        service.transfer({ ...input, ...patch }, "operator"),
      ).rejects.toMatchObject({ name: "ZodError" });
      expect(database.transaction).not.toHaveBeenCalled();
      expect(database.execute).not.toHaveBeenCalled();
      expect(inventory.withTx).not.toHaveBeenCalled();
      expect(effects.deliver).not.toHaveBeenCalled();
    },
  );
});
