import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SM_MIN_WIDTH_PX, minWidthQuery, useMinWidth } from "@/hooks/use-min-width";
import { CatalogActionBar } from "../catalog/CatalogActionBar";
import { UnsavedChangesProvider, useLeaveGuard, useUnsavedDrafts } from "../catalog/UnsavedChangesGuard";
import { EditorSurface, type EditorSurfaceProps } from "../listing-settings/EditorSurface";
import { ListingSettingsDraftsProvider, useListingSettingsDrafts } from "../listing-settings/ListingSettingsDraftsProvider";
import { StoreDefaultRow, type StoreDefaultRowProps } from "../listing-settings/StoreDefaultRow";
import { StoreDefaultsCard } from "../listing-settings/StoreDefaultsCard";

/**
 * Radix renders a sheet into a portal, which a static render leaves out. This
 * stand-in renders the sheet in place and shows the props EditorSurface gives it.
 */
vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? createElement("div", { "data-mock": "sheet" }, children) : null),
    SheetContent: ({ side, children, className, "data-testid": testId, "data-surface": surface }: Props) =>
      createElement("div", { "data-mock": "sheet-content", "data-side": side, "data-testid": testId, "data-surface": surface, className }, children),
    SheetHeader: ({ children }: Props) => createElement("div", { "data-mock": "sheet-header" }, children),
    SheetTitle: ({ children }: Props) => createElement("h2", { "data-mock": "sheet-title" }, children),
    SheetDescription: ({ children }: Props) => createElement("p", { "data-mock": "sheet-description" }, children),
  };
});

const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Node has no browser location, so the router renders from a fixed path. */
function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/setup", children: node }));
}

/** A window whose `matchMedia` answers `wide` for every query, and records the queries. */
function stubWidth(wide: boolean): string[] {
  const queries: string[] = [];
  vi.stubGlobal("window", {
    matchMedia: (query: string) => {
      queries.push(query);
      return { matches: wide, media: query, addEventListener: noop, removeEventListener: noop };
    },
  });
  return queries;
}

function surface(overrides: Partial<EditorSurfaceProps> = {}): string {
  return render(React.createElement(EditorSurface, {
    open: true,
    title: "Shipping policy",
    notSaved: true,
    onClose: noop,
    footer: React.createElement("button", { type: "button" }, "Save"),
    children: React.createElement("p", null, "Pick a shipping policy."),
    ...overrides,
  }));
}

function row(overrides: Partial<StoreDefaultRowProps> = {}): string {
  return render(React.createElement(StoreDefaultRow, {
    field: "shipping",
    value: "Free Standard US",
    editable: true,
    onChange: noop,
    compact: false,
    ...overrides,
  }));
}

describe("useMinWidth", () => {
  function Probe() {
    return React.createElement("span", null, String(useMinWidth(SM_MIN_WIDTH_PX)));
  }

  it("answers wide without a window, and follows matchMedia when there is one", () => {
    expect(render(React.createElement(Probe))).toBe("<span>true</span>");
    const queries = stubWidth(false);
    expect(render(React.createElement(Probe))).toBe("<span>false</span>");
    expect(queries).toContain("(min-width: 640px)");
    stubWidth(true);
    expect(render(React.createElement(Probe))).toBe("<span>true</span>");
  });

  it("refuses a width that is not a positive whole number of pixels", () => {
    expect(minWidthQuery(640)).toBe("(min-width: 640px)");
    for (const bad of [0, -640, 640.5, Number.NaN]) expect(() => minWidthQuery(bad)).toThrow(/positive whole number of pixels/);
  });
});

