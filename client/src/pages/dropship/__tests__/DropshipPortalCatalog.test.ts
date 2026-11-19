import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ListingAccessNoticeView,
  describeCatalogListingTier,
  formatIssue,
} from "../DropshipPortalCatalog";
import { describeListingAccess, listingAccessLink } from "@/lib/dropship-listing-access";
import { Router } from "wouter";

describe("DropshipPortalCatalog workflow", () => {
  // Step 1 plan S2-5 PR A: step 3's body moved to catalog/PublishStep.tsx; its source pins moved to DropshipCatalogPublish.test.ts.
  it("puts catalog choice before step 3's publish card", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    // Step 1 stage 1: the choice moved into ChooseStep, which holds the filters, the heading and the table, in that order.
    const choose = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/ChooseStep.tsx"), "utf8");
    const chooseStepPosition = source.indexOf("<ChooseStep");
    const listingPreviewPosition = source.indexOf("<PublishStep");
    const filterPosition = choose.indexOf("<CatalogFilterPanel");
    const availableCatalogPosition = choose.indexOf("{CHOOSE_WORDS.heading}");
    const catalogTablePosition = choose.indexOf("<ChooseTable");

    expect(chooseStepPosition).toBeGreaterThan(-1);
    expect(listingPreviewPosition).toBeGreaterThan(chooseStepPosition);
    expect(filterPosition).toBeGreaterThan(-1);
    expect(availableCatalogPosition).toBeGreaterThan(filterPosition);
    expect(catalogTablePosition).toBeGreaterThan(availableCatalogPosition);
    expect(choose).not.toContain("CatalogSelectionProofPanel");
    expect(choose).not.toContain("manage_catalog_selection");
    expect(source).not.toContain("CatalogSelectionProofPanel");
    expect(source).not.toContain("manage_catalog_selection");
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
    // Step 3's table is in PublishStep since step 1 plan S2-5 PR A (the Check's results).
    const publishSource = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/PublishStep.tsx"), "utf8");
    expect(publishSource).toContain("<DropshipListingPreview");
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
    // Step 1 stage 1: the table (and its badge) moved to ChooseTable; the page keeps no off-sale words either.
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/ChooseTable.tsx"), "utf8");
    const page = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    expect(source).toContain('{row.listingTier.tier === "case" ? "Case tier not active" : "Pack tier not active"}');
    expect(source).not.toMatch(/"(Cases off sale|Off sale|On sale)"/);
    expect(page).not.toMatch(/"(Cases off sale|Off sale|On sale)"/);
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
});
