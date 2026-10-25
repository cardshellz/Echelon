import { describe, expect, it, vi } from "vitest";
import { EbayMarketplaceRegistrationObserver } from "../../infrastructure/providers/ebay/ebay-registration-observer";
import type { EbayRegistrationReadRequest } from "../../infrastructure/providers/ebay/ebay-registration-contracts";

const input = { owner: { kind: "channel" as const, channelId: 67, productId: 232, provider: "ebay", marketplaceId: "EBAY_US" },
  memberCandidates: [{ productVariantId: 463, sku: "P10", isActive: true, availableQuantity: 17 },
    { productVariantId: 464, sku: "C500", isActive: true, availableQuantity: 2 }] };
function fixture(pageSize?: number) {
  const state = { groupSkus: ["P10", "C500"], groupIds: ["PROVIDER-GROUP"], groupExists: true,
    missingOffers: false, missingItems: false, status: "UNPUBLISHED", extraOffer: false, groupStatus: 200,
    offerResponse: null as { status: number; body: unknown } | null };
  const get = vi.fn(async (request: EbayRegistrationReadRequest) => {
    const url = new URL(request.path, "https://example.invalid");
    if (url.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: "seller" } };
    if (url.pathname.includes("/inventory_item_group/")) return { status: state.groupExists ? state.groupStatus : 404,
      body: { inventoryItemGroupKey: decodeURIComponent(url.pathname.split("/").at(-1)!), variantSKUs: state.groupSkus } };
    if (url.pathname.includes("/inventory_item/")) return { status: state.missingItems ? 404 : 200,
      body: { sku: decodeURIComponent(url.pathname.split("/").at(-1)!), groupIds: state.groupIds } };
    const sku = url.searchParams.get("sku")!;
    if (state.offerResponse) return state.offerResponse;
    const offers = state.missingOffers ? [] : [{ sku, offerId: `${sku}-offer`, marketplaceId: "EBAY_US", status: state.status }];
    if (state.extraOffer) offers.push({ ...offers[0], offerId: "extra" });
    return { status: 200, body: { total: offers.length, offers } };
  });
  const observer = new EbayMarketplaceRegistrationObserver({ loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) },
    { get }, { now: () => new Date("2026-10-11T20:00:00Z"), ...(pageSize ? { pageSize } : {}) });
  return { state, get, observer };
}
describe("canonical unpublished eBay publication target", () => {
  it("allows verified creation after eBay's authoritative 404/25713 offer absence", async () => {
    const f = fixture(); Object.assign(f.state, { groupIds: [], groupExists: false, missingItems: true,
      offerResponse: { status: 404, body: { errors: [{ errorId: 25713, message: "This Offer is not available." }] } } });
    const result = await f.observer.inspectExistingPublication({ ...input, unpublishedGroupKey: "NEW-GROUP" });
    expect(result.unpublishedTarget).toEqual({ groupKey: "NEW-GROUP", skus: ["C500", "P10"] });
    expect(result.skus.every(row => row.issue === null && row.offers.length === 0)).toBe(true);
    expect(result.publication).toBeNull();
  });
  it.each([
    { status: 404, body: {} }, { status: 404, body: { errors: [] } },
    { status: 404, body: { errors: [{ errorId: "25713" }] } },
    { status: 404, body: { errors: [{ errorId: 25713 }, { errorId: 999 }] } },
    ...[401,403,429,503].map(status => ({ status, body: { errors: [{ errorId: 25713 }] } })),
  ])("does not turn refused, unavailable or ambiguous offer responses into creation: $status", async response => {
    const f = fixture(); f.state.offerResponse = response;
    const result = await f.observer.inspectExistingPublication({ ...input, unpublishedGroupKey: "NEW-GROUP" });
    expect(result.unpublishedTarget).toBeNull();
    expect(result.skus[0].issue).toMatchObject({ providerRead: { resource: "offers", httpStatus: response.status } });
  });
  it("rejects disappearance after the first offers page", async () => {
    const f = fixture(1); const original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async request => {
      if (request.path.startsWith("/sell/inventory/v1/offer?")) {
        const url = new URL(request.path, "https://example.invalid");
        if (url.searchParams.get("offset") !== "0") return { status: 404, body: { errors: [{ errorId: 25713 }] } };
        return { status: 200, body: { total: 2, offers: [{ sku: url.searchParams.get("sku"), offerId: "first", marketplaceId: "EBAY_US", status: "UNPUBLISHED" }] } };
      }
      return original(request);
    });
    const result = await f.observer.inspectExistingPublication(input);
    expect(result.unpublishedTarget).toBeNull();
    expect(result.skus[0].issue?.providerRead?.httpStatus).toBe(404);
  });
  it("proves the exact existing group without calling it published", async () => {
    const f = fixture(); const result = await f.observer.inspectExistingPublication(input);
    expect(result.unpublishedTarget).toEqual({ groupKey: "PROVIDER-GROUP", skus: ["C500", "P10"] });
    expect(result.publication).toBeNull(); expect(result.publicationIssue).toBeNull();
    expect(result.skus[0].offers[0]).toMatchObject({ status: "UNPUBLISHED", listingId: null });
  });
  it("refuses a group containing a different product SKU", async () => {
    const f = fixture(); f.state.groupSkus.push("FOREIGN");
    const result = await f.observer.inspectExistingPublication(input);
    expect(result.unpublishedTarget).toBeNull();
    expect(result.publicationIssue).toMatchObject({ code: "EBAY_REGISTRATION_UNPUBLISHED_GROUP_MEMBERSHIP_MISMATCH", groupVariantSkus: ["C500", "FOREIGN", "P10"] });
  });
  it("preserves a failed group read rather than treating it as a new group", async () => {
    const f = fixture(); f.state.groupStatus = 503;
    const result = await f.observer.inspectExistingPublication(input);
    expect(result.unpublishedTarget).toBeNull(); expect(result.publicationIssue?.status).toBe(503);
  });
  it("never selects one of multiple unpublished offers", async () => {
    const f = fixture(); f.state.extraOffer = true;
    const result = await f.observer.inspectExistingPublication(input);
    expect(result.unpublishedTarget).toBeNull(); expect(result.publication).toBeNull();
  });
  it("requires a complete existing group unless an explicit new target was supplied", async () => {
    const f = fixture(); Object.assign(f.state, { groupIds: [], groupExists: false, missingOffers: true, missingItems: true });
    expect((await f.observer.inspectExistingPublication(input)).unpublishedTarget).toBeNull();
    const result = await f.observer.inspectExistingPublication({ ...input, unpublishedGroupKey: "NEW-GROUP" });
    expect(result.unpublishedTarget).toEqual({ groupKey: "NEW-GROUP", skus: ["C500", "P10"] });
    expect(f.get.mock.calls.some(([request]) => request.path.endsWith("inventory_item_group/NEW-GROUP"))).toBe(true);
  });
  it("probes a planned group for collision before permitting preparation", async () => {
    const f = fixture(); Object.assign(f.state, { groupIds: [], missingOffers: true, missingItems: true, groupSkus: ["FOREIGN"] });
    const result = await f.observer.inspectExistingPublication({ ...input, unpublishedGroupKey: "NEW-GROUP" });
    expect(result.unpublishedTarget).toBeNull(); expect(result.publicationIssue?.code).toBe("EBAY_REGISTRATION_UNPUBLISHED_GROUP_MEMBERSHIP_MISMATCH");
  });
  it("refuses a changed recorded target even with exactly matching SKU membership", async () => {
    const f = fixture(); const result = await f.observer.inspectExistingPublication({ ...input, unpublishedGroupKey: "OTHER-GROUP" });
    expect(result.unpublishedTarget).toBeNull(); expect(result.publicationIssue?.code).toBe("EBAY_REGISTRATION_UNPUBLISHED_GROUP_CHANGED");
  });
  it("supports a genuine single unpublished offer without a variation group", async () => {
    const f = fixture(); f.state.groupIds = [];
    expect((await f.observer.inspectExistingPublication({ ...input, memberCandidates: input.memberCandidates.slice(0, 1) })).unpublishedTarget)
      .toEqual({ groupKey: null, skus: ["P10"] });
  });
});
