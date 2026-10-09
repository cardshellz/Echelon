import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogStoreOption } from "@/lib/dropship-catalog-steps";
import { CatalogStepRail, type CatalogStepRailProps } from "../catalog/CatalogStepRail";
import { CatalogActionBar } from "../catalog/CatalogActionBar";

const noop = () => undefined;
const EBAY: CatalogStoreOption = { storeConnectionId: 5, name: "Marz Cards", platform: "ebay", selectable: true };
const SHOPIFY: CatalogStoreOption = { storeConnectionId: 3, name: "Test Shop", platform: "shopify", selectable: false };

afterEach(() => { vi.unstubAllGlobals(); });

/** Node has no browser location, so the router renders from a fixed path. */
function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/setup", children: node }));
}

function rail(overrides: Partial<CatalogStepRailProps> = {}): string {
  return render(React.createElement(CatalogStepRail, {
    current: "setup",
    hrefFor: (step) => `/dropship-portal/catalog/${step}`,
    ticks: { choose: "done", setup: "todo", publish: null },
    details: { choose: "3 selected", setup: "Needs setup" },
    storeOptions: [EBAY, SHOPIFY],
    selectedStoreConnectionId: 5,
    onStoreChange: noop,
    ...overrides,
  }));
}

describe("catalog step rail", () => {
  it("links the three steps in order and marks the one on screen", () => {
    const markup = rail();
    const choose = markup.indexOf('href="/dropship-portal/catalog/choose"');
    const setup = markup.indexOf('href="/dropship-portal/catalog/setup"');
    const publish = markup.indexOf('href="/dropship-portal/catalog/publish"');
    expect(choose).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(choose);
    expect(publish).toBeGreaterThan(setup);
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-current="step"[^>]*data-testid="catalog-step-setup"/);
    expect(markup).toContain("1 · Choose what to sell");
    expect(markup).toContain("2 · Listing settings");
    expect(markup).toContain("3 · Publish");
    // Status appears with its own page (design PR 10); the rail never links to an empty one.
    expect(markup).not.toContain("Status");
  });

  it("says each tick in words and shows each step's line", () => {
    const markup = rail({ ticks: { choose: "done", setup: "unknown", publish: null }, details: { choose: "3 selected", setup: "Checking" } });
    expect(markup).toContain('<span class="sr-only">, done</span>');
    expect(markup).toContain('<span class="sr-only">, not known yet</span>');
    // Publish has no tick until publish runs exist, so nothing is claimed for it.
    expect(markup.match(/class="sr-only"/g)).toHaveLength(2);
    expect(markup).toContain("3 selected");
    expect(markup).toContain("Checking");
    expect(rail({ ticks: { choose: "todo", setup: "done", publish: null } })).toContain('<span class="sr-only">, not done yet</span>');
  });

  it("offers a step's action as its own button after the step's link, never inside it", () => {
    const markup = rail({ details: { choose: "3 selected", setup: "Couldn't check" },
      actions: { setup: { label: "Try again", onClick: noop } } });
    const link = markup.indexOf('data-testid="catalog-step-setup"');
    const linkEnd = markup.indexOf("</a>", link);
    const action = markup.indexOf('data-testid="catalog-step-setup-action"');
    expect(action).toBeGreaterThan(linkEnd);
    expect(markup).toMatch(/<button type="button"[^>]*data-testid="catalog-step-setup-action"[^>]*>Try again<\/button>/);
    expect(rail()).not.toContain("catalog-step-setup-action");
  });

  it("offers the store choice when an eBay store is ready", () => {
    const markup = rail();
    expect(markup).toContain('data-testid="catalog-store-select"');
    expect(markup).toContain('aria-labelledby="catalog-store-label"');
    expect(markup).not.toContain("No eBay store ready");
  });

  it("says no eBay store is ready, and names the stores that are not supported, instead of offering a choice", () => {
    const markup = rail({ storeOptions: [SHOPIFY], selectedStoreConnectionId: null });
    expect(markup).not.toContain('data-testid="catalog-store-select"');
    expect(markup).toContain("No eBay store ready.");
    expect(markup).toContain("Test Shop (Shopify): not supported yet.");
    const none = rail({ storeOptions: [], selectedStoreConnectionId: null });
    expect(none).toContain("No eBay store ready.");
    expect(none).not.toContain("not supported yet");
  });
});

