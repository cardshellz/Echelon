import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  type DropshipCatalogResponse,
  type DropshipCatalogRow,
} from "@/lib/dropship-ops-surface";
import {
  ListingAccessNoticeView,
  describeCatalogListingTier,
  fetchAllSelectedCatalogRows,
  formatIssue,
} from "../DropshipPortalCatalog";
import { describeListingAccess, listingAccessLink } from "@/lib/dropship-listing-access";
import { Router } from "wouter";

function row(productVariantId: number): DropshipCatalogRow {
  return { productVariantId } as DropshipCatalogRow;
}

function page(input: {
  rows: DropshipCatalogRow[];
  total: number;
  page: number;
  limit: number;
}): DropshipCatalogResponse {
  return {
    ...input,
    facets: {
      categories: [],
      productLines: [],
      products: [],
    },
  };
}

describe("DropshipPortalCatalog workflow", () => {
  it("loads every selected catalog page and removes duplicate variants", async () => {
    const loadPage = vi.fn(async (pageNumber: number) => {
      if (pageNumber === 1) {
        return page({
          rows: [row(11), row(12)],
          total: 3,
          page: 1,
          limit: 2,
        });
      }
      return page({
        rows: [row(12), row(13)],
        total: 3,
        page: 2,
        limit: 2,
      });
    });

    const rows = await fetchAllSelectedCatalogRows(loadPage);

    expect(loadPage.mock.calls).toEqual([
      [1, 200],
      [2, 200],
    ]);
    expect(rows.map((catalogRow) => catalogRow.productVariantId)).toEqual([11, 12, 13]);
  });

  it("puts catalog choice before listing preview and reserves MFA for push", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    const filterPosition = source.indexOf("<CatalogFilterPanel");
    const availableCatalogPosition = source.indexOf("Available catalog");
    const catalogTablePosition = source.indexOf("<CatalogTable");
    const listingPreviewPosition = source.indexOf("<ListingPreviewPanel");

    expect(filterPosition).toBeGreaterThan(-1);
    expect(availableCatalogPosition).toBeGreaterThan(filterPosition);
    expect(catalogTablePosition).toBeGreaterThan(availableCatalogPosition);
    expect(listingPreviewPosition).toBeGreaterThan(catalogTablePosition);
    expect(source).not.toContain("CatalogSelectionProofPanel");
    expect(source).not.toContain("manage_catalog_selection");
    expect(source).toContain("MFA is requested only when you queue ready listings.");
    expect(source).toContain('verifyPasskeyStepUp("bulk_listing_push")');
    expect(source).toContain('startEmailStepUp("bulk_listing_push")');
  });

  it("names the required eBay category and the optional store shelf in step 3's preview, and keeps the shelf picker's words", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    const comboboxSource = readFileSync(
      join(process.cwd(), "client", "src", "components", "dropship", "EbayStoreCategoryCombobox.tsx"),
      "utf8",
    );

    // The per-size store category panel went in Listing settings PR 12; the step's Store shelf row replaces it.
    expect(source).not.toContain("Your eBay Store organization (optional)");
    expect(source).not.toContain("The required eBay category comes from your eBay categories above.");
    const previewSource = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipListingPreview.tsx"), "utf8");
    expect(source).toContain("<DropshipListingPreview");
    expect(previewSource).toContain("Marketplace category");
    // The shelf row carries step 2's name ("Store shelf", R:90) through the words module (PR 10h).
    expect(previewSource).toContain("LISTING_PREVIEW_WORDS.storeShelf");
    expect(previewSource).not.toContain("Your Store categories");
    expect(comboboxSource).toContain("Search your eBay Store categories...");
    expect(comboboxSource).toContain('className="max-h-64 overflow-y-auto overscroll-contain"');
  });

  it("turns raw eBay preview config keys into plain words that name Listing settings (PR 10h)", () => {
    expect(formatIssue("missing_config:merchantLocationKey")).toBe("Your ship-from location isn't set. Update it in Listing settings.");
    expect(formatIssue("missing_config:businessPolicies.returnPolicyId")).toBe("No return policy. Choose one in Listing settings.");
    expect(formatIssue("ebay_browse_category_required")).toBe("No eBay category. Pick one in Listing settings.");
  });

  it("has no step 2 writer or eBay reauthorization of its own (Listing settings PR 12)", () => {
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    // The per-size shelf PUT and the inline eBay sign-in went with the older panels; the step's rows write, and its
    // sign-in banner sends the vendor to Onboarding.
    expect(source).not.toContain("/api/dropship/ebay/store-category-assignments");
    expect(source).not.toContain("updateEbayStoreCategoryAssignment");
    expect(source).not.toContain("EbayStoreCategoryAuthorizationRecovery");
    expect(source).not.toContain("/api/dropship/store-connections/oauth/start");
    // The store shelves read stays: the step shows it as `shelves`.
    expect(source).toContain("shelves={ebayStoreCategoryQuery}");
  });

});

