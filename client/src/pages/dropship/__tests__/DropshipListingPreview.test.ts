import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropshipListingPreview, ListingPreviewDetailsContent, ListingPreviewTable } from "../DropshipListingPreview";
import { ListingShippingEstimateResult } from "../DropshipListingShippingEstimate";
import { UnsavedChangesProvider } from "../catalog/UnsavedChangesGuard";
import type { DropshipListingPreviewRow } from "@/lib/dropship-ops-surface";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-words";
import { LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE } from "@shared/dropship/listing-shipping-estimate";

afterEach(() => vi.unstubAllGlobals());
const AT = "2026-09-06T12:00:00.000Z";
/** The portal path the tests inject (`dropshipPortalPath` reads the browser's host, which node has none of). */
const portalHref = (path: string) => `/dropship-portal${path}`;
/** The fixture row's drawer address in Listing settings (product 1, size 1), as static markup escapes it. */
const DRAWER_HREF = 'href="/dropship-portal/catalog/setup?product=1&amp;size=1"';
/** The same drawer on the product alone: where its description and its policies are changed (no price box gets focus). */
const PRODUCT_HREF = 'href="/dropship-portal/catalog/setup?product=1"';
/** Step 3 never shows an editor, an id, a policy number, a category number or a Title-Cased code (plan §0, 11.4). */
const FORBIDDEN = /Edit price|Edit listing price|Save listing price|Preview listing price|Listing override|Effective listing policies|Policy [a-z0-9]+<|#\d|Draft First|Variant \d|>Fulfillment<|>Returns<|Your Store categories/;

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
/** Step 2's setup read as the cache holds it: eBay read (live names), with the store default's stored names. */
function setup(patch: Partial<PolicySetupFacts> = {}): PolicySetupFacts {
  return {
    selection: { merchantLocationKey: null, fulfillmentPolicyId: "ground", returnPolicyId: "store-returns", paymentPolicyId: "payment" },
    storedNames: { fulfillmentPolicyName: "Ground (stored)", returnPolicyName: "Store returns (stored)", paymentPolicyName: "Pay now (stored)" },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [{ id: "ground", name: "USPS Ground Advantage", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [{ id: "returns", name: "30-day returns" }],
      paymentPolicies: [{ id: "payment", name: "Pay now" }],
    },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    ...patch,
  };
}
function render(component: React.ReactNode) {
  vi.stubGlobal("React", React);
  // Node has no browser location, so the router renders from a fixed path.
  return renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/publish", children: component }));
}
function table(rows: DropshipListingPreviewRow[]) {
  return render(React.createElement(ListingPreviewTable, { rows, onOpen: () => {}, portalHref }));
}
function sheet(value: DropshipListingPreviewRow, setupFacts?: PolicySetupFacts, generatedAt = AT) {
  return render(React.createElement(ListingPreviewDetailsContent, { row: value, generatedAt, setup: setupFacts, portalHref }));
}
const count = (markup: string, text: string) => markup.split(text).length - 1;

describe("rich listing preview", () => {
  it("says where an eBay listing's category came from, by name and never with eBay's category number", () => {
    const value = { ...row(), marketplaceCategorySource: "rule" as const, marketplaceCategoryRuleName: "Envelopes" };
    const markup = sheet(value, setup(), "2026-09-30T12:00:00.000Z");
    expect(markup).toContain("Marketplace category");
    expect(markup).toContain("Envelopes");
    expect(markup).not.toContain("#123"); expect(markup).not.toContain("· #");
    expect(markup).toContain("Category source");
    expect(markup).toContain("From your rule &quot;Envelopes&quot;");
    const withoutSource = sheet(row(), setup(), "2026-09-30T12:00:00.000Z");
    expect(withoutSource).not.toContain("Category source");
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("labels the actual .ops product-cost source without implying a channel-wide discount", () => {
    const value = row();
    value.economics!.productCostSource = "variant_fixed_price";
    const markup = sheet(value, setup(), "2026-09-07T12:00:00.000Z");
    expect(markup).toContain("Source: your Shellz Club .ops price list (fixed product price)");
    expect(markup).not.toContain("Configured product discount");
    expect(markup).not.toContain("Suggested price");
  });
  it("links each row's price to the product's drawer in Listing settings instead of an editor (REC:921)", () => {
    const markup = table([row(), { ...row(), productVariantId: 2, productId: 3, sku: null }]);
    expect(markup).toContain("$8.99");
    expect(markup).toContain(DRAWER_HREF);
    expect(markup).toContain('aria-label="Change in Listing settings: ARM-50"');
    // Without a SKU the link is named by the listing's title, and the row never shows the size's id.
    expect(markup).toContain('href="/dropship-portal/catalog/setup?product=3&amp;size=2"');
    expect(markup).toContain('aria-label="Change in Listing settings: Mailers"');
    expect(markup).toContain("SKU unavailable");
    expect(count(markup, "Change in Listing settings ›")).toBe(2);
    // The only buttons left on a row open its preview.
    const buttons = markup.match(/<button[^>]+>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.includes("View preview for"))).toBe(true);
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("gives a size no longer in the catalog no link, since there is nothing to open (the server's productId 0)", () => {
    const markup = table([{ ...row(), productId: 0, previewStatus: "blocked", blockers: ["catalog_variant_not_found"] }]);
    expect(markup).toContain("$8.99");
    expect(markup).toContain("View preview for Mailers");
    expect(markup).toContain("This size is no longer in the Card Shellz catalog.");
    expect(markup).not.toContain("Change in Listing settings");
    expect(markup).not.toContain("catalog/setup");
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("puts the price link under the listing price and the description link under the description, each named for what it changes", () => {
    const markup = sheet(row(), setup());
    expect(markup).toContain("Your product cost");
    expect(count(markup, "Change in Listing settings ›")).toBe(2);
    // The price link lands on the size (its Exact price box); the description is the product's, so its link opens the product alone.
    expect(count(markup, DRAWER_HREF)).toBe(1);
    expect(count(markup, PRODUCT_HREF)).toBe(1);
    expect(markup).toContain('aria-label="Change in Listing settings: ARM-50"');
    expect(markup).toContain('aria-label="Change in Listing settings: description of Mailers"');
    // The price link sits with the listing price, not under the three money figures as a whole.
    const price = markup.indexOf(DRAWER_HREF);
    expect(price).toBeGreaterThan(markup.indexOf("Your listing price"));
    expect(price).toBeLessThan(markup.indexOf("Catalog reference retail"));
    const description = markup.indexOf(PRODUCT_HREF);
    expect(description).toBeGreaterThan(markup.indexOf("Useful mailers."));
    expect(description).toBeLessThan(markup.indexOf("Item specifics"));
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("names the listing policies from the setup read step 2 made this visit, with step 2's labels and sources (D14)", () => {
    const markup = sheet(row(), setup());
    expect(markup).toContain("Listing policies");
    expect(markup).toContain("Shipping policy"); expect(markup).toContain("USPS Ground Advantage");
    expect(markup).toContain("Return policy"); expect(markup).toContain("30-day returns");
    expect(markup).toContain("Payment policy"); expect(markup).toContain("Pay now");
    // The return policy is the product's own: its source says so; the others are the store default's.
    expect(count(markup, ">Set in Listing settings<")).toBe(1);
    expect(count(markup, ">Store default<")).toBe(2);
    expect(markup).not.toContain("Set in Listing settings ›");
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("falls back to the stored store-default name when eBay was not read this visit, and links a policy it cannot name", () => {
    const notRead = setup({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } });
    const markup = sheet(row(), notRead);
    expect(markup).toContain("Ground (stored)"); expect(markup).toContain("Pay now (stored)");
    expect(markup).not.toContain("USPS Ground Advantage");
    // The product's own return policy has no name source on this page: the row is the link, never the id.
    expect(markup).toContain('aria-label="Return policy: Set in Listing settings"');
    expect(count(markup, "Set in Listing settings ›")).toBe(1);
    // The policy link opens the product alone, like the description's; only the price link lands on the size.
    expect(count(markup, PRODUCT_HREF)).toBe(2);
    expect(count(markup, DRAWER_HREF)).toBe(1);
    // Under that link, "Set in Listing settings" would only repeat it, so the row shows no source; the named rows keep theirs.
    expect(count(markup, ">Set in Listing settings<")).toBe(0);
    expect(count(markup, ">Store default<")).toBe(2);
    expect(markup).not.toContain("returns</dd>"); expect(markup).not.toContain("Policy returns");
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("links every policy row on a direct load of step 3, when no setup read is cached", () => {
    const markup = sheet(row());
    expect(count(markup, "Set in Listing settings ›")).toBe(3);
    for (const label of ["Shipping policy", "Return policy", "Payment policy"]) {
      expect(markup).toContain(`aria-label="${label}: Set in Listing settings"`);
    }
    expect(count(markup, PRODUCT_HREF)).toBe(4);
    expect(count(markup, DRAWER_HREF)).toBe(1);
    // A store default's source stays under its link; the product's own return policy shows none (the link says it).
    expect(count(markup, ">Store default<")).toBe(2);
    expect(count(markup, ">Set in Listing settings<")).toBe(0);
    expect(markup).not.toContain("ground"); expect(markup).not.toContain("payment<");
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("shows a policy's source alone when the size has nothing to open, and says a missing policy is needed to list", () => {
    const gone = { ...row(), productId: 0, businessPolicySelection: { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: null, overriddenFields: ["returnPolicyId" as const] } };
    const markup = sheet(gone);
    expect(markup).not.toContain("Set in Listing settings ›");
    expect(markup).not.toContain("catalog/setup");
    expect(markup).toContain(">Store default<"); expect(markup).toContain(">Set in Listing settings<");
    expect(markup).toContain("Not set · Needed to list");
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("shows the store shelf by step 2's name and the listing mode in the store's words", () => {
    const markup = sheet(row(), setup());
    expect(markup).toContain("Store shelf"); expect(markup).toContain("Shipping supplies");
    expect(markup).toContain("Drafts only");
    const bare = sheet({ ...row(), storeCategoryNames: [], listingMode: null }, setup());
    expect(bare).toContain("Store shelf"); expect(bare).toContain("Not set");
    expect(bare).not.toContain("Ebay");
    expect(markup).not.toMatch(FORBIDDEN); expect(bare).not.toMatch(FORBIDDEN);
  });
  it("leaves the Listing settings draft out of every link's leave question, as the rail's link to that step does", () => {
    // The page keeps that step's draft across steps, so going there drops nothing (scopeWithoutPrefix, as the
    // page's toSetupScope); only an older panel's draft is asked about. Pinned in the source, as the sibling
    // tests pin wiring: one GuardedLink, always with that scope, and every link on the step goes through it.
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipListingPreview.tsx"), "utf8");
    expect(source.match(/<GuardedLink/g)).toHaveLength(1);
    expect(source).toContain("<GuardedLink href={href} scope={scope}");
    expect(source).toContain("const scope = scopeWithoutPrefix(useUnsavedDrafts(), LISTING_SETTINGS_GUARD_ID_PREFIX);");
    expect(source.match(/<SetupLink/g)).toHaveLength(2);
    // The links render inside the page's provider as they do outside it.
    const markup = render(React.createElement(UnsavedChangesProvider, null,
      React.createElement(ListingPreviewTable, { rows: [row()], onOpen: () => {}, portalHref })));
    expect(markup).toContain(DRAWER_HREF);
    expect(markup).toContain('aria-label="Change in Listing settings: ARM-50"');
  });
  it("reads policy names from step 2's setup cache for the preview's store, not from the older override cache", () => {
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipListingPreview.tsx"), "utf8");
    expect(source).toContain("ebayListingSetupQueryKey(preview.storeConnectionId)");
    expect(source).not.toContain("ebayListingPolicyQueryKey");
    // No writer on step 3 (plan 11.4): the editors and their callbacks are gone from this component.
    expect(source).not.toContain("DropshipListingPriceEditor");
    expect(source).not.toContain("DropshipListingContentEditor");
    expect(source).not.toContain("priceSaveCallbacks");
  });
  it("shows actual price and vendor cost but no new suggested price or profit field", () => {
    const markup = table([row()]);
    expect(markup).toContain("$4.50"); expect(markup).toContain("$8.99"); expect(markup).toContain("11840");
    expect(markup).toContain("View preview for Mailers"); expect(markup).toContain("Pack of 50");
    expect(markup).not.toContain("Suggested"); expect(markup).not.toContain("Profit");
  });
  it("renders description as text and shows the policies and reference-cost exclusions", () => {
    const markup = sheet(row(), setup());
    expect(markup).toContain("&lt;script&gt;"); expect(markup).not.toContain("<script>");
    expect(markup).toContain("Catalog reference retail"); expect(markup).toContain("Marketplace fees are not included");
    expect(markup).toContain("Set in Listing settings"); expect(markup).toContain("Shipping supplies"); expect(markup).toContain("Material");
    expect(markup).not.toContain("merchantLocationKey");
  });
  it("does not fabricate missing costs or images and labels catalog-only media", () => {
    const value = row(); value.economics!.vendorProductCostCents = null;
    value.presentation!.images = [{ assetId: 2, url: null, altText: null, source: "catalog_file", publicationStatus: "not_included", reason: "not_publishable" }];
    const markup = sheet(value, setup());
    expect(markup).toContain("Unavailable"); expect(markup).toContain("No image available"); expect(markup).toContain("not included in the listing payload");
    expect(markup).not.toContain("$0.00");
  });
  it("shows an uploaded photo the listing publishes as included, and says why one is left out", () => {
    const uploadedUrl = `https://catalog.example.test/api/catalog/images/3/${"c".repeat(64)}.png`;
    const value = row();
    value.presentation!.images = [{ assetId: 3, url: uploadedUrl, altText: "Uploaded photo", source: "catalog_file", publicationStatus: "included", reason: null }];
    const included = sheet(value, setup(), "2026-10-06T12:00:00.000Z");
    expect(included).toContain(`src="${uploadedUrl}"`);
    expect(included).toContain("1 included in listing");
    expect(included).toContain("Included in the listing payload.");

    value.presentation!.images = [{ assetId: 4, url: "/api/dropship/listings/stores/9/variants/1/assets/4/file", altText: null,
      source: "catalog_file", publicationStatus: "not_included", reason: "catalog_photo_public_address_missing" }];
    value.warnings = ["catalog_photo_public_address_missing"];
    const leftOut = sheet(value, setup(), "2026-10-06T12:00:00.000Z");
    expect(leftOut).toContain("0 included in listing");
    expect(leftOut).toContain("An uploaded catalog photo can&#x27;t be sent to the marketplace yet, so this listing goes out without it.");
  });
  it("words a row's problem under its status, never the code", () => {
    const markup = table([{ ...row(), previewStatus: "blocked", blockers: ["missing_config:businessPolicies.returnPolicyId", "pricing:below_floor:policy_4"] }]);
    expect(markup).toContain("No return policy. Choose one in Listing settings.");
    expect(markup).toContain("Outside a Card Shellz price limit.");
    expect(markup).not.toContain("missing_config"); expect(markup).not.toContain("policy_4");
    expect(markup).not.toMatch(FORBIDDEN);
  });
  it("keeps old responses usable with a new-preview prompt", () => {
    const value = row(); delete value.economics; delete value.presentation;
    const markup = sheet(value, setup());
    expect(markup).toContain("Generate a new listing preview"); expect(markup).toContain("$8.99");
  });
  it("bounds 10,000 synthetic previews to 50 mounted rows, each with a link and no editor", () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    try {
      const rows = Array.from({ length: 10000 }, (_, index) => ({ ...row(), productVariantId: index + 1, title: `Listing ${index + 1}` }));
      const markup = render(React.createElement(QueryClientProvider, { client }, React.createElement(DropshipListingPreview, {
        preview: { vendorId: 1, storeConnectionId: 1, platform: "ebay", generatedAt: AT, rows,
          summary: { total: 10000, ready: 10000, blocked: 0, warning: 0 } },
        portalHref })));
      expect(markup.match(/aria-label="View preview for Listing /g)).toHaveLength(50);
      expect(markup).toContain("Page 1 of 200"); expect(markup).not.toContain("Estimate shipping");
      expect(markup.match(/aria-label="Change in Listing settings: ARM-50"/g)).toHaveLength(50);
      expect(markup).toContain("Prices and text are changed in Listing settings.");
      expect(markup).not.toContain("Edit the listing price here");
      expect(markup).not.toContain("Loading saved price");
      expect(markup).not.toMatch(FORBIDDEN);
      expect(client.getQueryCache().getAll().filter((query) => String(query.queryKey[0]).endsWith("/price"))).toHaveLength(0);
    } finally { client.clear(); }
  });
  it("shows missing shipping rates as unavailable, never free", () => {
    const markup = render(React.createElement(ListingShippingEstimateResult, { result: { status: "unavailable", storeConnectionId: 1, productVariantId: 1,
      quantity: 1, destination: { country: "US", region: null, postalCode: "16066" }, estimatedAt: AT, warnings: [], code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, message: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE } }));
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