describe("EditorSurface", () => {
  it("opens inline under its row at 640 px and wider, with the title, Not saved, the body and the footer in order", () => {
    stubWidth(true);
    const markup = surface();
    expect(markup).toContain('data-surface="inline"');
    expect(markup).toMatch(/<section[^>]*aria-labelledby="([^"]+)"[^>]*>.*<h4 id="\1"[^>]*>Shipping policy<\/h4>/);
    expect(markup).toContain("Not saved");
    expect(markup).not.toContain('data-mock="sheet"');
    const title = markup.indexOf("Shipping policy");
    const body = markup.indexOf("Pick a shipping policy.");
    const footer = markup.indexOf('data-testid="editor-surface-footer"');
    expect(title).toBeLessThan(body);
    expect(body).toBeLessThan(footer);
    expect(markup.slice(footer)).toContain(">Save</button>");
  });

  it("leaves out Not saved when nothing changed, and renders nothing when closed", () => {
    expect(surface({ notSaved: false })).not.toContain("Not saved");
    expect(surface({ open: false })).toBe("");
  });

  it("opens as a bottom sheet with a sticky footer below 640 px", () => {
    stubWidth(false);
    const markup = surface({ description: "Card Shellz checks each one." });
    expect(markup).toContain('data-mock="sheet"');
    expect(markup).toContain('data-side="bottom"');
    expect(markup).toContain('data-surface="sheet"');
    expect(markup).not.toContain('data-surface="inline"');
    expect(markup).toMatch(/<h2 data-mock="sheet-title">Shipping policy.*Not saved.*<\/h2>/);
    expect(markup).toContain("Card Shellz checks each one.");
    expect(markup).toMatch(/class="sticky bottom-0[^"]*" data-testid="editor-surface-footer"><button type="button">Save<\/button>/);
    expect(surface({ open: false })).toBe("");
  });
});

describe("StoreDefaultRow", () => {
  it("shows an editable row with its name, value, status and a named Change button", () => {
    const markup = row({ status: "✓ Works with Card Shellz shipping" });
    expect(markup).toContain('data-testid="store-default-row-shipping"');
    expect(markup).toContain(">Shipping policy</span>");
    expect(markup).toContain("Free Standard US");
    expect(markup).toMatch(/<div role="status"[^>]*>✓ Works with Card Shellz shipping<\/div>/);
    expect(markup).toMatch(/<button[^>]*aria-label="Change Shipping policy"[^>]*>Change<\/button>/);
    expect(markup).not.toContain("Not saved");
    expect(row({ notSaved: true })).toContain("Not saved");
  });

  it("keeps an empty status region in the page so a later Saved is read out", () => {
    expect(row()).toMatch(/<div role="status" class="[^"]*empty:hidden"><\/div>/);
  });

  it("shows a read-only row's value and reason with no Change", () => {
    const markup = row({ field: "payment", value: "eBay payments", editable: false, reason: "Reconnect eBay to change this." });
    expect(markup).toContain('data-testid="store-default-row-payment"');
    expect(markup).toContain(">Payment policy</span>");
    expect(markup).toContain("eBay payments");
    expect(markup).toContain("Reconnect eBay to change this.");
    expect(markup).not.toContain("<button");
    // A reason is only for a row that can't be changed.
    expect(row({ reason: "Reconnect eBay to change this." })).not.toContain("Reconnect eBay");
  });

  it("uses the record's name for each field unless a label is given", () => {
    const names = { price: "Price", return: "Return policy", ebayCategory: "eBay category", shelf: "Store shelf", description: "Description" } as const;
    for (const [field, name] of Object.entries(names)) {
      expect(row({ field: field as StoreDefaultRowProps["field"] })).toContain(`aria-label="Change ${name}"`);
    }
    expect(row({ label: "Shipping" })).toContain('aria-label="Change Shipping"');
  });

  it("reads 'Shipping · Free Standard ›' on a phone, as one button named for the row", () => {
    const markup = row({ compact: true, compactValue: "Free Standard" });
    expect(markup).toMatch(/<button[^>]*aria-label="Change Shipping policy"[^>]*aria-describedby="([^"]+)"/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
    expect(markup).toContain(`<span id="${describedBy}">Free Standard</span>`);
    expect(markup).toContain('<span class="font-medium text-zinc-900">Shipping</span> · <span');
    expect(markup).toContain('<span aria-hidden="true" class="shrink-0 text-lg leading-5 text-zinc-400">›</span>');
    expect(markup).not.toContain("Free Standard US");
    expect(markup).not.toContain(">Change<");
  });

  it("puts Price, eBay category and Description values on a second line on a phone", () => {
    const markup = row({ field: "price", value: "Retail price + 20%, round up to .99", compactValue: "Retail + 20%, up to .99", compact: true });
    expect(markup).toMatch(/<span class="block text-sm font-medium text-zinc-900">Price<\/span><span id="[^"]+" class="block[^"]*">Retail \+ 20%, up to \.99<\/span>/);
    expect(row({ field: "return", value: "30 days", compact: true })).toContain(">Returns</span> · <span");
    expect(row({ field: "shelf", value: "None", compact: true })).toContain(">Store shelf</span> · <span");
    expect(row({ field: "ebayCategory", value: "Card Shellz picks", compact: true })).toContain('class="block text-sm font-medium text-zinc-900">eBay category</span>');
  });

  it("shows a read-only phone row without the arrow, with its reason", () => {
    const markup = row({ compact: true, editable: false, reason: "Checking eBay…" });
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("›");
    expect(markup).toContain("Checking eBay…");
  });

  it("renders the row's editor under it", () => {
    const markup = row({ children: React.createElement("p", null, "Editor here") });
    expect(markup.indexOf("Free Standard US")).toBeLessThan(markup.indexOf("Editor here"));
  });
});

