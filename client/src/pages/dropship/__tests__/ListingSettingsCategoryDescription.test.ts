import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EbayCategoryOption } from "@shared/dropship/ebay-category-rules";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import type { StoreDefaultEditorFooter } from "@/lib/dropship-listing-settings-content-requests";
import { UnsavedChangesProvider } from "../catalog/UnsavedChangesGuard";
import { DropshipEbayCategoryPicker, EbayCategoryPickerView } from "../DropshipEbayCategoryPicker";
import {
  EbayCategoryDefaultRow,
  EbayCategoryEditorView,
  StaleViewNotice,
  StoreDefaultEditorButtons,
  type EbayCategoryEditorViewProps,
} from "../listing-settings/EbayCategoryDefaultRow";
import { DescriptionDefaultRow, DescriptionEditorView, type DescriptionEditorViewProps } from "../listing-settings/DescriptionDefaultRow";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";

const SLEEVES = { categoryId: "183435", categoryName: "Card Sleeves", path: ["Collectibles", "Trading Cards", "Card Sleeves"] };
const SUPPLIES: EbayCategoryOption = { categoryId: "261328", categoryName: "Card Supplies", path: ["Collectibles", "Card Supplies"], leaf: false };
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const SIGN_IN: ListingSettingsRight = { editable: false, reason: "sign_in" };
const UNDER_BANNER: ListingSettingsRight = { editable: false, reason: "banner" };
const noop = () => undefined;
const callbacks = { onSaveStarted: noop, onSaveSettled: noop };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Node has no browser location, so the router renders from a fixed path. */
function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/setup", children: node }));
}

/** A row inside the providers the step gives it, with a query cache the test can fill and check before it is cleared. */
function renderRow(
  row: React.ReactElement,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  inspect?: (client: QueryClient) => void,
): string {
  try {
    const markup = render(React.createElement(QueryClientProvider, { client },
      React.createElement(UnsavedChangesProvider, null,
        React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: 22, now: () => 1_000, children: row }))));
    inspect?.(client);
    return markup;
  } finally {
    client.clear();
  }
}

/** The read a row registered under a key, as the options it gave React Query (it never fetched). */
function registeredRead(client: QueryClient, endpoint: string) {
  const query = client.getQueryCache().find({ queryKey: [endpoint] });
  if (!query) return null;
  const options = query.options as { enabled?: unknown; staleTime?: unknown; retry?: unknown };
  return { enabled: options.enabled, staleTime: options.staleTime, retry: options.retry };
}

/** A window whose `matchMedia` answers `wide` for every query (the phone layout is below 640 px). */
function stubWidth(wide: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: wide, media: query, addEventListener: noop, removeEventListener: noop }),
  });
}

function pickerProps(overrides: Partial<Parameters<typeof EbayCategoryPickerView>[0]> = {}): Parameters<typeof EbayCategoryPickerView>[0] {
  return {
    label: "eBay category for every product", mode: "search", onModeChange: noop, onCancel: noop,
    search: "sleeves", onSearchChange: noop, searchStatus: "ready", searchError: null,
    searchResults: [{ ...SLEEVES, leaf: true }, SUPPLIES], searchedText: "sleeves",
    onRetrySearch: noop, trail: [], onTrailChange: noop, browseStatus: "idle", browseError: null, browseParent: null, browseChildren: [],
    onRetryBrowse: noop, onPick: noop, onOpen: noop, ...overrides,
  };
}

function categoryRow(saved: ListingSettingsSummary["storeDefaults"]["ebayCategory"] | null, right: ListingSettingsRight = EDITABLE) {
  return React.createElement(EbayCategoryDefaultRow, { storeConnectionId: 22, saved, right, saveCallbacks: callbacks, onSaved: noop });
}

function descriptionRow(saved: ListingSettingsSummary["storeDefaults"]["description"] | null, right: ListingSettingsRight = EDITABLE) {
  return React.createElement(DescriptionDefaultRow, { storeConnectionId: 22, saved, right, saveCallbacks: callbacks, onSaved: noop });
}

function categoryEditor(overrides: Partial<EbayCategoryEditorViewProps> = {}): string {
  return render(React.createElement(EbayCategoryEditorView, {
    read: "ready", onRetryRead: noop, category: null, choice: "card_shellz", locked: false, marked: false, picking: false,
    onChoose: noop, onPickAnother: noop, reason: null, message: null,
    picker: React.createElement("div", { "data-testid": "picker-here" }, "Picker"),
    ...overrides,
  }));
}

function descriptionEditor(overrides: Partial<DescriptionEditorViewProps> = {}): string {
  return render(React.createElement(DescriptionEditorView, {
    read: "ready", onRetryRead: noop, introduction: "Hello", footer: "", onChange: noop, locked: false, marked: [], reason: null, message: null,
    ...overrides,
  }));
}

