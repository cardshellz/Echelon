import { describe, expect, it, vi } from "vitest";
import { WalmartListingApi, WALMART_LISTING_SPEC } from "../../adapters/walmart/walmart-listing-api";
// Actual read-only Walmart catalog response for the unchanged selling-unit GTIN.
// The lookup template is evidence of a match, not our outgoing feed schema.
import legacyMatch from "../fixtures/walmart-catalog-match-4.2.response.json";

const identifier = { type: "GTIN" as const, value: "00850025354769" };
const metadata = { correlationId: "00000000-0000-4000-8000-000000000001", status: 200,
  retryAfterMs: null, remainingTokens: null, nextReplenishmentAt: null };
function apiFor(data: unknown) {
  const requestWithMetadata = vi.fn().mockResolvedValue({ data, metadata });
  return { api: new WalmartListingApi({ requestWithMetadata }), requestWithMetadata };
}

describe("Walmart existing-product match lookup", () => {
  it.each(["4.2", WALMART_LISTING_SPEC.MP_ITEM_MATCH])("accepts the documented %s lookup without changing the GTIN or submission version", async version => {
    const response = structuredClone(legacyMatch);
    response.items[0].version = version;
    response.items[0].itemSpecPayload.MPItemFeedHeader.version = version;
    const original = structuredClone(response);
    const { api, requestWithMetadata } = apiFor(response);
    expect(await api.match(identifier)).toEqual({ feedType: "MP_ITEM_MATCH", version, payload: response.items[0].itemSpecPayload });
    expect(requestWithMetadata).toHaveBeenCalledExactlyOnceWith("GET", "/v3/items/walmart/search?responseFormat=SPEC&gtin=00850025354769");
    expect(response).toEqual(original);
    expect(WALMART_LISTING_SPEC.MP_ITEM_MATCH).toBe("5.0.20260607-22_38_54-api");
  });
  it.each(["3.2", "future-version", ""]) ("rejects unsupported lookup version %s", async version => {
    const response = structuredClone(legacyMatch);
    response.items[0].version = version;
    response.items[0].itemSpecPayload.MPItemFeedHeader.version = version;
    await expect(apiFor(response).api.match(identifier)).rejects.toMatchObject({ code: "WALMART_SPEC_VERSION_MISMATCH" });
  });
  it("rejects conflicting envelope and template versions", async () => {
    const response = structuredClone(legacyMatch);
    response.items[0].version = WALMART_LISTING_SPEC.MP_ITEM_MATCH;
    await expect(apiFor(response).api.match(identifier)).rejects.toMatchObject({ code: "WALMART_SPEC_VERSION_MISMATCH" });
  });
  it("does not treat empty or multiple results as a confirmed match", async () => {
    expect(await apiFor({ items: [] }).api.match(identifier)).toBeNull();
    await expect(apiFor({ items: [...legacyMatch.items, ...legacyMatch.items] }).api.match(identifier))
      .rejects.toMatchObject({ code: "WALMART_LISTING_RESPONSE_INVALID" });
  });
});