describe("StoreDefaultsCard", () => {
  it("has its title, intro, rows in the order given, and the fixed footer line", () => {
    const markup = render(React.createElement(StoreDefaultsCard, {
      footer: React.createElement("p", null, "Extra note"),
      children: [
        React.createElement(StoreDefaultRow, { key: "price", field: "price", value: "Not set", editable: true, onChange: noop, compact: false }),
        React.createElement(StoreDefaultRow, { key: "shipping", field: "shipping", value: "Free Standard US", editable: true, onChange: noop, compact: false }),
      ],
    }));
    expect(markup).toMatch(/<section aria-labelledby="([^"]+)" data-testid="store-defaults-card"[^>]*><h3 id="\1"[^>]*>Store defaults<\/h3>/);
    expect(markup).toContain("Every product uses these unless you change it below.");
    expect(markup.indexOf("store-default-row-price")).toBeLessThan(markup.indexOf("store-default-row-shipping"));
    expect(markup.indexOf("Extra note")).toBeLessThan(markup.indexOf("Card Shellz packs and ships every order."));
    expect(markup.trimEnd().endsWith("Card Shellz packs and ships every order.</p></section>")).toBe(true);
  });
});

describe("CatalogActionBar", () => {
  const TODAY = '<div class="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6" data-testid="catalog-action-bar"><div class="flex items-center justify-between gap-3"><p class="min-w-0 text-sm text-zinc-700" data-testid="catalog-action-summary">3 selected</p></div></div>';
  const next = { label: "Next: Publish", href: "/dropship-portal/catalog/publish", disabled: false };

  it("renders today's markup exactly without live", () => {
    expect(render(React.createElement(CatalogActionBar, { summary: "3 selected", next: null }))).toBe(TODAY);
    expect(render(React.createElement(CatalogActionBar, { summary: "3 selected", next: null, live: false }))).toBe(TODAY);
    const linked = render(React.createElement(CatalogActionBar, { summary: "All saved", next }));
    expect(linked).not.toContain("role=");
    expect(linked).not.toContain("aria-live");
  });

  it("announces the summary politely with live, and changes nothing else", () => {
    const live = render(React.createElement(CatalogActionBar, { summary: "Not saved · 1 change in Price", next, live: true }));
    expect(live).toContain('<p class="min-w-0 text-sm text-zinc-700" data-testid="catalog-action-summary" role="status" aria-live="polite">Not saved · 1 change in Price</p>');
    const quiet = render(React.createElement(CatalogActionBar, { summary: "Not saved · 1 change in Price", next }));
    expect(live.replace(' role="status" aria-live="polite"', "")).toBe(quiet);
  });
});

describe("ListingSettingsDraftsProvider", () => {
  function Probe() {
    const drafts = useListingSettingsDrafts();
    return React.createElement("span", null, `${drafts.draft === null ? "no draft" : drafts.draft.editor} · ${drafts.savedFlashVisible} · ${drafts.now()}`);
  }

  it("gives its editors no draft to start with and the injected clock", () => {
    const markup = render(React.createElement(UnsavedChangesProvider, null,
      React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: 22, now: () => 1234, children: React.createElement(Probe) })));
    expect(markup).toBe("<span>no draft · false · 1234</span>");
  });

  it("refuses an editor outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    expect(() => render(React.createElement(Probe))).toThrow(/needs a ListingSettingsDraftsProvider/);
  });
});

describe("leave guard outside its provider", () => {
  it("lists no drafts and lets the vendor leave at once, scoped or not", () => {
    let drafts: readonly unknown[] | null = null;
    let left = 0;
    function Probe() {
      drafts = useUnsavedDrafts();
      const guard = useLeaveGuard();
      guard(() => { left += 1; });
      guard(() => { left += 1; }, ["listing-settings:22"]);
      return null;
    }
    render(React.createElement(Probe));
    expect(drafts).toEqual([]);
    expect(left).toBe(2);
  });
});
