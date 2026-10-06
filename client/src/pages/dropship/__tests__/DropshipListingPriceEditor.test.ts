import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListingPriceSetting } from "@shared/dropship/listing-price";
import { DropshipListingPriceEditor } from "../DropshipListingPriceEditor";

afterEach(() => vi.unstubAllGlobals());
function price(): ListingPriceSetting {
  return { storeConnectionId: 12, productVariantId: 34, revisionId: 9, overridePriceCents: 999, effectivePriceCents: 999,
    defaultPriceCents: 899, source: "override", updatedAt: "2026-09-06T12:00:00.000Z" };
}
function render(value: ListingPriceSetting | null, disabled = false, compact = false, context?: "preview" | "settings"): string {
  vi.stubGlobal("React", React);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  if (value) client.setQueryData(["/api/dropship/listings/stores/12/variants/34/price"], value);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(DropshipListingPriceEditor, {
      storeConnectionId: 12, productVariantId: 34, disabled, compact, context, onCancel: compact ? () => {} : undefined,
      onSaveStarted: () => {}, onSaveSettled: () => {}, onSaved: async () => {},
    })));
  } finally { client.clear(); }
}

describe("listing price editor presentation", () => {
  it("reuses the saved-price form in a compact inline layout with explicit Save, Cancel, and default reset", () => {
    const markup = render(price(), false, true);
    expect(markup).toContain("Saved $9.99");
    expect(markup).toContain("Default $8.99");
    expect(markup).toContain("Save listing price");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Use catalog default");
    expect(markup).toContain('value="9.99"');
    expect(markup).toContain("it does not publish");
    expect(markup).not.toContain("Current saved price</dt>");
  });
  it("lets an inline edit close without waiting for a price lookup", () => {
    const markup = render(null, false, true);
    expect(markup).toContain("Loading saved price");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain("Save listing price");
  });
  it("has a labeled exact-decimal editor and explicit save action beside current/default prices", () => {
    const markup = render(price());
    expect(markup).toContain("Your listing price (USD)");
    expect(markup).toContain('inputMode="decimal"');
    expect(markup).toContain('value="9.99"');
    expect(markup).toContain("$9.99");
    expect(markup).toContain("$8.99");
    expect(markup).toContain("Save listing price");
    expect(markup).toContain("Exact price");
    expect(markup).toContain("Saving refreshes this preview. Saved settings go to eBay the next time a listing is sent: when you publish it, or when Card Shellz updates it.");
    expect(markup).not.toContain("does not publish or modify a live eBay listing");
    expect(markup).not.toContain("Suggested price");
  });
  it("exposes a saved default without fabricating an override", () => {
    const markup = render({ ...price(), overridePriceCents: null, effectivePriceCents: 899, source: "catalog_default" });
    expect(markup).toContain("Use catalog default (no price override)");
    expect(markup).toContain("checked");
    expect(markup).toContain('value="8.99"');
    expect(markup).not.toContain("Unsaved price change");
  });
  it("shows legacy retained prices without falsely claiming catalog inheritance", () => {
    const markup = render({ ...price(), revisionId: null, overridePriceCents: null, source: "saved_listing", updatedAt: null });
    expect(markup).toContain("Price last sent to eBay");
    expect(markup).not.toContain("checked");
    expect(markup).not.toContain("Unsaved price change");
  });
  it("shows the .ops cost, and says when it is not known instead of showing $0.00", () => {
    expect(render({ ...price(), productCostCents: 1089 })).toContain("$10.89");
    const unknown = render({ ...price(), productCostCents: null });
    expect(unknown).toContain("Your .ops cost");
    expect(unknown).toContain("Not known");
  });
  it("notes a typed price below the .ops cost", () => {
    expect(render({ ...price(), productCostCents: 1089 })).toContain("This is below your .ops cost of $10.89.");
    expect(render({ ...price(), productCostCents: 999 })).not.toContain("below your .ops cost");
  });
  it("in Listing settings, says when a saved price reaches eBay and mentions no preview", () => {
    const markup = render(price(), false, false, "settings");
    expect(markup).toContain("Nothing changes until you save. Saved settings go to eBay the next time a listing is sent: when you publish it, or when Card Shellz updates it.");
    expect(markup).not.toContain("preview");
  });
  it("does not turn missing data into a zero price", () => {
    const markup = render({ ...price(), overridePriceCents: null, effectivePriceCents: null, defaultPriceCents: null, source: "unavailable" });
    expect(markup).toContain("Unavailable");
    expect(markup).toContain('value=""');
    expect(markup).not.toContain("$0.00");
  });
  it("shows a loading state before a saved value is loaded", () => {
    const markup = render(null);
    expect(markup).toContain("Loading saved price");
    expect(markup).not.toContain("Save listing price");
  });
  it("disables price editing when a parent publication action is pending", () => {
    const markup = render(price(), true);
    const inputs = markup.match(/<input[^>]+>/g) ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.includes("disabled"))).toBe(true);
  });
});
