import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saveListingPriceInTransaction: vi.fn(), listingPriceTransactionForClient: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../application/dropship-listing-price-service", () => ({ saveListingPriceInTransaction: mocks.saveListingPriceInTransaction }));
vi.mock("../../infrastructure/dropship-listing-price.repository", () => ({ listingPriceTransactionForClient: mocks.listingPriceTransactionForClient }));

import { w9MarketplacePriceWriter } from "../../infrastructure/dropship-marketplace-sync.repository";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const client = { query: vi.fn() };
const input = { vendorId: 10, storeConnectionId: 22, productVariantId: 101, priceCents: 1400, expectedRevisionId: 5,
  idempotencyKey: "ebay-sync:price:77:1400:5", now: NOW };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listingPriceTransactionForClient.mockReturnValue({ tx: true });
  mocks.saveListingPriceInTransaction.mockResolvedValue({ price: {}, idempotentReplay: false });
});

/**
 * eBay sync-back keeps a vendor's eBay price through W9's own save path
 * (plan v4 §1.3): every W9 check runs, as the system, on the adoption
 * transaction's client, under the reserved `ebay-sync:` key.
 */
describe("w9MarketplacePriceWriter", () => {
  it("saves a fixed price through W9 on the caller's client, as the system, under the sync-back key", async () => {
    expect(await w9MarketplacePriceWriter.adoptPrice(client, input)).toBe("adopted");
    expect(mocks.listingPriceTransactionForClient).toHaveBeenCalledExactlyOnceWith(client, { storeConnectionId: 22, productVariantId: 101,
      vendorId: 10, memberId: "system:ebay-sync-back", idempotencyKey: "ebay-sync:price:77:1400:5", actorType: "system" });
    expect(mocks.saveListingPriceInTransaction).toHaveBeenCalledExactlyOnceWith({ tx: true }, { storeConnectionId: 22, productVariantId: 101 },
      { priceCents: 1400, pricingMode: "fixed", expectedRevisionId: 5, idempotencyKey: "ebay-sync:price:77:1400:5" },
      expect.stringMatching(/^[a-f0-9]{64}$/), NOW);
  });

  it("hashes the same change the same way, so a replayed key replays instead of conflicting", async () => {
    await w9MarketplacePriceWriter.adoptPrice(client, input);
    await w9MarketplacePriceWriter.adoptPrice(client, { ...input, now: new Date(NOW.getTime() + 60_000) });
    await w9MarketplacePriceWriter.adoptPrice(client, { ...input, priceCents: 1500 });
    const hashes = mocks.saveListingPriceInTransaction.mock.calls.map((call) => call[3]);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it("answers a replay as replayed, and lets W9's refusals through to the transaction's savepoint", async () => {
    mocks.saveListingPriceInTransaction.mockResolvedValueOnce({ price: {}, idempotentReplay: true });
    expect(await w9MarketplacePriceWriter.adoptPrice(client, input)).toBe("replayed");
    mocks.saveListingPriceInTransaction.mockRejectedValueOnce(Object.assign(new Error("limit"), { code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" }));
    await expect(w9MarketplacePriceWriter.adoptPrice(client, input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" });
  });
});
