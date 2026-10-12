import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const ports = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), setIntent: vi.fn(), remote: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {}, pool: { connect: async () => ({ query: ports.query, release: ports.release }) } }));
vi.mock("../../../../modules/channels/ebay-connection-health", () => ({ readEbayConnectionHealth: vi.fn() }));
vi.mock("../../../../modules/channels/ebay-listing-sync", () => ({ syncActiveListings: vi.fn(), triggerPricingRuleSync: vi.fn() }));
vi.mock("../../../middleware", () => ({ requireAuth: vi.fn(), requirePermission: () => vi.fn(), requireInternalApiKey: vi.fn() }));
vi.mock("../../ebay-utils", () => ({ EBAY_CHANNEL_ID: 36 }));
vi.mock("../../ebay-listing-state", () => ({ setEbayVariantListingIntent: ports.setIntent,
  markEbayVariantListingPendingForRelist: vi.fn(), zeroEbayVariantListing: ports.remote }));
import { router } from "../../ebay-config.routes";

function handler(path: string) {
  const route = router.stack.find((entry: { route?: { path: string } }) => entry.route?.path === path)?.route;
  if (!route) throw new Error(`Test route was not registered: ${path}`);
  return route.stack.at(-1)!.handle as (req: Request, res: Response) => Promise<unknown>;
}
function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); return res;
}
describe("eBay selection mutation conflicts", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ["/api/ebay/toggle-type-listing/:productTypeSlug", { productTypeSlug: "toploaders" }, { listingEnabled: false }],
    ["/api/ebay/category-mapping", {}, { mappings: [{ productTypeSlug: "toploaders", listingEnabled: false }] }],
    ["/api/ebay/variant-exclusion/:variantId", { variantId: "101" }, { excluded: true }],
  ])("gives a retry direction for %s without starting a provider write", async (path, params, body) => {
    const busy = new Error("private SQL", { cause: { code: "55P03", message: "PUBLICATION_SELECTION_BUSY" } });
    ports.query.mockImplementation(async (query: string) => {
      if (query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
      throw busy;
    });
    ports.setIntent.mockRejectedValue(busy);
    const res = response(); await handler(path as string)({ params, body } as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PUBLICATION_SELECTION_BUSY", retryable: true }));
    expect(ports.remote).not.toHaveBeenCalled();
    if (path === "/api/ebay/category-mapping") expect(ports.query).toHaveBeenCalledWith("ROLLBACK");
  });
});
