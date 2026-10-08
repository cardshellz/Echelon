import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { listingSettingsQueryKey, listingSettingsSummaryQueryOptions } from "../dropship-listing-settings";

const summary: ListingSettingsSummary = {
  storeConnectionId: 22, storeStatus: "connected", access: { allowed: true },
  catalog: { state: "ok", products: 1, sizes: 2 },
  storeDefaults: {
    price: { recipe: null, groupRules: 0 },
    shippingPolicy: { policyId: "F1", verification: "not_checked" },
    returnPolicy: { policyId: "R1", verification: "not_checked" },
    paymentPolicy: { policyId: "P1", verification: "not_checked" },
    ebayCategory: { category: null, groupRules: 0 },
    description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
  },
  counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
  attention: { items: [], total: 0 },
  rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: null },
  generatedAt: "2026-10-07T12:00:00.000Z",
};

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("listing settings summary query", () => {
  const signal = new AbortController().signal;

  it("reads one store's summary under the prefix every listing settings read shares", async () => {
    const fetchMock = stubFetch(summary);
    const options = listingSettingsSummaryQueryOptions(22);
    expect(options.queryKey.slice(0, 3)).toEqual([...listingSettingsQueryKey(22)]);
    await expect(options.queryFn({ signal })).resolves.toEqual(summary);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/summary");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include", signal });
  });

  it("refuses an answer outside the contract, so the rail says it couldn't check", async () => {
    stubFetch({ ...summary, rail: { ...summary.rail, state: "ready" } });
    await expect(listingSettingsSummaryQueryOptions(22).queryFn({ signal })).rejects.toThrow();
  });

  it("passes the server's refusal on", async () => {
    stubFetch({ error: { code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", message: "Listing settings work for eBay stores only." } }, 422);
    await expect(listingSettingsSummaryQueryOptions(22).queryFn({ signal })).rejects.toThrow("Listing settings work for eBay stores only.");
  });

  it("asks only for a real store, and never retries out of sight", () => {
    expect(listingSettingsSummaryQueryOptions(0).enabled).toBe(false);
    expect(listingSettingsSummaryQueryOptions(22)).toMatchObject({ enabled: true, retry: false });
  });
});