describe("eBay category picker", () => {
  it("keeps today's words and prints each category's number when no new prop is passed", () => {
    const markup = render(React.createElement(EbayCategoryPickerView, pickerProps()));
    // The old step's exact output: the path, then " · #" and the number.
    expect(markup).toContain('<p class="text-xs text-zinc-500">Collectibles › Trading Cards › Card Sleeves · #183435</p>');
    expect(markup).toContain("#261328");
    expect(markup).not.toContain("Pick the last level.");
    expect(markup).toContain("Use this category");
    expect(markup).toContain("Open");
  });

  it("hides every number with hideIds, and says only the last level can be picked with showLeafHint", () => {
    const hidden = render(React.createElement(EbayCategoryPickerView, pickerProps({ hideIds: true })));
    expect(hidden).not.toContain(" · #");
    expect(hidden).not.toContain("183435");
    expect(hidden).not.toContain("261328");
    expect(hidden).toContain('<p class="text-xs text-zinc-500">Collectibles › Trading Cards › Card Sleeves</p>');
    expect(hidden).not.toContain("Pick the last level.");
    const hinted = render(React.createElement(EbayCategoryPickerView, pickerProps({ showLeafHint: true })));
    expect(hinted).toContain("Pick the last level. eBay only accepts those.");
    expect(hinted).toContain("#183435");
  });

  it("hides numbers in browse results too", () => {
    const markup = render(React.createElement(EbayCategoryPickerView, pickerProps({
      mode: "browse", browseStatus: "ready", browseChildren: [SUPPLIES], hideIds: true,
    })));
    expect(markup).toContain("Card Supplies");
    expect(markup).not.toContain("261328");
  });

  it("passes both props through from the picker that reads eBay", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["dropship-ebay-categories", 22, "search", "sleeves"], [{ ...SLEEVES, leaf: true }]);
    const picker = (props: { hideIds?: boolean; showLeafHint?: boolean }) => render(React.createElement(QueryClientProvider, { client },
      React.createElement(DropshipEbayCategoryPicker, {
        storeConnectionId: 22, label: "eBay category", initialQuery: "sleeves", onPick: noop, onCancel: noop, ...props,
      })));
    const plain = picker({});
    expect(plain).toContain("#183435");
    expect(plain).not.toContain("Pick the last level.");
    const settings = picker({ hideIds: true, showLeafHint: true });
    expect(settings).toContain("Card Sleeves");
    expect(settings).not.toContain("183435");
    expect(settings).toContain("Pick the last level. eBay only accepts those.");
    client.clear();
  });
});

