import { describe, it, expect, vi } from "vitest";
import { ReceivingService } from "../../../../modules/procurement/receiving.service";

describe("ReceivingService - completeAllLines semantics", () => {
  it("should preserve existing partial entries and backfill untouched lines with expectedQty", async () => {
    // Mock the storage layer
    const mockStorage = {
      getReceivingLines: vi.fn().mockResolvedValue([
        { id: 1, expectedQty: 10, receivedQty: 5, status: "pending" }, // Partially received manually
        { id: 2, expectedQty: 20, receivedQty: 0, status: "pending" }, // Untouched (0)
        { id: 3, expectedQty: 30, receivedQty: null, status: "pending" }, // Untouched (null)
        { id: 4, expectedQty: 40, receivedQty: 40, status: "complete" }, // Already complete
      ]),
      updateReceivingLine: vi.fn().mockResolvedValue({}),
      updateReceivingOrder: vi.fn().mockResolvedValue({}),
      getReceivingOrderById: vi.fn().mockResolvedValue({ id: 1, vendorId: null }),
    };

    const service = new ReceivingService({} as any, {} as any, {} as any, mockStorage as any);

    const result = await service.completeAllLines(1);

    // Assert that we correctly skip the completed line
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledTimes(3);

    // Line 1: Was partially received (5). Should retain its manual 5, NOT go to expected 10.
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(1, {
      receivedQty: 5,
      status: "complete",
    });

    // Line 2: Untouched (0). Should backfill to expected (20).
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(2, {
      receivedQty: 20,
      status: "complete",
    });

    // Line 3: Untouched (null). Should backfill to expected (30).
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(3, {
      receivedQty: 30,
      status: "complete",
    });

    expect(result.updated).toBe(3);
  });
});
