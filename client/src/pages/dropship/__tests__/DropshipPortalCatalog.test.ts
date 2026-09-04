import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DropshipApiError,
  type DropshipCatalogResponse,
  type DropshipCatalogRow,
} from "@/lib/dropship-ops-surface";
import {
  EbayStoreCategoryAssignmentPanel,
  fetchAllSelectedCatalogRows,
  formatIssue,
  shouldOfferEbayStoreReconnect,
} from "../DropshipPortalCatalog";
import { EbayStoreCategoryAuthorizationRecoveryView } from "../EbayStoreCategoryAuthorizationRecovery";

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

  it("separates required marketplace categorization from optional seller Store organization", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    const comboboxSource = readFileSync(
      join(process.cwd(), "client", "src", "components", "dropship", "EbayStoreCategoryCombobox.tsx"),
      "utf8",
    );

    expect(source).toContain("Your eBay Store organization (optional)");
    expect(source).toContain("Card Shellz supplies the required eBay marketplace category.");
    expect(source).toContain("Leaving both fields blank does not block preview or push.");
    expect(source).toContain("Marketplace category");
    expect(source).toContain("Your Store:");
    expect(comboboxSource).toContain("Search your eBay Store categories...");
    expect(comboboxSource).toContain('className="max-h-64 overflow-y-auto overscroll-contain"');
  });

  it("keeps store policy defaults separate from revision-safe listing overrides", () => {
    const catalogSource = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    const overrideSource = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "EbayListingPolicyOverridePanel.tsx"),
      "utf8",
    );
    const setupPosition = catalogSource.indexOf("<EbayListingSetupPanel");
    const overridePosition = catalogSource.indexOf("<EbayListingPolicyOverridePanel");
    const storeCategoryPosition = catalogSource.indexOf("<EbayStoreCategoryAssignmentPanel");

    expect(overridePosition).toBeGreaterThan(setupPosition);
    expect(storeCategoryPosition).toBeGreaterThan(overridePosition);
    expect(overrideSource).toContain("Store default —");
    expect(overrideSource).toContain("expectedRevisionId");
    expect(overrideSource).toContain("disabled={rowPending}");
    expect(overrideSource).toContain("Search policies...");
  });

  it("offers authorization recovery only for reconnectable eBay Store-category errors", () => {
    vi.stubGlobal("React", React);
    const permissionError = new DropshipApiError({
      status: 403,
      code: "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
      message: "Reconnect the eBay store to grant Store-category access.",
    });
    const providerError = new DropshipApiError({
      status: 502,
      code: "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE",
      message: "The connected eBay account did not return a Store category hierarchy.",
    });

    expect(shouldOfferEbayStoreReconnect(permissionError)).toBe(true);
    expect(shouldOfferEbayStoreReconnect(providerError)).toBe(false);

    const markup = renderToStaticMarkup(React.createElement(EbayStoreCategoryAssignmentPanel, {
      authorizationRecovery: React.createElement("button", null, "Refresh eBay authorization"),
      data: null,
      error: permissionError,
      isLoading: false,
      onAssignmentChange: () => undefined,
      pendingProductVariantIds: new Set<number>(),
      rows: [],
    }));

    expect(markup).toContain("eBay Store-category authorization needs attention.");
    expect(markup).toContain("Refresh eBay authorization");
    expect(markup).toContain("You can still preview and push listings");
  });

  it("runs Store-category reauthorization inline and returns directly to Catalog", () => {
    const catalogSource = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );
    const recoverySource = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "EbayStoreCategoryAuthorizationRecovery.tsx"),
      "utf8",
    );

    expect(catalogSource).toContain("<EbayStoreCategoryAuthorizationRecovery");
    expect(recoverySource).toContain('verifyPasskeyStepUp("connect_store")');
    expect(recoverySource).toContain('startEmailStepUp("connect_store")');
    expect(recoverySource).toContain('action: "connect_store"');
    expect(recoverySource).toContain('"/api/dropship/store-connections/oauth/start"');
    expect(recoverySource).toContain('intent: "refresh_connection"');
    expect(recoverySource).toContain('returnTo: dropshipPortalPath("/catalog")');
    expect(recoverySource).toContain("window.location.assign(result.authorizationUrl)");
    expect(catalogSource).not.toContain('setLocation(dropshipPortalPath("/settings"))');
  });

  it("turns raw eBay preview config keys into actionable setup labels", () => {
    expect(formatIssue("missing_config:merchantLocationKey")).toBe("eBay setup: Inventory location");
    expect(formatIssue("missing_config:businessPolicies.returnPolicyId")).toBe("eBay setup: Return policy");
    expect(formatIssue("ebay_browse_category_required")).toBe(
      "Card Shellz marketplace category setup required",
    );
  });

  it("places an explicit authorization confirmation beside the emailed code", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(React.createElement(EbayStoreCategoryAuthorizationRecoveryView, {
      connectProofActive: false,
      emailCodeSent: true,
      errorMessage: "",
      hasPasskey: false,
      message: "Verification code sent to your email address.",
      onCancel: () => undefined,
      onStart: () => undefined,
      onVerificationCodeChange: () => undefined,
      pendingAction: null,
      permissionRequired: true,
      storeName: "marz_cards",
      verificationCode: "813606",
    }));

    expect(markup).toContain("Verification code sent to your email address.");
    expect(markup).toContain("Store authorization verification code");
    expect(markup).toContain("Verify and continue to eBay for marz_cards");
    expect(markup).not.toContain("Settings");
  });
});