describe("EbayCategoryDefaultRow", () => {
  it("shows Card Shellz picks from the summary, with a named Change and no editor", () => {
    const markup = renderRow(categoryRow({ category: null, groupRules: 0 }));
    expect(markup).toContain('data-testid="store-default-row-ebayCategory"');
    expect(markup).toContain(">eBay category</span>");
    expect(markup).toContain("Card Shellz picks one for each product (recommended)");
    expect(markup).toMatch(/<button[^>]*aria-label="Change eBay category"[^>]*>Change<\/button>/);
    expect(markup).not.toContain('data-testid="editor-surface"');
  });

  it("shows a saved store category by name, never its number", () => {
    const markup = renderRow(categoryRow({ category: { categoryId: "183435", categoryName: "Card Sleeves" }, groupRules: 2 }));
    expect(markup).toContain("Card Sleeves");
    expect(markup).not.toContain("183435");
  });

  it("says Checking… until the summary answers", () => {
    expect(renderRow(categoryRow(null))).toContain("Checking…");
  });

  it("is read-only with the reconnect line while eBay needs a sign-in", () => {
    const markup = renderRow(categoryRow({ category: null, groupRules: 0 }, SIGN_IN));
    expect(markup).toContain("Reconnect eBay to change this.");
    expect(markup).not.toContain("<button");
    const banner = renderRow(categoryRow({ category: null, groupRules: 0 }, UNDER_BANNER));
    expect(banner).not.toContain("<button");
    expect(banner).not.toContain("Reconnect eBay");
  });

  it("reads 'Card Shellz picks' on a phone", () => {
    stubWidth(false);
    const markup = renderRow(categoryRow({ category: null, groupRules: 0 }));
    expect(markup).toMatch(/<span id="[^"]+" class="block[^"]*">Card Shellz picks<\/span>/);
    expect(markup).not.toContain("(recommended)");
    stubWidth(false);
    expect(renderRow(categoryRow({ category: { categoryId: "183435", categoryName: "Card Sleeves" }, groupRules: 0 })))
      .toMatch(/<span id="[^"]+" class="block[^"]*">Card Sleeves<\/span>/);
  });

  it("asks for the saved rules with the read turned off while its editor is closed (D8)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderRow(categoryRow({ category: null, groupRules: 0 }), client, (rendered) => {
      expect(registeredRead(rendered, "/api/dropship/listings/stores/22/ebay-category-rules")).toEqual({ enabled: false, staleTime: 0, retry: false });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("EbayCategoryEditorView", () => {
  it("offers the record's two choices, with Card Shellz picks first and explained", () => {
    const markup = categoryEditor();
    const picks = markup.indexOf("Card Shellz picks one for each product (recommended)");
    const one = markup.indexOf("One eBay category for every product");
    expect(picks).toBeGreaterThan(-1);
    expect(one).toBeGreaterThan(picks);
    expect(markup).toContain("Each product uses the eBay category Card Shellz chose for it.");
    const first = /<input type="radio"[^>]*aria-describedby="([^"]+)"[^>]*checked=""\/><span><span[^>]*>Card Shellz picks one/.exec(markup);
    expect(first).not.toBeNull();
    expect(markup).toContain(`<span id="${first![1]}" class="block text-xs text-zinc-600">Each product uses`);
    // Both choices are one group.
    const names = [...markup.matchAll(/type="radio"[^>]*name="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(names).size).toBe(1);
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup).not.toContain("picker-here");
    expect(markup).not.toContain("Pick an eBay category");
  });

  it("shows the picked category's path, never its number, with Pick another", () => {
    const markup = categoryEditor({ choice: "one", category: SLEEVES });
    expect(markup).toContain("Collectibles › Trading Cards › Card Sleeves");
    expect(markup).not.toContain("183435");
    expect(markup).toContain(">Pick another</button>");
    expect(markup).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span class="text-zinc-900">One eBay category for every product/);
  });

  it("asks for a pick when one category is chosen but none is picked, and shows the picker while picking", () => {
    expect(categoryEditor({ choice: "one" })).toContain(">Pick an eBay category</button>");
    const picking = categoryEditor({ choice: "one", picking: true });
    expect(picking).toContain("picker-here");
    expect(picking).not.toContain("Pick an eBay category");
    // Locked (saving, or not editable): no picker.
    expect(categoryEditor({ choice: "one", picking: true, locked: true })).not.toContain("picker-here");
  });

  it("locks the choices while saving or unconfirmed", () => {
    expect(categoryEditor({ locked: true })).toMatch(/<fieldset disabled=""/);
    expect(categoryEditor()).not.toMatch(/<fieldset disabled=""/);
  });

  it("marks a value another window also changed", () => {
    expect(categoryEditor({ choice: "one", category: SLEEVES, marked: true })).toContain("Also changed in another window");
    expect(categoryEditor({ marked: true })).toContain("Also changed in another window");
    expect(categoryEditor({ choice: "one", category: SLEEVES })).not.toContain("Also changed in another window");
  });

  it("says why it can't be saved, and shows a refusal as an alert", () => {
    const markup = categoryEditor({ reason: "Reconnect eBay to change this.", message: { text: "Pick a final eBay category.", tone: "alert" } });
    expect(markup).toContain("Reconnect eBay to change this.");
    expect(markup).toContain('<p role="alert" class="text-sm text-amber-900">Pick a final eBay category.</p>');
  });

  it("says Checking… while the saved rules load, and offers Try again when they can't", () => {
    expect(categoryEditor({ read: "loading" })).toBe('<p role="status" class="text-sm text-zinc-600">Checking…</p>');
    const failed = categoryEditor({ read: "failed" });
    expect(failed).toContain("Couldn&#x27;t load what&#x27;s saved. Try again.");
    expect(failed).toContain(">Try again</button>");
    expect(failed).not.toContain("type=\"radio\"");
  });
});

describe("DescriptionDefaultRow", () => {
  it("shows the store text from the summary, with a named Change", () => {
    const markup = renderRow(descriptionRow({ hasIntroduction: true, hasFooter: false, groupRules: 0 }));
    expect(markup).toContain('data-testid="store-default-row-description"');
    expect(markup).toContain("Card Shellz text, with your text above");
    expect(markup).toMatch(/<button[^>]*aria-label="Change Description"[^>]*>Change<\/button>/);
    expect(renderRow(descriptionRow({ hasIntroduction: false, hasFooter: false, groupRules: 0 }))).toContain(">Card Shellz text</div>");
    expect(renderRow(descriptionRow({ hasIntroduction: true, hasFooter: true, groupRules: 3 }))).toContain("Card Shellz text, with your text above and below");
    expect(renderRow(descriptionRow(null))).toContain("Checking…");
  });

  it("reads 'Card Shellz text + above' on a phone", () => {
    stubWidth(false);
    expect(renderRow(descriptionRow({ hasIntroduction: true, hasFooter: false, groupRules: 0 })))
      .toMatch(/<span id="[^"]+" class="block[^"]*">Card Shellz text \+ above<\/span>/);
  });

  it("stays editable whenever W4 takes a save, and is read-only with its reason otherwise", () => {
    expect(renderRow(descriptionRow({ hasIntroduction: false, hasFooter: false, groupRules: 0 }))).toContain('aria-label="Change Description"');
    const loading = renderRow(descriptionRow({ hasIntroduction: false, hasFooter: false, groupRules: 0 }, { editable: false, reason: "loading" }));
    expect(loading).not.toContain("<button");
    expect(loading).toContain("Checking…");
  });

  it("asks for the saved profile with the read turned off while its editor is closed (D8)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderRow(descriptionRow({ hasIntroduction: false, hasFooter: false, groupRules: 0 }), undefined, (rendered) => {
      expect(registeredRead(rendered, "/api/dropship/listings/stores/22/content-profile")).toEqual({ enabled: false, staleTime: 0, retry: false });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DescriptionEditorView", () => {
  it("shows Text above, the main text line and Text below in order, each with its counter and the 4,000 limit", () => {
    const markup = descriptionEditor({ introduction: "Hello", footer: "" });
    const above = markup.indexOf("Text above (optional)");
    const main = markup.indexOf("Card Shellz writes the main text for each product.");
    const below = markup.indexOf("Text below (optional)");
    expect(above).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(above);
    expect(below).toBeGreaterThan(main);
    expect(markup).toContain("5 / 4,000");
    expect(markup).toContain("0 / 4,000");
    expect(markup.match(/maxLength="4000"/g)).toHaveLength(2);
    expect(markup).toMatch(/<label for="([^"]+)"[^>]*>Text above \(optional\)<\/label><textarea[^>]*id="\1"/);
    expect(markup).toMatch(/aria-describedby="([^"]+)"[^>]*>Hello<\/textarea><p id="\1"[^>]*>5 \/ 4,000<\/p>/);
  });

  it("locks both texts while saving or unconfirmed", () => {
    expect(descriptionEditor({ locked: true })).toMatch(/<fieldset disabled=""/);
    expect(descriptionEditor()).not.toMatch(/<fieldset disabled=""/);
  });

  it("marks only the text another window also changed", () => {
    const markup = descriptionEditor({ marked: ["footer"] });
    expect(markup.indexOf("Also changed in another window")).toBeGreaterThan(markup.indexOf("Text below (optional)"));
    expect(markup.match(/Also changed in another window/g)).toHaveLength(1);
  });

  it("shows the field words for a refusal and the Load latest line as a status", () => {
    expect(descriptionEditor({ message: { text: "Keep each text to 4,000 characters, with no special characters.", tone: "alert" } }))
      .toContain('<p role="alert" class="text-sm text-amber-900">Keep each text to 4,000 characters, with no special characters.</p>');
    expect(descriptionEditor({ message: { text: "Here's what's saved now.", tone: "status" } }))
      .toContain('<p role="status" class="text-sm text-zinc-700">Here&#x27;s what&#x27;s saved now.</p>');
  });

  it("says Checking… while the profile loads, and offers Try again when it can't", () => {
    expect(descriptionEditor({ read: "loading" })).toContain("Checking…");
    expect(descriptionEditor({ read: "failed" })).toContain(">Try again</button>");
    expect(descriptionEditor({ read: "failed" })).not.toContain("<textarea");
  });
});

