/**
 * Unit tests for channel-listings transform helpers.
 *
 * These cover the pure logic that drives GET /api/products/:productId/channel-listings:
 *  - GID -> numeric extraction
 *  - status synthesis from sync_status + external id
 *  - admin URL construction across providers
 *  - end-to-end row -> DTO mapping
 */

import { describe, it, expect } from "vitest";
import {
  buildAdminUrl,
  deriveListingStatus,
  extractNumericId,
  rowToListingDto,
  type ChannelListingRowInput,
} from "../../channel-listings.transform";

describe("extractNumericId", () => {
  it("extracts the trailing id from a Shopify ProductVariant GID", () => {
    expect(
      extractNumericId("gid://shopify/ProductVariant/62783080038559"),
    ).toBe("62783080038559");
  });

  it("extracts the trailing id from a Shopify Product GID", () => {
    expect(
      extractNumericId("gid://shopify/Product/9047002972319"),
    ).toBe("9047002972319");
  });

  it("returns the value unchanged when it is already a bare numeric string", () => {
    expect(extractNumericId("62783080038559")).toBe("62783080038559");
  });

  it("returns null for null/undefined/empty", () => {
    expect(extractNumericId(null)).toBeNull();
    expect(extractNumericId(undefined)).toBeNull();
    expect(extractNumericId("")).toBeNull();
  });

  it("returns null for non-numeric, non-GID values", () => {
    expect(extractNumericId("ABC-123")).toBeNull();
    expect(extractNumericId("https://example.com/listing")).toBeNull();
  });
});

describe("deriveListingStatus", () => {
  it("returns 'error' when sync_status is error, regardless of external id", () => {
    expect(
      deriveListingStatus({ syncStatus: "error", externalVariantId: "62783080038559", variantIsActive: true }),
    ).toBe("error");
    expect(
      deriveListingStatus({ syncStatus: "error", externalVariantId: null, variantIsActive: true }),
    ).toBe("error");
  });

  it("returns 'active' when external id is present and sync_status is not pending/error", () => {
    expect(
      deriveListingStatus({ syncStatus: "synced", externalVariantId: "62783080038559", variantIsActive: true }),
    ).toBe("active");
    expect(
      deriveListingStatus({ syncStatus: null, externalVariantId: "62783080038559", variantIsActive: true }),
    ).toBe("active");
  });

  it("returns 'pending' when sync_status is pending even with an external id", () => {
    expect(
      deriveListingStatus({ syncStatus: "pending", externalVariantId: "62783080038559", variantIsActive: true }),
    ).toBe("pending");
  });

  it("returns 'pending' when no external id is present", () => {
    expect(
      deriveListingStatus({ syncStatus: "synced", externalVariantId: null, variantIsActive: true }),
    ).toBe("pending");
    expect(
      deriveListingStatus({ syncStatus: null, externalVariantId: null, variantIsActive: true }),
    ).toBe("pending");
  });

  it("returns 'archived' when variant is inactive even if sync_status='synced' and external id is present", () => {
    // The misleading-status bug fix: archived variants must never show
    // as Active just because the channel_listings row is still synced.
    expect(
      deriveListingStatus({ syncStatus: "synced", externalVariantId: "62783080038559", variantIsActive: false }),
    ).toBe("archived");
  });

  it("returns 'archived' when variant is inactive even if sync_status='error' (archived wins over error)", () => {
    expect(
      deriveListingStatus({ syncStatus: "error", externalVariantId: "62783080038559", variantIsActive: false }),
    ).toBe("archived");
    expect(
      deriveListingStatus({ syncStatus: "error", externalVariantId: null, variantIsActive: false }),
    ).toBe("archived");
  });

  it("returns 'archived' when variant is inactive regardless of pending or missing external id", () => {
    expect(
      deriveListingStatus({ syncStatus: "pending", externalVariantId: null, variantIsActive: false }),
    ).toBe("archived");
    expect(
      deriveListingStatus({ syncStatus: null, externalVariantId: null, variantIsActive: false }),
    ).toBe("archived");
  });
});

describe("buildAdminUrl", () => {
  it("builds a Shopify admin variant URL when all parts are present", () => {
    const url = buildAdminUrl({
      channelProvider: "shopify",
      shopDomain: "card-shellz.myshopify.com",
      externalProductIdNumeric: "9047002972319",
      externalListingIdNumeric: "62783080038559",
      externalUrl: null,
    });
    expect(url).toBe(
      "https://admin.shopify.com/store/card-shellz/products/9047002972319/variants/62783080038559",
    );
  });

  it("strips .myshopify.com case-insensitively from shopDomain", () => {
    const url = buildAdminUrl({
      channelProvider: "shopify",
      shopDomain: "Card-Shellz.MYSHOPIFY.COM",
      externalProductIdNumeric: "1",
      externalListingIdNumeric: "2",
      externalUrl: null,
    });
    expect(url).toBe("https://admin.shopify.com/store/Card-Shellz/products/1/variants/2");
  });

  it("falls back to externalUrl for shopify when product id is missing", () => {
    const url = buildAdminUrl({
      channelProvider: "shopify",
      shopDomain: "card-shellz.myshopify.com",
      externalProductIdNumeric: null,
      externalListingIdNumeric: "62783080038559",
      externalUrl: "https://admin.shopify.com/store/x/products/y",
    });
    expect(url).toBe("https://admin.shopify.com/store/x/products/y");
  });

  it("falls back to externalUrl for non-shopify providers", () => {
    expect(
      buildAdminUrl({
        channelProvider: "ebay",
        shopDomain: null,
        externalProductIdNumeric: null,
        externalListingIdNumeric: null,
        externalUrl: "https://www.ebay.com/itm/123",
      }),
    ).toBe("https://www.ebay.com/itm/123");
  });

  it("returns null when no externalUrl and provider is not shopify", () => {
    expect(
      buildAdminUrl({
        channelProvider: "ebay",
        shopDomain: null,
        externalProductIdNumeric: null,
        externalListingIdNumeric: null,
        externalUrl: null,
      }),
    ).toBeNull();
  });
});

