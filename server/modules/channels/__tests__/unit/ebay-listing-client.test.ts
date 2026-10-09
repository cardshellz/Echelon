import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const capturedGroup = JSON.parse(readFileSync(resolve(process.cwd(), "server/modules/channels/__tests__/fixtures/ebay-armalope-group-readback.json"), "utf8")) as Record<string, unknown>;
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({
  ebayApiRequest: api.request,
  ebayApiRequestWithRateNotify: api.request,
  getAuthService: () => null,
  EBAY_CHANNEL_ID: 67,
}));
import { createEbayRouteListingLifecycleClient, normalizeEbayObservedInventoryItemGroup } from "../../infrastructure/ebay-listing-client";

describe("eBay inventory group read response contract", () => {
  beforeEach(() => api.request.mockReset());
  it("reads the exact requested resource and preserves the captured body without inventing a key", async () => {
    api.request.mockResolvedValue(structuredClone(capturedGroup));
    const client = createEbayRouteListingLifecycleClient({ accessToken: "mock-access-token" });
    const response = await client.getInventoryItemGroup("ARM-ENV-DBL");
    expect(api.request).toHaveBeenCalledExactlyOnceWith("GET", "/sell/inventory/v1/inventory_item_group/ARM-ENV-DBL", "mock-access-token", undefined);
    expect(response).toEqual(capturedGroup);
    expect(response).not.toHaveProperty("inventoryItemGroupKey");
    expect(response?.imageUrls).toHaveLength(2);
    expect(response?.variantSKUs).toEqual(["ARM-ENV-DBL-C300", "ARM-ENV-DBL-P50"]);
  });
  it.each([
    { imageUrls: [42] }, { variantSKUs: [true] }, { description: null },
    { variesBy: { specifications: [{ name: "Style", values: [false] }] } },
    { inventoryItemGroupKey: null },
  ])("rejects invalid provider fields without disclosing values", invalid => {
    expect(() => normalizeEbayObservedInventoryItemGroup({ ...capturedGroup, ...invalid })).toThrowError(
      expect.objectContaining({ code: "EBAY_SYNC_PROVIDER_RESPONSE_INVALID" }),
    );
  });
});
