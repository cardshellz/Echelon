import { describe, expect, it, vi } from "vitest";

import {
  MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE,
  MarketplaceListingRegistrationStatusClientError,
  fetchChannelEbayMarketplaceListingRegistrationStatuses,
  type MarketplaceListingRegistrationStatusRequest,
} from "../marketplace-listing-registration-status";

describe("Channel eBay marketplace listing registration status client", () => {
  it("sorts input, requests deterministic chunks of at most 500, and sorts output", async () => {
    const productIds = Array.from({ length: 1_001 }, (_, index) => 1_001 - index);
    const requestedChunks: number[][] = [];
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>(
      async (method, url) => {
        expect(method).toBe("GET");
        const parsed = new URL(url, "https://echelon.test");
        expect(parsed.pathname).toBe(
          "/api/marketplace-listings/registrations/channel/ebay/status",
        );
        expect(parsed.searchParams.get("channelId")).toBe("44");
        expect(parsed.searchParams.get("marketplaceId")).toBe("EBAY_US");
        const chunk = parsed.searchParams.get("productIds")
          ?.split(",")
          .map(Number) ?? [];
        requestedChunks.push(chunk);
        const selected = chunk.length === 500
          ? [chunk[chunk.length - 1], chunk[0]]
          : [chunk[0]];
        return jsonResponse({ statuses: selected.map(registrationStatus) });
      },
    );

    const result = await fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: "EBAY_US", productIds },
      request,
    );

    expect(requestedChunks).toHaveLength(3);
    expect(requestedChunks.map((chunk) => chunk.length)).toEqual([
      MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE,
      MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE,
      1,
    ]);
    expect(requestedChunks[0]).toEqual(Array.from({ length: 500 }, (_, index) => index + 1));
    expect(requestedChunks[1]).toEqual(Array.from({ length: 500 }, (_, index) => index + 501));
    expect(requestedChunks[2]).toEqual([1_001]);
    expect(result.map((status) => status.productId)).toEqual([1, 500, 501, 1_000, 1_001]);
  });

  it("URL-encodes every query component", async () => {
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>(async (_method, url) => {
      expect(url).toBe(
        "/api/marketplace-listings/registrations/channel/ebay/status"
          + "?channelId=44&marketplaceId=EBAY_US&productIds=7%2C9",
      );
      return jsonResponse({ statuses: [] });
    });

    await fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: " EBAY_US ", productIds: [9, 7] },
      request,
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { channelId: 0, marketplaceId: "EBAY_US", productIds: [1] },
    { channelId: 44, marketplaceId: "US", productIds: [1] },
    { channelId: 44, marketplaceId: "EBAY_US", productIds: [] },
    { channelId: 44, marketplaceId: "EBAY_US", productIds: [1, 1] },
    { channelId: 44, marketplaceId: "EBAY_US", productIds: [2_147_483_648] },
  ])("rejects invalid outbound input before issuing a request: %j", async (input) => {
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>();

    const error = await fetchChannelEbayMarketplaceListingRegistrationStatuses(
      input,
      request,
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(MarketplaceListingRegistrationStatusClientError);
    expect(error).toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_INPUT_INVALID",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects duplicate product statuses within one chunk", async () => {
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>(async () =>
      jsonResponse({ statuses: [registrationStatus(7), registrationStatus(7)] }),
    );

    const error = await fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: "EBAY_US", productIds: [7] },
      request,
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_DUPLICATE_PRODUCT",
      context: { chunkIndex: 0, productId: 7 },
    });
  });

  it("rejects duplicate product statuses returned across chunks", async () => {
    let call = 0;
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>(async () => {
      call += 1;
      return jsonResponse({ statuses: [registrationStatus(1)] });
    });

    const error = await fetchChannelEbayMarketplaceListingRegistrationStatuses(
      {
        channelId: 44,
        marketplaceId: "EBAY_US",
        productIds: Array.from({ length: 501 }, (_, index) => index + 1),
      },
      request,
    ).catch((caught) => caught);

    expect(call).toBe(2);
    expect(error).toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_DUPLICATE_PRODUCT",
      context: { chunkIndex: 1, productId: 1 },
    });
  });

  it("rejects a status for a product outside the current request chunk", async () => {
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>(async () =>
      jsonResponse({ statuses: [registrationStatus(99)] }),
    );

    const error = await fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: "EBAY_US", productIds: [7] },
      request,
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_UNREQUESTED_PRODUCT",
      context: { chunkIndex: 0, productId: 99 },
    });
  });

  it("rejects unknown fields and invalid date strings in a success response", async () => {
    const invalidStatus = {
      ...registrationStatus(7),
      registeredAt: "not-a-date",
      unexpected: true,
    };
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>(async () =>
      jsonResponse({ statuses: [invalidStatus] }),
    );

    const error = await fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: "EBAY_US", productIds: [7] },
      request,
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_RESPONSE_INVALID",
      context: { chunkIndex: 0 },
    });
  });

  it("rejects non-JSON and non-success responses", async () => {
    const invalidJsonRequest = vi.fn<MarketplaceListingRegistrationStatusRequest>(
      async () => new Response("not-json", { status: 200 }),
    );
    await expect(fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: "EBAY_US", productIds: [7] },
      invalidJsonRequest,
    )).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_RESPONSE_INVALID",
    });

    const failedRequest = vi.fn<MarketplaceListingRegistrationStatusRequest>(
      async () => new Response(null, { status: 503 }),
    );
    await expect(fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: "EBAY_US", productIds: [7] },
      failedRequest,
    )).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_HTTP_FAILED",
      context: { chunkIndex: 0, status: 503 },
    });
  });

  it("classifies request-helper failures before a response is returned", async () => {
    const request = vi.fn<MarketplaceListingRegistrationStatusRequest>(
      async () => { throw new Error("503: upstream unavailable"); },
    );

    await expect(fetchChannelEbayMarketplaceListingRegistrationStatuses(
      { channelId: 44, marketplaceId: "EBAY_US", productIds: [7] },
      request,
    )).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_STATUS_HTTP_FAILED",
      context: { chunkIndex: 0, causeName: "Error" },
    });
  });
});

function registrationStatus(productId: number) {
  return {
    status: "registered" as const,
    productId,
    registrationId: 1_000 + productId,
    scopeId: 2_000 + productId,
    providerAccountId: 3_000 + productId,
    publicationId: 4_000 + productId,
    providerPublicationKey: `publication-${productId}`,
    externalListingId: `listing-${productId}`,
    registeredVariantIds: [productId * 10],
    registeredVariants: [{
      productVariantId: productId * 10,
      sku: `SKU-${productId}`,
      disposition: "included" as const,
    }],
    registeredAt: "2026-08-04T12:00:00.000Z",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
