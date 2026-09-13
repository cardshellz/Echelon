import { describe, expect, it, vi } from "vitest";

import { AllocationEngineError } from "../../../channels/allocation-engine.errors";
import {
  ChannelAllocationDropshipAtpProvider,
  type DropshipChannelAllocationRow,
} from "../../infrastructure/dropship-atp.provider";

const DROPSHIP_OMS_CHANNEL_ID = 103;
const SHOPIFY_CHANNEL_ID = 1;

function row(overrides: Partial<DropshipChannelAllocationRow> & { productVariantId: number }): DropshipChannelAllocationRow {
  return {
    channelId: DROPSHIP_OMS_CHANNEL_ID,
    allocatedUnits: 0,
    warehouseScopeSource: "explicit",
    ...overrides,
  };
}

function createProvider(
  allocationsByProduct: Record<number, readonly DropshipChannelAllocationRow[]>,
  options: { resolveChannel?: () => Promise<number>; previewProduct?: (productId: number) => Promise<any> } = {},
) {
  const previewProduct = vi.fn(options.previewProduct ?? (async (productId: number) => ({
    productId,
    allocations: allocationsByProduct[productId] ?? [],
  })));
  const resolveDropshipOmsChannelId = vi.fn(options.resolveChannel ?? (async () => DROPSHIP_OMS_CHANNEL_ID));
  const provider = new ChannelAllocationDropshipAtpProvider({
    allocationEngine: { previewProduct },
    resolveDropshipOmsChannelId,
  });
  return { provider, previewProduct, resolveDropshipOmsChannelId };
}

describe("ChannelAllocationDropshipAtpProvider", () => {
  it("returns the Dropship OMS channel allocation per variant and ignores other channels", async () => {
    const { provider, previewProduct } = createProvider({
      10: [
        row({ productVariantId: 101, allocatedUnits: 25 }),
        row({ productVariantId: 102, allocatedUnits: 7 }),
        row({ channelId: SHOPIFY_CHANNEL_ID, productVariantId: 101, allocatedUnits: 999 }),
      ],
      20: [row({ productVariantId: 201, allocatedUnits: 3 })],
    });

    await expect(provider.getVariantAtp([
      { productId: 20, productVariantId: 201 },
      { productId: 10, productVariantId: 102 },
      { productId: 10, productVariantId: 999 },
    ])).resolves.toEqual(new Map([
      [201, 3],
      [102, 7],
      [999, 0],
    ]));
    expect(previewProduct).toHaveBeenCalledTimes(2);
    expect(previewProduct).toHaveBeenCalledWith(10);
    expect(previewProduct).toHaveBeenCalledWith(20);
  });

  it("exposes zero when the channel has no allocation row for the variant (blocked or unlisted)", async () => {
    const { provider } = createProvider({ 10: [] });

    await expect(provider.getVariantAtp([{ productId: 10, productVariantId: 101 }]))
      .resolves.toEqual(new Map([[101, 0]]));
  });

  it("fails closed when the Dropship OMS channel relies on the all-warehouses fallback", async () => {
    const { provider } = createProvider({
      10: [row({ productVariantId: 101, allocatedUnits: 40, warehouseScopeSource: "legacy_all_active_fallback" })],
    });

    await expect(provider.getVariantAtp([{ productId: 10, productVariantId: 101 }]))
      .rejects.toMatchObject({
        code: "DROPSHIP_ALLOCATION_WAREHOUSE_SCOPE_REQUIRED",
        context: { channelId: DROPSHIP_OMS_CHANNEL_ID, productId: 10, productVariantId: 101 },
      });
  });

  it("does not fabricate a quantity when the engine fails; the classified engine error is surfaced", async () => {
    const { provider } = createProvider({}, {
      previewProduct: async () => {
        throw new AllocationEngineError(
          "ALLOCATION_VELOCITY_UNAVAILABLE",
          "transient",
          "Sales velocity could not be read.",
          { productId: 10 },
        );
      },
    });

    await expect(provider.getVariantAtp([{ productId: 10, productVariantId: 101 }]))
      .rejects.toMatchObject({
        code: "DROPSHIP_ALLOCATION_UNAVAILABLE",
        context: {
          productId: 10,
          channelId: DROPSHIP_OMS_CHANNEL_ID,
          allocationErrorCode: "ALLOCATION_VELOCITY_UNAVAILABLE",
          classification: "transient",
        },
      });
  });

  it("propagates the channel configuration error before reading any allocation", async () => {
    const configError = Object.assign(new Error("Dropship OMS channel must be explicitly configured."), {
      code: "DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED",
    });
    const { provider, previewProduct } = createProvider({}, {
      resolveChannel: async () => { throw configError; },
    });

    await expect(provider.getVariantAtp([{ productId: 10, productVariantId: 101 }]))
      .rejects.toBe(configError);
    expect(previewProduct).not.toHaveBeenCalled();
  });

  it("rejects conflicting target ownership, invalid quantities, and mismatched results", async () => {
    const conflicting = createProvider({});
    await expect(conflicting.provider.getVariantAtp([
      { productId: 10, productVariantId: 101 },
      { productId: 20, productVariantId: 101 },
    ])).rejects.toMatchObject({ code: "DROPSHIP_ATP_TARGET_CONFLICT" });

    const invalidQuantity = createProvider({ 10: [row({ productVariantId: 101, allocatedUnits: -1 })] });
    await expect(invalidQuantity.provider.getVariantAtp([{ productId: 10, productVariantId: 101 }]))
      .rejects.toMatchObject({ code: "DROPSHIP_ATP_QUANTITY_INVALID" });

    const mismatched = createProvider({}, {
      previewProduct: async () => ({ productId: 99, allocations: [] }),
    });
    await expect(mismatched.provider.getVariantAtp([{ productId: 10, productVariantId: 101 }]))
      .rejects.toMatchObject({ code: "DROPSHIP_ALLOCATION_RESULT_MISMATCH" });
  });

  it("returns an empty map without resolving the channel when there are no targets", async () => {
    const { provider, resolveDropshipOmsChannelId } = createProvider({});

    await expect(provider.getVariantAtp([])).resolves.toEqual(new Map());
    expect(resolveDropshipOmsChannelId).not.toHaveBeenCalled();
  });
});
