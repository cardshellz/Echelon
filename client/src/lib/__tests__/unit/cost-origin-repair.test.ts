import { afterEach, describe, expect, it, vi } from "vitest";
import { createOriginRepairClient } from "../../cost-origin-repair";
const input = {
  sourceVersion: "a".repeat(64),
  previewVersion: "b".repeat(64),
  unitsPerCase: 50,
  productMills: 1250000,
  packagingMills: 250000,
  destination: "historical_cogs",
  reason: "Supplier and receipt verified.",
  evidenceConfirmed: true,
};
const response = {
  lotId: 23,
  lotNumber: "TEST-LOT",
  sku: "TEST-SKU",
  purchaseOrderId: 17,
  purchaseOrderLineId: 21,
  receiptId: 31,
  receiptNumber: "TEST-RCV",
  receiptLineId: 32,
  receivedUnits: 10,
  onHandUnits: 0,
  sourceVersion: "c".repeat(64),
  invoice: { id: 71, lineId: 72, amountMills: 1500000 },
  suggested: {
    unitsPerCase: 50,
    productMills: 1250000,
    packagingMills: 250000,
  },
  canApprove: true,
  blockedReason: null,
  approval: {
    id: 1,
    actorName: "Administrator",
    reason: input.reason,
    recordedAt: "2026-10-18T15:00:00.000Z",
    destination: "historical_cogs",
    summary: {
      receivedUnits: 10,
      basePieces: 500,
      stockQuantityChange: 0,
      components: ["product", "packaging", "landed"].map((component) => ({
        component,
        lotBeforeMills: 0,
        lotAfterMills: 0,
        historicalBeforeMills: 0,
        historicalAfterMills: 0,
        orderCostDeltaCents: 0,
        lotsUpdated: 1,
      })),
    },
  },
};
afterEach(() => vi.unstubAllGlobals());
describe("origin repair command recovery", () => {
  it("reuses the same reviewed request and key after a lost response", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetch);
    const key = vi.fn(() => "same-origin-key"),
      client = createOriginRepairClient(key);
    await expect(client.approve(23, input)).rejects.toMatchObject({
      ambiguous: true,
    });
    expect(await client.approve(23, input)).toEqual(response);
    expect(key).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
  });
  it.each([
    {},
    { ...response, lotId: 99 },
    { ...response, approval: null },
    {
      ...response,
      approval: { ...response.approval, destination: "inventory_variance" },
    },
  ])("does not accept an unverified success", async (raw) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(raw))),
    );
    await expect(
      createOriginRepairClient(() => "key").approve(23, input),
    ).rejects.toMatchObject({ ambiguous: true });
  });
  it("rejects invalid IDs and prevents changing an ambiguous approval", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("lost response"));
    vi.stubGlobal("fetch", fetch);
    const client = createOriginRepairClient(() => "key");
    await expect(client.approve(0, input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.approve(23, input)).rejects.toThrow();
    await expect(
      client.approve(23, { ...input, productMills: 1 }),
    ).rejects.toMatchObject({ code: "COST_ORIGIN_PENDING" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