describe("catalog listing tier", () => {
  it("explains a tier that is not active from the server's reason, with the published amount and the gap", () => {
    const tier = { eligible: false, policyMinimumCents: 50_000, reserveShortfallCents: 0, balanceShortfallCents: 38_000 };
    expect(describeCatalogListingTier({ ...tier, tier: "case", reason: "balance_below_tier" }))
      .toBe("The Case tier is not active: your balance needs to reach $500. You need $380 more.");
    expect(describeCatalogListingTier({ ...tier, tier: "case", reason: "reserve_below_tier", reserveShortfallCents: 40_000 }))
      .toBe("The Case tier is not active: it needs a reserve of $500. Raise your reserve in Wallet.");
    expect(describeCatalogListingTier({ ...tier, tier: "pack", policyMinimumCents: 10_000, reason: "autopay_off" }))
      .toBe("The Pack tier is not active: autopay is off, so your wallet has no reserve. Turn on autopay with a reserve of at least $100 in Wallet.");
    // Cents are shown in full.
    expect(describeCatalogListingTier({ ...tier, tier: "pack", policyMinimumCents: 10_000, reason: "balance_below_tier", balanceShortfallCents: 1_050 }))
      .toBe("The Pack tier is not active: your balance needs to reach $100. You need $10.50 more.");
  });

  it("labels the badge by tier and never says on sale or off sale", () => {
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    expect(source).toContain('{row.listingTier.tier === "case" ? "Case tier not active" : "Pack tier not active"}');
    expect(source).not.toMatch(/"(Cases off sale|Off sale|On sale)"/);
  });
});

describe("listing access notice", () => {
  function render(notice: Parameters<typeof ListingAccessNoticeView>[0]["notice"], tone: "notice" | "error" = "notice") {
    vi.stubGlobal("React", React);
    // Node has no browser location, so the router renders from a fixed path.
    return renderToStaticMarkup(React.createElement(Router, {
      ssrPath: "/dropship-portal/catalog",
      children: React.createElement(ListingAccessNoticeView, { notice, tone, portalHref: (path: string) => `/dropship-portal${path}` }),
    }));
  }

  it("tells an onboarding vendor to activate and links to the Onboarding page", () => {
    const notice = describeListingAccess({ status: "onboarding", entitlementStatus: "active" }, "push");
    if (!notice) throw new Error("Expected an onboarding push notice.");
    const markup = render(notice);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Finish the steps on the Onboarding page and choose Activate .ops.");
    expect(markup).toContain('href="/dropship-portal/onboarding"');
    expect(markup).toContain("Go to Onboarding");
  });

  it("opens the membership page in a new tab, the mail client without one, and marks a refusal as an alert", () => {
    const lapsed = describeListingAccess({ status: "lapsed", entitlementStatus: "lapsed" }, "push");
    const suspended = describeListingAccess({ status: "suspended", entitlementStatus: "suspended" }, "push");
    if (!lapsed || !suspended) throw new Error("Expected blocked notices.");
    const lapsedMarkup = render(lapsed, "error");
    expect(lapsedMarkup).toContain('role="alert"');
    expect(lapsedMarkup).toContain('href="https://www.cardshellz.com/pages/club"');
    expect(lapsedMarkup).toContain('target="_blank"');
    const supportMarkup = render(suspended);
    expect(supportMarkup).toContain('href="mailto:support@cardshellz.com"');
    expect(supportMarkup).not.toContain("target=");
  });

  it("shows the message alone when there is no link to offer", () => {
    const markup = render({ message: "Your .ops membership payment is past due.", resolution: "update_membership_payment",
      link: listingAccessLink("update_membership_payment") });
    expect(markup).toContain("Your .ops membership payment is past due.");
    expect(markup).not.toContain("<a ");
  });

  it("keeps listing failures inside the listing card and never emails a code for a blocked push", () => {
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    const pushHandler = source.slice(source.indexOf("async function pushListings()"), source.indexOf("async function runListingAction("));
    expect(pushHandler.indexOf("if (pushAccessNotice) return;")).toBeGreaterThan(-1);
    expect(pushHandler.indexOf("if (pushAccessNotice) return;")).toBeLessThan(pushHandler.indexOf("startEmailStepUp"));
    expect(source).toContain("{listingError && (listingError.notice");
    expect(source).not.toContain("A launch-ready store connection is required before listing preview or push.");
    // An expired verification reloads the proof so the next click asks again.
    const start = source.indexOf("function showListingError(");
    const end = source.indexOf("function applyCatalogFilters(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const errorHandler = source.slice(start, end);
    expect(errorHandler).toContain("if (isStepUpRequiredError(caught)) {");
    expect(errorHandler).toContain("void refetchAuth();");
  });

  it("says any Listing settings save holds step 3, in plain words (Interim, PR 12 PROPOSAL)", () => {
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    const words = ["Wait for your listing settings to finish saving, then queue again.", "Saving your listing settings…"];
    for (const sentence of words) {
      expect(source.split(sentence).length - 1, sentence).toBe(1);
      expect(sentence).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
      expect(sentence).not.toContain("Older settings");
    }
    // The queue guard sits where a pending save stops the push.
    const pushHandler = source.slice(source.indexOf("async function pushListings()"), source.indexOf("async function queueListingsOnce("));
    expect(pushHandler).toContain(`if (pendingPriceSavesRef.current > 0) {`);
    expect(pushHandler).toContain(words[0]);
    // A save no longer refreshes the preview, so the stale-preview line no longer says it does.
    expect(source).not.toContain("Saving your listing price and refreshing the preview");
    expect(source).not.toContain("Wait for your listing price to finish saving");
  });
});
