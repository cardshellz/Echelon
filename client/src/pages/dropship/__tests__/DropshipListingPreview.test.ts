import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropshipListingPreview, ListingPreviewDetailsContent, ListingPreviewTable } from "../DropshipListingPreview";
import { ListingShippingEstimateResult } from "../DropshipListingShippingEstimate";
import type { DropshipListingPreviewRow } from "@/lib/dropship-ops-surface";
import { LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE } from "@shared/dropship/listing-shipping-estimate";

afterEach(() => vi.unstubAllGlobals());
function row(): DropshipListingPreviewRow {
  return { productVariantId: 1, productId: 1, sku: "ARM-50", title: "Mailers", platform: "ebay", listingMode: "draft_first",
    currentListingStatus: "not_listed", previewStatus: "ready", blockers: [], warnings: [], marketplaceQuantity: 11840, priceCents: 899,
    marketplaceCategoryId: "123", marketplaceCategoryName: "Envelopes", storeCategoryNames: ["Shipping supplies"],
    businessPolicySelection: { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payment", overriddenFields: ["returnPolicyId"] }, previewHash: "hash",
    presentation: { source: "resolved_listing", title: "Mailers", descriptionText: '<script>alert("unsafe")</script> Useful mailers.', productName: "Mailers",
      variantName: "Pack of 50", unitsPerVariant: 50, brand: "Card Shellz", condition: "New", itemSpecifics: [{ name: "Material", values: ["Paper"] }],
      images: [{ assetId: 1, url: "https://images.example.test/photo.jpg", altText: "Mailer pack", source: "external_url", publicationStatus: "included", reason: null }], issues: [] },
    economics: { currency: "USD", basis: "one_sellable_variant", unitsPerVariant: 50, referenceRetailPriceCents: 899, listingPriceCents: 899,
      vendorProductCostCents: 450, channelDiscountPercent: 50, productCostStatus: "available", issues: [] } };
}
function render(component: React.ReactNode) { vi.stubGlobal("React", React); return renderToStaticMarkup(component); }
describe("rich listing preview", () => {
  it("labels the actual .ops product-cost source without implying a channel-wide discount", () => {
    const value = row();
    value.economics!.productCostSource = "variant_fixed_price";
    const markup = render(React.createElement(ListingPreviewDetailsContent, { row: value, generatedAt: "2026-09-07T12:00:00.000Z" }));
    expect(markup).toContain("Source: your Shellz Club .ops price list (fixed product price)");
    expect(markup).not.toContain("Configured product discount");
    expect(markup).not.toContain("Suggested price");
  });
  it("puts a lazy inline price action next to the existing listing price", () => {
    const markup = render(React.createElement(ListingPreviewTable, { rows: [row()], onOpen: () => {},
      priceEditing: { variantId: null, disabled: false, onEdit: () => {}, editor: null } }));
    expect(markup).toContain("Edit listing price for ARM-50");
    expect(markup).toContain("Edit price");
    expect(markup).toContain("$8.99");
    expect(markup).not.toContain("Save listing price");
  });
  it("mounts an inline editor only for its target row and protects other actions until it closes", () => {
    const markup = render(React.createElement(ListingPreviewTable, { rows: [row(), { ...row(), productVariantId: 2, sku: "OTHER" }], onOpen: () => {},
      priceEditing: { variantId: 1, disabled: true, onEdit: () => {}, editor: React.createElement("div", null, "Inline saved-price form") } }));
    expect(markup.match(/Inline saved-price form/g)).toHaveLength(1);
    expect(markup).not.toContain("Edit listing price for ARM-50");
    expect(markup).toContain("Edit listing price for OTHER");
    const buttons = markup.match(/<button[^>]+>/g) ?? [];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.includes("disabled"))).toBe(true);
  });
  it("places the editable price separately from the preview price snapshot and product costs", () => {
    const markup = render(React.createElement(ListingPreviewDetailsContent, { row: row(), generatedAt: "2026-09-06T12:00:00.000Z",
      priceEditor: React.createElement("section", { "aria-label": "Price editor" }, "Save listing price") }));
    expect(markup).toContain("Preview listing price");
    expect(markup).toContain("Your product cost");
    expect(markup).toContain("Save listing price");
    expect(markup.indexOf("Save listing price")).toBeLessThan(markup.indexOf('aria-label="Listing details"'));
  });
  it("shows actual price and vendor cost but no new suggested price or profit field", () => {
    const markup = render(React.createElement(ListingPreviewTable, { rows: [row()], onOpen: () => {} }));
    expect(markup).toContain("$4.50"); expect(markup).toContain("$8.99"); expect(markup).toContain("11840");
    expect(markup).toContain("View preview for Mailers"); expect(markup).toContain("Pack of 50");
    expect(markup).not.toContain("Suggested"); expect(markup).not.toContain("Profit");
  });
  it("renders description as text and shows effective policies and reference-cost exclusions", () => {
    const markup = render(React.createElement(ListingPreviewDetailsContent, { row: row(), generatedAt: "2026-09-06T12:00:00.000Z" }));
    expect(markup).toContain("&lt;script&gt;"); expect(markup).not.toContain("<script>");
    expect(markup).toContain("Catalog reference retail"); expect(markup).toContain("Marketplace fees are not included");
    expect(markup).toContain("Listing override"); expect(markup).toContain("Shipping supplies"); expect(markup).toContain("Material");
    expect(markup).not.toContain("merchantLocationKey");
  });
  it("does not fabricate missing costs or images and labels catalog-only media", () => {
    const value = row(); value.economics!.vendorProductCostCents = null;
    value.presentation!.images = [{ assetId: 2, url: null, altText: null, source: "catalog_file", publicationStatus: "not_included", reason: "not_publishable" }];
    const markup = render(React.createElement(ListingPreviewDetailsContent, { row: value, generatedAt: "2026-09-06T12:00:00.000Z" }));
    expect(markup).toContain("Unavailable"); expect(markup).toContain("No image available"); expect(markup).toContain("not included in the listing payload");
    expect(markup).not.toContain("$0.00");
  });
  it("keeps old responses usable with a new-preview prompt", () => {
    const value = row(); delete value.economics; delete value.presentation;
    const markup = render(React.createElement(ListingPreviewDetailsContent, { row: value, generatedAt: "2026-09-06T12:00:00.000Z" }));
    expect(markup).toContain("Generate a new listing preview"); expect(markup).toContain("$8.99");
  });
  it("bounds 10,000 synthetic previews to 50 mounted rows", () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    try {
      const rows = Array.from({ length: 10000 }, (_, index) => ({ ...row(), productVariantId: index + 1, title: `Listing ${index + 1}` }));
      const markup = render(React.createElement(QueryClientProvider, { client }, React.createElement(DropshipListingPreview, {
        preview: { vendorId: 1, storeConnectionId: 1, platform: "ebay", generatedAt: "2026-09-06T12:00:00.000Z", rows,
          summary: { total: 10000, ready: 10000, blocked: 0, warning: 0 } },
        priceSaveCallbacks: { onSaveStarted: () => {}, onSaveSettled: () => {}, onSaved: async () => {} } })));
      expect(markup.match(/aria-label="View preview for Listing /g)).toHaveLength(50);
      expect(markup).toContain("Page 1 of 200"); expect(markup).not.toContain("Estimate shipping");
      expect(markup.match(/aria-label="Edit listing price for /g)).toHaveLength(50);
      expect(markup).not.toContain("Loading saved price");
      expect(client.getQueryCache().getAll().filter((query) => String(query.queryKey[0]).endsWith("/price"))).toHaveLength(0);
    } finally { client.clear(); }
  });
  it("shows missing shipping rates as unavailable, never free", () => {
    const markup = render(React.createElement(ListingShippingEstimateResult, { result: { status: "unavailable", storeConnectionId: 1, productVariantId: 1,
      quantity: 1, destination: { country: "US", region: null, postalCode: "16066" }, estimatedAt: "2026-09-06T12:00:00.000Z", warnings: [], code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, message: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE } }));
    expect(markup).toContain("Shipping estimate unavailable"); expect(markup).not.toContain("$0.00");
  });
  it("shows only the final shipping charge and scenario, never internal rate or fee details", () => {
    const markup = render(React.createElement(ListingShippingEstimateResult, { result: { status: "estimated", storeConnectionId: 1, productVariantId: 1,
      quantity: 1, destination: { country: "US", region: null, postalCode: "16046" }, estimatedAt: "2026-09-08T12:00:00.000Z", warnings: [], totalShippingCents: 824, currency: "USD" } }));
    expect(markup).toContain("$8.24");
    expect(markup).toContain("16046, US");
    for (const privateLabel of ["Rate and fee breakdown", "Rate-table charge", "Shipping markup", "Insurance pool", "Dunnage", "Rate table", "<details"]) {
      expect(markup).not.toContain(privateLabel);
    }
  });
});
