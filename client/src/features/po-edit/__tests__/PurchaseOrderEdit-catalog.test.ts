import { describe, expect, it } from "vitest";

import {
  applyCatalogUpsertMatchesToLines,
  catalogReceiveConfiguration,
  isExplicitVendorQuoteBasis,
  poLineQuoteMetadataError,
  quoteMetadataEditorLinePatch,
  quoteMetadataOnlyLinePatch,
  resolvePreloadCatalogPricingIdentity,
} from "../../../pages/PurchaseOrderEdit";

function line(overrides: Record<string, unknown> = {}) {
  return {
    serverLineId: null,
    clientId: "line-1",
    lineType: "product",
    description: "",
    parentClientId: null,
    productVariantId: null,
    expectedReceiveVariantId: 22,
    expectedReceiveUnitsPerVariant: 6,
    productId: 11,
    productName: "Widget",
    sku: "W-1",
    orderQty: 24,
    pricingDraft: null,
    hasExplicitPricing: true,
    preserveLegacyPricing: false,
    pricingSource: "manual",
    quoteReference: null,
    quotedAt: null,
    quoteValidUntil: null,
    unitCostMills: 1_000,
    totalProductCostCents: 240,
    packagingCostCents: 0,
    vendorProductId: null,
    catalogOriginallyAbsent: true,
    ...overrides,
  } as any;
}

const candidate = {
  clientId: "line-1",
  productId: 11,
  productVariantId: 22,
  productName: "Widget",
  sku: "W-1",
  unitCostCents: 10,
  unitCostMills: 1_000,
} as any;

describe("PurchaseOrderEdit catalog identity", () => {
  it("keeps legacy preload economics unconfirmed", () => {
    expect(isExplicitVendorQuoteBasis("legacy_unknown")).toBe(false);
    expect(isExplicitVendorQuoteBasis(null)).toBe(false);
    expect(isExplicitVendorQuoteBasis("per_piece")).toBe(true);
  });

  it("does not let metadata-only edits confirm legacy economics", () => {
    expect(quoteMetadataOnlyLinePatch(
      { hasExplicitPricing: false },
      {
        quoteReference: "RFQ-19",
        quotedAt: null,
        quoteValidUntil: null,
      },
    )).toEqual({
      quoteReference: "RFQ-19",
      quotedAt: null,
      quoteValidUntil: null,
    });

    expect(quoteMetadataOnlyLinePatch(
      { hasExplicitPricing: true },
      {
        quoteReference: "RFQ-20",
        quotedAt: "2026-07-13T00:00:00.000Z",
        quoteValidUntil: null,
      },
    )).toMatchObject({ pricingSource: "manual" });
  });

  it("validates full-editor quote metadata and preserves untouched timestamps", () => {
    expect(poLineQuoteMetadataError({
      quoteReference: "Q".repeat(256),
      quotedAt: null,
      quoteValidUntil: null,
    } as any)).toBe("Quote reference must be 255 characters or fewer.");
    expect(poLineQuoteMetadataError({
      quoteReference: "RFQ-1",
      quotedAt: "2026-07-13T14:22:11.000Z",
      quoteValidUntil: "2026-07-12",
    } as any)).toBe("Valid-until date must be on or after the quote date.");

    expect(quoteMetadataEditorLinePatch({
      hasExplicitPricing: false,
      quoteReference: "RFQ-1",
      quotedAt: "2026-07-13T14:22:11.000Z",
      quoteValidUntil: null,
    }, {
      quoteReference: "RFQ-2",
      quotedAt: "2026-07-13",
      quoteValidUntil: "",
    })).toEqual({
      quoteReference: "RFQ-2",
      quotedAt: "2026-07-13T14:22:11.000Z",
      quoteValidUntil: null,
    });
  });

  it("uses the warehouse variant units instead of the supplier pack size", () => {
    expect(catalogReceiveConfiguration({
      productVariantId: 22,
      receiveUnitsPerVariant: 6,
      // @ts-expect-error packSize must have no influence on receiving.
      packSize: 24,
    })).toEqual({
      productVariantId: 22,
      expectedReceiveVariantId: 22,
      expectedReceiveUnitsPerVariant: 6,
    });
  });

  it("retains the preload vendor-product id for trusted catalog provenance", () => {
    expect(resolvePreloadCatalogPricingIdentity({
      catalogSource: "vendor_catalog",
      pricingBasis: "per_purchase_uom",
      vendorProductId: 91,
      quotedAt: "2020-01-01T00:00:00.000Z",
      quoteValidUntil: "2999-12-31",
    })).toEqual({
      hasReusableCatalogPricing: true,
      vendorProductId: 91,
      pricingSource: "vendor_catalog",
    });
  });

  it("preserves the reusable quote basis but downgrades provenance when an old preload omits the link", () => {
    expect(resolvePreloadCatalogPricingIdentity({
      catalogSource: "vendor_catalog",
      pricingBasis: "per_purchase_uom",
      quotedAt: "2020-01-01T00:00:00.000Z",
      quoteValidUntil: "2999-12-31",
    })).toEqual({
      hasReusableCatalogPricing: true,
      vendorProductId: null,
      pricingSource: "manual",
    });
  });

  it("downgrades stale catalog pricing to a manual quote for review", () => {
    expect(resolvePreloadCatalogPricingIdentity({
      catalogSource: "vendor_catalog",
      pricingBasis: "per_piece",
      vendorProductId: 91,
      quotedAt: "2024-01-01T00:00:00.000Z",
      quoteValidUntil: null,
    })).toEqual({
      hasReusableCatalogPricing: false,
      vendorProductId: 91,
      pricingSource: "manual",
    });
  });

  it("returns updated line data for the same save attempt after catalog upsert", () => {
    const result = applyCatalogUpsertMatchesToLines(
      [line()],
      [candidate],
      [candidate],
      { created: [{ vendorProductId: 91, productId: 11, productVariantId: 22 }] },
    );

    expect(result[0]).toMatchObject({
      vendorProductId: 91,
      pricingSource: "vendor_catalog",
      catalogOriginallyAbsent: false,
    });
  });

  it("never asserts catalog provenance if the upsert response omits its row id", () => {
    const result = applyCatalogUpsertMatchesToLines(
      [line()],
      [candidate],
      [candidate],
      { updated: [{ productId: 11, productVariantId: 22 }] },
    );

    expect(result[0]).toMatchObject({
      vendorProductId: null,
      pricingSource: "manual",
      catalogOriginallyAbsent: false,
    });
  });
});