describe("catalog action bar", () => {
  it("links to the next step", () => {
    const markup = render(React.createElement(CatalogActionBar, {
      summary: "3 selected",
      next: { label: "Next: Listing settings", href: "/dropship-portal/catalog/setup", disabled: false },
    }));
    expect(markup).toContain("3 selected");
    expect(markup).toMatch(/<a [^>]*href="\/dropship-portal\/catalog\/setup"[^>]*>Next: Listing settings/);
  });

  it("disables the way forward without linking anywhere, and can offer none", () => {
    const disabled = render(React.createElement(CatalogActionBar, {
      summary: "0 selected",
      next: { label: "Next: Listing settings", href: "/dropship-portal/catalog/setup", disabled: true },
    }));
    expect(disabled).toMatch(/<button[^>]* disabled=""[^>]*>Next: Listing settings/);
    expect(disabled).not.toContain("href=");
    const none = render(React.createElement(CatalogActionBar, { summary: "3 selected · publishing to Marz Cards", next: null }));
    expect(none).toContain("3 selected · publishing to Marz Cards");
    expect(none).not.toContain("<button");
    expect(none).not.toContain("<a ");
  });
});

describe("catalog page steps", () => {
  const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
  const app = readFileSync(join(process.cwd(), "client/src/App.tsx"), "utf8");

  function stepBlock(step: string, nextMarker: string): string {
    const start = source.indexOf(`{activeStep === "${step}" && (`);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf(nextMarker, start));
  }

  it("serves every step from one route so the vendor's work survives moving between steps", () => {
    expect(app).toContain("<Route path={`${portalRoot}/catalog/:step?`}>");
    expect(app).not.toContain("<Route path={`${portalRoot}/catalog`}>");
    // A bare /catalog or an unknown step goes to Choose, replacing the address instead of adding to history.
    expect(source).toContain("if (step !== null || !isCatalogLocation(location)) return;");
    expect(source).toContain('navigate(`${dropshipPortalPath(catalogStepPath("choose"))}${window.location.search}`, { replace: true });');
  });

  it("mounts the existing sections under their steps", () => {
    const choose = stepBlock("choose", '{activeStep === "setup" && (');
    const setup = stepBlock("setup", '{activeStep === "publish" && (');
    const publish = stepBlock("publish", "<CatalogActionBar");
    expect(choose).toContain("<CatalogFilterPanel");
    expect(choose).toContain("<CatalogTable");
    for (const panel of ["<EbayListingSetupPanel", "<EbayListingPolicyOverridePanel", "<DropshipEbayCategoryRulesPanel",
      "<EbayStoreCategoryAssignmentPanel", "<DropshipPricingRulesPanel", "<DropshipContentTemplatesPanel"]) {
      expect(setup).toContain(panel);
      expect(choose).not.toContain(panel);
      expect(publish).not.toContain(panel);
    }
    expect(publish).toContain("<ListingPreviewPanel");
    expect(choose).not.toContain("<ListingPreviewPanel");
    expect(setup).not.toContain("<ListingPreviewPanel");
  });

  it("chooses the store in the rail only, and asks eBay for store categories only on the step that shows them", () => {
    expect(source.match(/<SelectTrigger/g)?.length ?? 0).toBe(source.match(/function FilterSelect/g)?.length ?? 0);
    expect(source).toContain('enabled: selectedStoreConnection?.platform === "ebay" && activeStep === "setup",');
    expect(source).toContain("rememberCatalogStore(catalogBrowserStorage(), memberId, storeConnectionId);");
  });
});