describe("editor buttons and the saved-view notice", () => {
  const footer = (primary: StoreDefaultEditorFooter["primary"], cancelDisabled = false): StoreDefaultEditorFooter =>
    ({ primary, cancelDisabled, message: null });

  it("shows Cancel and the main button from the footer model", () => {
    const save = render(React.createElement(StoreDefaultEditorButtons, {
      footer: footer({ label: "Save", action: "save", disabled: true }), onCancel: noop, onPrimary: noop,
    }));
    expect(save).toMatch(/<button[^>]*>Cancel<\/button><button[^>]*disabled=""[^>]*>Save<\/button>/);
    const checking = render(React.createElement(StoreDefaultEditorButtons, {
      footer: footer({ label: "Check again", action: "resend", disabled: false }, true), onCancel: noop, onPrimary: noop,
    }));
    expect(checking).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button><button(?![^>]*disabled="")[^>]*>Check again<\/button>/);
  });

  it("says the save went through but the view is old, with Reload", () => {
    const markup = render(React.createElement(StaleViewNotice, {
      message: "Saved. We couldn't load the latest view.", detail: null, reading: false, onReload: noop,
    }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Saved. We couldn&#x27;t load the latest view.");
    expect(markup).toMatch(/<button[^>]*>Reload<\/button>/);
  });
});
