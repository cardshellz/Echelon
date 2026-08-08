import { describe, expect, it, vi } from "vitest";

import { createInventoryAtpService } from "../../atp.service";

describe("InventoryAtpService.getDirectVariantAtp", () => {
  it("returns direct ATP by variant and fills missing variants with zero", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { product_variant_id: "60", atp: "0" },
        { product_variant_id: "10", atp: "1130" },
      ],
    });
    const service = createInventoryAtpService({ execute });

    await expect(service.getDirectVariantAtp([60, 10, 750])).resolves.toEqual(new Map([
      [60, 0],
      [10, 1_130],
      [750, 0],
    ]));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not query inventory for an empty variant set", async () => {
    const execute = vi.fn();
    const service = createInventoryAtpService({ execute });

    await expect(service.getDirectVariantAtp([])).resolves.toEqual(new Map());
    expect(execute).not.toHaveBeenCalled();
  });
});