describe("rowToListingDto", () => {
  const baseRow: ChannelListingRowInput = {
    listingId: 100,
    channelId: 1,
    channelName: "Shopify (US)",
    channelProvider: "shopify",
    shopDomain: "card-shellz.myshopify.com",
    productVariantId: 42,
    variantSku: "ARM-ENV-GRD-C100",
    // Default to an active variant in baseRow; the archived-variant test
    // below explicitly overrides this to false.
    variantIsActive: true,
    externalProductId: "9047002972319",
    externalVariantId: "62783080038559",
    externalUrl: null,
    syncStatus: "synced",
    syncError: null,
    createdAt: "2026-04-25T19:16:23Z",
    updatedAt: "2026-04-26T10:00:00Z",
    lastSyncedAt: "2026-04-27T10:33:00Z",
  };

  it("maps a fully-populated Shopify row to the public DTO", () => {
    const dto = rowToListingDto(baseRow);

    expect(dto).toEqual({
      listingId: 100,
      variantId: 42,
      variantSku: "ARM-ENV-GRD-C100",
      channelId: 1,
      channelName: "Shopify (US)",
      channelProvider: "shopify",
      shopDomain: "card-shellz.myshopify.com",
      externalListingId: "62783080038559",
      externalListingIdNumeric: "62783080038559",
      externalProductId: "9047002972319",
      status: "active",
      syncStatus: "synced",
      syncError: null,
      listedSince: "2026-04-25T19:16:23Z",
      lastSynced: "2026-04-27T10:33:00Z",
      adminUrl:
        "https://admin.shopify.com/store/card-shellz/products/9047002972319/variants/62783080038559",
    });
  });

  it("handles GID-formatted external ids by exposing both raw and numeric forms", () => {
    const dto = rowToListingDto({
      ...baseRow,
      externalProductId: "gid://shopify/Product/9047002972319",
      externalVariantId: "gid://shopify/ProductVariant/62783080038559",
    });

    expect(dto.externalListingId).toBe("gid://shopify/ProductVariant/62783080038559");
    expect(dto.externalListingIdNumeric).toBe("62783080038559");
    expect(dto.externalProductId).toBe("gid://shopify/Product/9047002972319");
    expect(dto.adminUrl).toBe(
      "https://admin.shopify.com/store/card-shellz/products/9047002972319/variants/62783080038559",
    );
  });

  it("marks pending status and skips admin URL when external id is missing", () => {
    const dto = rowToListingDto({
      ...baseRow,
      externalProductId: null,
      externalVariantId: null,
      syncStatus: "pending",
      lastSyncedAt: null,
    });

    expect(dto.status).toBe("pending");
    expect(dto.externalListingId).toBeNull();
    expect(dto.externalListingIdNumeric).toBeNull();
    expect(dto.adminUrl).toBeNull();
  });

  it("marks error status when sync_status=error", () => {
    const dto = rowToListingDto({
      ...baseRow,
      syncStatus: "error",
      syncError: "Shopify rejected payload: missing weight",
    });

    expect(dto.status).toBe("error");
    expect(dto.syncError).toBe("Shopify rejected payload: missing weight");
    // Admin URL is still built when ids are present \u2014 operators may want to inspect.
    expect(dto.adminUrl).toContain("admin.shopify.com");
  });

  it("falls back to externalUrl for non-shopify providers", () => {
    const dto = rowToListingDto({
      ...baseRow,
      channelName: "eBay (US)",
      channelProvider: "ebay",
      shopDomain: null,
      externalProductId: null,
      externalVariantId: "v2-1234567890",
      externalUrl: "https://www.ebay.com/itm/1234567890",
    });

    expect(dto.adminUrl).toBe("https://www.ebay.com/itm/1234567890");
    expect(dto.externalListingIdNumeric).toBeNull(); // not pure-numeric, no GID pattern
  });

  it("marks status as 'archived' when the underlying variant is inactive, even with sync_status='synced'", () => {
    // Regression guard for the bug where the panel showed Active for a
    // variant whose is_active flag had been flipped to false by the
    // archive flow. External ids and admin URL should still be exposed
    // so operators can clean up the channel side if needed.
    const dto = rowToListingDto({
      ...baseRow,
      variantIsActive: false,
    });

    expect(dto.status).toBe("archived");
    expect(dto.externalListingId).toBe("62783080038559");
    expect(dto.externalListingIdNumeric).toBe("62783080038559");
    expect(dto.adminUrl).toContain("admin.shopify.com");
  });
});
