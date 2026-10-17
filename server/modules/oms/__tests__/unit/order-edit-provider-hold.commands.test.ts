import { describe, expect, it, vi } from "vitest";
import {
  retireOrderEditProviderHolds,
  transferOrderEditProviderHolds,
} from "../../order-edit-provider-hold.commands";

const fromOperationId = "00000000-0000-4000-8000-000000000001";
const toOperationId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-10-16T12:00:00.000Z");
const transfer = { fromOperationId, toOperationId, now };
const receipt = { shipment_id: 51, provider_order_id: "551", was_held: false };

describe("OMS order-edit provider hold ownership commands", () => {
  it.each([
    { operationId: "invalid", now },
    { operationId: fromOperationId, now: new Date(NaN) },
  ])("rejects invalid retirement before database access: %j", async (input) => {
    const execute = vi.fn();
    await expect(
      retireOrderEditProviderHolds({ execute }, input),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...transfer, fromOperationId: "invalid" },
    { ...transfer, toOperationId: "invalid" },
    { ...transfer, toOperationId: fromOperationId },
    { ...transfer, now: new Date(NaN) },
  ])("rejects invalid transfer before database access: %j", async (input) => {
    const execute = vi.fn();
    await expect(
      transferOrderEditProviderHolds({ execute }, input),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...receipt, shipment_id: 0 },
    { ...receipt, provider_order_id: "invalid" },
    { ...receipt, provider_order_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt, was_held: "false" },
  ])(
    "rejects corrupt stored receipts before transferring or retiring: %j",
    async (row) => {
      const execute = vi.fn().mockResolvedValue({ rows: [row] });
      await expect(
        transferOrderEditProviderHolds({ execute }, transfer),
      ).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retire the old owner if the destination provider identity differs", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [receipt] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      transferOrderEditProviderHolds({ execute }, transfer),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_IDENTITY_CHANGED",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("propagates retirement failure so the caller rolls back ownership, state and audit", async () => {
    const failure = new Error("transaction failed");
    const execute = vi.fn().mockRejectedValue(failure);
    await expect(
      retireOrderEditProviderHolds(
        { execute },
        { operationId: fromOperationId, now },
      ),
    ).rejects.toBe(failure);
  });

  it("uses the Drizzle executor even when a relational query namespace is present", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = { execute, query: {} };
    await retireOrderEditProviderHolds(transaction, {
      operationId: fromOperationId,
      now,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
