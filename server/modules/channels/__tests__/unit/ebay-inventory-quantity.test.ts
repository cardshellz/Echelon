import { describe, expect, it, vi } from "vitest";
import {
  assertEbayQuantityAcknowledgement, ebayInventoryMarketplace, ebayInventoryOffersPath,
  publishEbayInventoryQuantity, readEbayInventoryQuantity,
} from "../../adapters/ebay/ebay-inventory-quantity";

const sku = "SKU-101";
const market = "EBAY_US";
const offer = (quantity: unknown = 38, overrides = {}) => ({
  sku, marketplaceId: market, offerId: "offer-1", status: "PUBLISHED", availableQuantity: quantity, ...overrides,
});
const item = (quantity: unknown = 50) => ({ sku, availability: { shipToLocationAvailability: { quantity } } });
const acknowledgement = () => ({ responses: [{ sku, offerId: "offer-1", statusCode: 200 }] });
function fixture() {
  return {
    getInventoryItem: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(item()),
    getInventoryOffersPage: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ total: 1, offers: [offer()] }),
    bulkUpdatePriceQuantity: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(acknowledgement()),
  };
}

describe("shared eBay absolute inventory quantity protocol", () => {
  it.each([[50, 38, 38], [12, 50, 12], [0, 40, 0], [30, 0, 0]])(
    "observes both item %i and offer %i limits as %i, retaining both values", async (itemQty, offerQty, expected) => {
      const client = fixture();
      client.getInventoryItem.mockResolvedValue(item(itemQty));
      client.getInventoryOffersPage.mockResolvedValue({ total: 1, offers: [offer(offerQty)] });
      await expect(readEbayInventoryQuantity(client, sku, market)).resolves.toEqual({
        sku, marketplaceId: market, offerId: "offer-1", inventoryItemQuantity: itemQty, offerQuantity: offerQty, observedQuantity: expected,
      });
      expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, "", "7", false, true, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "never coerces invalid provider quantity %s in either representation", async (quantity) => {
      for (const field of ["item", "offer"]) {
        const client = fixture();
        if (field === "item") client.getInventoryItem.mockResolvedValue({ sku, availability: { shipToLocationAvailability: { quantity } } });
        else client.getInventoryOffersPage.mockResolvedValue({ total: 1, offers: [offer(0, { availableQuantity: quantity })] });
        await expect(readEbayInventoryQuantity(client, sku, market)).rejects.toMatchObject({ code: "EBAY_INVENTORY_QUANTITY_INVALID" });
        expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects another returned inventory SKU", async () => {
    const client = fixture();
    client.getInventoryItem.mockResolvedValue({ ...item(), sku: "OTHER" });
    await expect(readEbayInventoryQuantity(client, sku, market)).rejects.toMatchObject({ code: "EBAY_INVENTORY_QUANTITY_INVALID" });
  });

  it.each([0, 7, Number.MAX_SAFE_INTEGER])("sets both quantities to absolute %i without replacing metadata", async (quantity) => {
    const client = fixture();
    await expect(publishEbayInventoryQuantity(client, sku, market, quantity)).resolves.toMatchObject({ quantity, offerId: "offer-1" });
    expect(client.bulkUpdatePriceQuantity).toHaveBeenCalledExactlyOnceWith({ requests: [{
      sku, shipToLocationAvailability: { quantity }, offers: [{ offerId: "offer-1", availableQuantity: quantity }],
    }] }, market);
    expect(client.getInventoryItem).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid desired %s before any provider access", async (quantity) => {
    const client = fixture();
    await expect(publishEbayInventoryQuantity(client, sku, market, quantity)).rejects.toMatchObject({ code: "EBAY_INVENTORY_QUANTITY_INVALID", retryable: false });
    expect(client.getInventoryOffersPage).not.toHaveBeenCalled();
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
  });

  it.each([
    { total: 0, offers: [] },
    { total: 1, offers: [offer(2, { status: "UNPUBLISHED" })] },
    { total: 2, offers: [offer(), offer(2, { offerId: "offer-2" })] },
  ])("refuses a missing or ambiguous published offer", async (page) => {
    const client = fixture();
    client.getInventoryOffersPage.mockResolvedValue(page);
    await expect(publishEbayInventoryQuantity(client, sku, market, 7)).rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFER_AMBIGUOUS", retryable: false });
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
  });

  it.each([
    { total: 1, offers: [offer(2, { sku: "OTHER" })] },
    { total: 1, offers: [offer(2, { marketplaceId: "EBAY_GB" })] },
    { total: 2, offers: [offer(), offer()] },
  ])("rejects wrong-scope or duplicate offer evidence", async (page) => {
    const client = fixture();
    client.getInventoryOffersPage.mockResolvedValue(page);
    await expect(publishEbayInventoryQuantity(client, sku, market, 7)).rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFER_SCOPE_INVALID" });
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
  });

  it.each([
    { offers: [offer()] }, { total: "1", offers: [offer()] }, { total: 1001, offers: [] },
    { total: 1, offers: [] }, { total: 0, offers: [offer()] },
    { total: 1, offers: [offer(1, { status: "UNKNOWN" })] },
  ])("does not write from incomplete or malformed discovery", async (page) => {
    const client = fixture();
    client.getInventoryOffersPage.mockResolvedValue(page);
    await expect(publishEbayInventoryQuantity(client, sku, market, 7)).rejects.toThrow();
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
  });

  it("reads every page before choosing a published offer, ignoring drafts", async () => {
    const client = fixture();
    client.getInventoryOffersPage.mockReset()
      .mockResolvedValueOnce({ total: 2, offers: [offer(undefined, { status: "UNPUBLISHED", offerId: "draft" })] })
      .mockResolvedValueOnce({ total: 2, offers: [offer()] });
    await publishEbayInventoryQuantity(client, sku, market, 7);
    expect(client.getInventoryOffersPage.mock.calls).toEqual([[sku, market, 0, 200], [sku, market, 1, 200]]);
    expect(client.bulkUpdatePriceQuantity.mock.invocationCallOrder[0]).toBeGreaterThan(client.getInventoryOffersPage.mock.invocationCallOrder[1]!);
  });

  it("rejects changing totals rather than declaring a partial page complete", async () => {
    const client = fixture();
    client.getInventoryOffersPage.mockReset().mockResolvedValueOnce({ total: 2, offers: [offer()] })
      .mockResolvedValueOnce({ total: 1, offers: [] });
    await expect(publishEbayInventoryQuantity(client, sku, market, 7)).rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFERS_INVALID" });
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
  });

  it("does not retry or choose another writer after an unknown mutation outcome", async () => {
    const client = fixture();
    const failure = new Error("response lost");
    client.bulkUpdatePriceQuantity.mockRejectedValue(failure);
    await expect(publishEbayInventoryQuantity(client, sku, market, 7)).rejects.toBe(failure);
    expect(client.bulkUpdatePriceQuantity).toHaveBeenCalledTimes(1);
    expect(client.getInventoryItem).not.toHaveBeenCalled();
  });

  it.each([
    {}, { responses: [] }, { responses: [{ sku, statusCode: 200 }] },
    { responses: [{ sku: "OTHER", offerId: "offer-1", statusCode: 200 }] },
    { responses: [{ sku, offerId: "wrong-offer", statusCode: 200 }] },
    { responses: [{ sku, offerId: "offer-1", statusCode: 207 }] },
    { responses: [{ sku, offerId: "offer-1", statusCode: 200, errors: [{ errorId: 25001 }] }] },
    { responses: [{ sku, statusCode: 200, offers: [{ offerId: "offer-1", statusCode: 400 }] }] },
    { responses: [...acknowledgement().responses, ...acknowledgement().responses] },
  ])("rejects missing, partial, conflicting or failed quantity acknowledgements", (response) => {
    expect(() => assertEbayQuantityAcknowledgement(response, sku, "offer-1")).toThrow("did not confirm");
  });
  it("accepts the nested per-offer response used by existing clients", () => {
    expect(() => assertEbayQuantityAcknowledgement({ responses: [{ sku, statusCode: 200,
      offers: [{ offerId: "offer-1", statusCode: 200 }] }] }, sku, "offer-1")).not.toThrow();
  });
  it("encodes provider identity and retains the existing default marketplace", () => {
    expect(ebayInventoryMarketplace(undefined)).toBe("EBAY_US");
    expect(ebayInventoryMarketplace("EBAY_GB")).toBe("EBAY_GB");
    expect(() => ebayInventoryMarketplace("EBAY_US&sku=other")).toThrow();
    const url = new URL(`https://api.ebay.com${ebayInventoryOffersPath("A+B&x", market, 0, 200)}`);
    expect(url.searchParams.get("sku")).toBe("A+B&x");
    expect(url.searchParams.get("marketplace_id")).toBe(market);
  });
});
