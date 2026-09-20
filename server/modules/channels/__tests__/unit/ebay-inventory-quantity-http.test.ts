import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";
import { publishEbayInventoryQuantity, readEbayInventoryQuantity } from "../../adapters/ebay/ebay-inventory-quantity";
import type { EbayQuantityRequestAdmission } from "../../quantity-publication-request";
import { QuantityProviderEvidenceCollector, type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";

const sku = "P5+A&B";
const now = () => new Date("2026-09-20T12:00:00Z");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const page = () => ({ total: 1, offers: [{ offerId: "offer-1", sku, marketplaceId: "EBAY_GB", status: "PUBLISHED", availableQuantity: 38 }] });
const ack = () => ({ responses: [{ offerId: "offer-1", statusCode: 200 }] });

function fixture(request: typeof fetch, blocked = false) {
  const admitted: string[] = [];
  const admission: EbayQuantityRequestAdmission = {
    item: async (identity, work) => { admitted.push(identity); if (blocked) throw new Error("publication suppressed"); return work(null); },
    group: async (_key, _members, work) => work(null),
    reducing: async (identity, work) => { admitted.push(identity); if (blocked) throw new Error("publication suppressed"); return work(); },
  };
  const client = new EbayApiClient({ getAccessToken: async () => "test-only" }, 67, "sandbox", { request, now, quantityAdmission: async () => admission });
  const evidence: QuantityProviderResponseEvidence[] = [];
  const collector = new QuantityProviderEvidenceCollector({ start: async () => "1", finish: async (_id, row) => { evidence.push(row); } }, now);
  return { client, admitted, collector, evidence };
}

beforeEach(() => vi.stubEnv("DRY_RUN", "false"));
afterEach(() => vi.unstubAllEnvs());

describe("eBay quantity protocol through the actual HTTP client and admission boundary", () => {
  it.each([0, 7])("publishes absolute %i exactly once through admission, then reads both limits", async (quantity) => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(page())).mockResolvedValueOnce(json(ack()))
      .mockResolvedValueOnce(json(page())).mockResolvedValueOnce(json({ sku, availability: { shipToLocationAvailability: { quantity: 50 } } }));
    const f = fixture(request);
    await f.collector.run(() => publishEbayInventoryQuantity(f.client, sku, "EBAY_GB", quantity));
    expect(f.admitted).toEqual([sku]);
    expect(request.mock.calls[0]![0]).toBe("https://api.sandbox.ebay.com/sell/inventory/v1/offer?sku=P5%2BA%26B&marketplace_id=EBAY_GB&offset=0&limit=200");
    expect(request.mock.calls[0]![1]?.headers).toMatchObject({ "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB" });
    const write = request.mock.calls[1]!;
    expect(write[0]).toBe("https://api.sandbox.ebay.com/sell/inventory/v1/bulk_update_price_quantity");
    expect(write[1]).toMatchObject({ method: "POST", redirect: "error", headers: { "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB" } });
    expect(JSON.parse(String(write[1]?.body))).toEqual({ requests: [{ sku, shipToLocationAvailability: { quantity }, offers: [{ offerId: "offer-1", availableQuantity: quantity }] }] });
    expect(f.evidence).toEqual([expect.objectContaining({ outcome: "completed", httpStatus: 200 })]);
    await expect(readEbayInventoryQuantity(f.client, sku, "EBAY_GB")).resolves.toMatchObject({ inventoryItemQuantity: 50, offerQuantity: 38, observedQuantity: 38 });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("cannot bypass suppression with the new bulk path", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json(page()));
    const f = fixture(request, true);
    await expect(publishEbayInventoryQuantity(f.client, sku, "EBAY_GB", 7)).rejects.toThrow("publication suppressed");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]?.method).toBe("GET");
  });
  it("retains an unknown outcome and performs no retry or item replacement after a lost write response", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json(page())).mockRejectedValueOnce(new Error("fetch failed"));
    const f = fixture(request);
    await expect(f.collector.run(() => publishEbayInventoryQuantity(f.client, sku, "EBAY_GB", 7))).rejects.toThrow("fetch failed");
    expect(request).toHaveBeenCalledTimes(2);
    expect(f.evidence).toEqual([expect.objectContaining({ outcome: "uncertain", httpStatus: null })]);
  });
  it("does not pass admission when a bulk response omits the selected offer", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json(page())).mockResolvedValueOnce(json({ responses: [{ sku, statusCode: 200 }] }));
    const f = fixture(request);
    await expect(publishEbayInventoryQuantity(f.client, sku, "EBAY_GB", 7)).rejects.toThrow("not confirmed");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
