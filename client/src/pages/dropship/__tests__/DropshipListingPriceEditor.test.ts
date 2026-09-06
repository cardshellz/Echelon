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
function render(value: ListingPriceSetting | null, disabled = false): string {
  vi.stubGlobal("React", React);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  if (value) client.setQueryData(["/api/dropship/listings/stores/12/variants/34/price"], value);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(DropshipListingPriceEditor, {
      storeConnectionId: 12, productVariantId: 34, disabled, onSaveStarted: () => {}, onSaveSettled: () => {}, onSaved: async () => {},
    })));
  } finally { client.clear(); }
}

describe("listing price editor presentation", () => {
  it("has a labeled exact-decimal editor and explicit save action beside current/default prices", () => {
    const markup = render(price());
    expect(markup).toContain("Your listing price (USD)");
    expect(markup).toContain('inputMode="decimal"');
    expect(markup).toContain('value="9.99"');
    expect(markup).toContain("$9.99");
    expect(markup).toContain("$8.99");
    expect(markup).toContain("Save listing price");
    expect(markup).toContain("Listing override");
    expect(markup).toContain("does not publish or modify a live eBay listing");
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
    expect(markup).toContain("Previously saved listing");
    expect(markup).not.toContain("checked");
    expect(markup).not.toContain("Unsaved price change");
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
