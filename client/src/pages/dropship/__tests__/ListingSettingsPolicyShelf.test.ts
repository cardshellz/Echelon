import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayStoreCategoryCombobox } from "@/components/dropship/EbayStoreCategoryCombobox";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import type { ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import {
  DropshipApiError,
  type DropshipEbayFulfillmentPolicyOption,
  type DropshipEbayListingSetupResponse,
  type DropshipEbayStoreCategoryOption,
  type DropshipEbayStoreCategoryResponse,
} from "@/lib/dropship-ops-surface";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { PolicyDefaultRow, type ListingSetupRead, type PolicyDefaultRowProps } from "../listing-settings/PolicyDefaultRow";
import { ShelfDefaultRow, type ShelfDefaultRowProps, type StoreShelvesRead } from "../listing-settings/ShelfDefaultRow";
import { ShipFromRepairNote, type ShipFromRepairNoteProps } from "../listing-settings/ShipFromRepairNote";

/** The step's one draft, as each test sets it (the real provider has no way to start with a draft in a static render). */
const state = vi.hoisted(() => ({ drafts: null as unknown }));

vi.mock("../listing-settings/ListingSettingsDraftsProvider", () => ({
  useListingSettingsDrafts: () => state.drafts,
}));

/** A popover renders into a portal, which a static render leaves out: render it in place, open. */
vi.mock("@/components/ui/popover", async () => {
  const { createElement, Fragment } = await vi.importActual<typeof import("react")>("react");
  type Props = { children?: React.ReactNode };
  return {
    Popover: ({ children }: Props) => createElement(Fragment, null, children),
    PopoverTrigger: ({ children }: Props) => createElement(Fragment, null, children),
    PopoverAnchor: ({ children }: Props) => createElement(Fragment, null, children),
    PopoverContent: ({ children }: Props) => createElement("div", { "data-mock": "popover-content" }, children),
  };
});

/** The command list as plain elements, so every choice is in the markup. */
vi.mock("@/components/ui/command", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  const plain = (tag: string, mock: string) => ({ children }: Props) => createElement(tag, { "data-mock": mock }, children);
  return {
    Command: plain("div", "command"),
    CommandList: plain("div", "command-list"),
    CommandEmpty: plain("div", "command-empty"),
    CommandGroup: plain("div", "command-group"),
    CommandItem: ({ children }: Props) => createElement("div", { role: "option" }, children),
    CommandInput: ({ placeholder, "aria-label": label }: Props) => createElement("input", { placeholder, "aria-label": label }),
  };
});

vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? createElement("div", { "data-mock": "sheet" }, children) : null),
    SheetContent: ({ side, children, "data-surface": surface }: Props) => createElement("div", { "data-side": side, "data-surface": surface }, children),
    SheetHeader: ({ children }: Props) => createElement("div", null, children),
    SheetTitle: ({ children }: Props) => createElement("h2", null, children),
    SheetDescription: ({ children }: Props) => createElement("p", null, children),
  };
});

const noop = () => undefined;
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };

/** Type check only: the step passes its React Query results to the rows as they are. */
export function setupReadFromQuery(query: UseQueryResult<DropshipEbayListingSetupResponse>): ListingSetupRead {
  return query;
}
export function shelvesReadFromQuery(query: UseQueryResult<DropshipEbayStoreCategoryResponse>): StoreShelvesRead {
  return query;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: new QueryClient() }, node));
}

function stubPhone(): void {
  vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener: noop, removeEventListener: noop }) });
}

function drafts(draft: ListingSettingsDraft | null = null, savedFlashVisible = false): ListingSettingsDraftsValue {
  const value: ListingSettingsDraftsValue = {
    draft,
    savedFlashVisible,
    now: () => 0,
    open: vi.fn(() => true),
    edit: vi.fn(),
    startSave: vi.fn(() => null),
    settle: vi.fn(),
    rebase: vi.fn(),
    discard: vi.fn(),
    close: vi.fn(),
    requestClose: vi.fn(),
  };
  state.drafts = value;
  return value;
}

function draft(overrides: Partial<ListingSettingsDraft>): ListingSettingsDraft {
  return {
    editor: "shipping",
    place: "Shipping policy",
    base: {},
    value: {},
    changes: 0,
    marked: [],
    open: true,
    phase: "editing",
    message: null,
    code: null,
    attempt: null,
    savedAtMs: null,
    ...overrides,
  };
}

function fulfillment(id: string, name: string, overrides: Partial<DropshipEbayFulfillmentPolicyOption> = {}): DropshipEbayFulfillmentPolicyOption {
  return { id, name, compatible: true, compatibilityChecked: true, compatibilityIssues: [], ...overrides };
}

const TOO_SHORT = { compatible: false, compatibilityIssues: [{ code: "handling_time_too_short", message: "x" }] };

function setup(overrides: Partial<DropshipEbayListingSetupResponse> = {}): DropshipEbayListingSetupResponse {
  return {
    storeConnectionId: 22,
    marketplaceId: "EBAY_US",
    complete: true,
    missingFields: [],
    fulfillmentCapability: {
      marketplaceId: "EBAY_US",
      requiredHandlingTimeBusinessDays: 2,
      destinationCountry: "US",
      destinationRegions: ["US"],
      destinationCoverageComplete: true,
      supportedServices: [{ carrier: "USPS", ebayServiceCode: "USPSGround", serviceName: "USPS Ground Advantage", shipStationCarrierCode: "s", shipStationServiceCode: "g" }],
      evidenceHash: "h",
      source: { omsChannelId: 1, originWarehouseId: 1, rateBookId: 1, rateBookCode: "R", rateTableId: 1, serviceLevelId: 1, fulfillmentRoutingRevision: 1 },
    },
    selection: { merchantLocationKey: "cs", fulfillmentPolicyId: "pol-ship-1", returnPolicyId: "pol-ret-1", paymentPolicyId: "pol-pay-1" },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [fulfillment("pol-ship-1", "Free Standard US"), fulfillment("pol-ship-2", "Economy, 1 day handling", TOO_SHORT)],
      returnPolicies: [{ id: "pol-ret-1", name: "30 days, buyer pays" }, { id: "pol-ret-2", name: "No returns" }],
      paymentPolicies: [{ id: "pol-pay-1", name: "eBay payments" }],
    },
    revision: 7,
    access: { canEdit: true, reason: null },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    storedNames: { fulfillmentPolicyName: "Free Standard US", returnPolicyName: "30 days, buyer pays", paymentPolicyName: "eBay payments" },
    storeShelfDefault: null,
    ...overrides,
  };
}

const NOTHING_SAVED = { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null };

function read(data?: DropshipEbayListingSetupResponse, error: unknown = null): ListingSetupRead {
  return { data, error, isFetching: false, refetch: vi.fn(async () => ({ data, error })) };
}

function policyRow(overrides: Partial<PolicyDefaultRowProps> = {}): string {
  return render(React.createElement(PolicyDefaultRow, {
    kind: "shipping",
    setup: read(setup()),
    savedPolicyId: "pol-ship-1",
    right: EDITABLE,
    onSaved: noop,
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
    ...overrides,
  }));
}

function count(markup: string, text: string): number {
  return markup.split(text).length - 1;
}

describe("PolicyDefaultRow, closed", () => {
  it("shows the saved shipping policy by name, that it works with Card Shellz shipping, and Change", () => {
    drafts();
    const markup = policyRow();
    expect(markup).toContain('data-testid="store-default-row-shipping"');
    expect(markup).toContain("Free Standard US");
    expect(markup).toMatch(/<div role="status"[^>]*>✓ Works with Card Shellz shipping<\/div>/);
    expect(markup).toMatch(/<button[^>]*aria-label="Change Shipping policy"[^>]*>Change<\/button>/);
    expect(markup).not.toContain('data-testid="editor-surface"');
    expect(markup).not.toContain("pol-ship-1");
  });

  it("says Not set · Needed to list when nothing is saved, and Checking eBay… (once) while the read loads", () => {
    drafts();
    expect(policyRow({ kind: "return", savedPolicyId: null, setup: read(), right: { editable: false, reason: "checking_ebay" } }))
      .toContain("Not set · Needed to list");
    const loading = policyRow({ kind: "return", savedPolicyId: "pol-ret-1", setup: read(), right: { editable: false, reason: "checking_ebay" } });
    expect(count(loading, "Checking eBay…")).toBe(1);
    expect(loading).not.toContain("<button");
  });

  it("is read-only with the sign-in reason while eBay needs a sign-in", () => {
    drafts();
    const signIn = new DropshipApiError({ status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", message: "x" });
    const markup = policyRow({ kind: "payment", setup: read(undefined, signIn), right: { editable: false, reason: "sign_in" } });
    expect(markup).toContain(">Set<");
    expect(markup).toContain("Reconnect eBay to change this.");
    expect(markup).not.toContain("<button");
  });

  it("marks a saved policy that no longer fits in red, with Choose another", () => {
    drafts();
    const markup = policyRow({ setup: read(setup({ selection: { ...setup().selection, fulfillmentPolicyId: "pol-ship-2" } })), savedPolicyId: "pol-ship-2" });
    expect(markup).toContain('data-testid="store-default-problem-shipping"');
    expect(markup).toContain("Your shipping policy “Economy, 1 day handling” changed on eBay and no longer works with Card Shellz shipping: handling time must be 2 business days or more.");
    expect(markup).toContain(">Choose another</button>");
    expect(markup).not.toContain("✓ Works with Card Shellz shipping");
  });

  it("says a saved policy is no longer on eBay, by its stored name", () => {
    drafts();
    const gone = setup({ selection: { ...setup().selection, returnPolicyId: "pol-gone" }, storedNames: { fulfillmentPolicyName: null, returnPolicyName: "Old returns", paymentPolicyName: null } });
    const markup = policyRow({ kind: "return", setup: read(gone), savedPolicyId: "pol-gone" });
    expect(markup).toContain("Your return policy “Old returns” is no longer on eBay.");
    // Read-only rows offer no way to choose.
    expect(policyRow({ kind: "return", setup: read(gone), savedPolicyId: "pol-gone", right: { editable: false, reason: "banner" } }))
      .not.toContain("Choose another");
  });

  it("explains unfinished Card Shellz shipping setup with a reference under Details", () => {
    drafts();
    const unfinished = setup({ fulfillmentCapability: null, checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "R-48213", kind: "setup_incomplete" } } });
    const markup = policyRow({ setup: read(unfinished), right: { editable: false, reason: "shipping_setup" } });
    expect(markup).toContain("Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it&#x27;s done.");
    expect(markup).toMatch(/<details[^>]*><summary[^>]*>Details<\/summary><p[^>]*>Reference R-48213<\/p><\/details>/);
  });

  it("shows Saved for 3 seconds after a save, and the stale-view words with Reload", () => {
    drafts(draft({ open: false, phase: "saved", savedAtMs: 0, base: { policyId: "pol-ship-1" }, value: { policyId: "pol-ship-1" } }), true);
    expect(policyRow()).toMatch(/<div role="status"[^>]*><span class="text-emerald-800">Saved<\/span><\/div>/);
    drafts(draft({ open: false, phase: "saved_view_stale", message: "Saved. We couldn't load the latest view." }));
    const stale = policyRow();
    expect(stale).toContain("Saved. We couldn&#x27;t load the latest view.");
    expect(stale).toContain(">Reload</button>");
  });

  it("reads 'Shipping · <name> ›' on a phone", () => {
    drafts();
    stubPhone();
    const markup = policyRow();
    expect(markup).toContain('<span class="font-medium text-zinc-900">Shipping</span> · <span');
    expect(markup).toContain(">Free Standard US</span>");
    expect(markup).toContain("›");
  });
});

describe("PolicyDefaultRow, editing", () => {
  it("lists eBay's shipping policies as radios with no ids, each with whether it works", () => {
    drafts(draft({ base: { policyId: "pol-ship-1" }, value: { policyId: "pol-ship-1" } }));
    const markup = policyRow();
    expect(markup).toContain('data-surface="inline"');
    expect(count(markup, 'type="radio"')).toBe(2);
    expect(markup).not.toMatch(/pol-ship-\d/);
    expect(markup).toContain("✓ Works with Card Shellz shipping");
    expect(markup).toContain("✗ Can&#x27;t use: handling time must be 2 business days or more");
    // The policy Card Shellz can't use can't be picked.
    expect(markup).toMatch(/<input type="radio"[^>]*disabled=""[^>]*\/><span class="min-w-0"><span[^>]*>Economy, 1 day handling/);
    expect(markup).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span class="min-w-0"><span[^>]*>Free Standard US/);
    expect(markup).toContain("What your shipping policy needs ›");
    expect(markup).toContain("use only these services: USPS Ground Advantage");
    expect(markup).toContain("Don&#x27;t see the one you want? Make it in eBay Seller Hub, then check again.");
    expect(markup).toContain('href="https://www.ebay.com/sh/sell-preferences/business-policies" target="_blank" rel="noopener noreferrer"');
    expect(markup).toContain("Open eBay Seller Hub ↗");
    expect(markup).toContain(">Check eBay again</button>");
    // Nothing changed: Save is off.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(markup).not.toContain("Not saved");
  });

  it("turns Save on for a changed pick, and shows Not saved", () => {
    drafts(draft({ editor: "return", place: "Return policy", base: { policyId: "pol-ret-1" }, value: { policyId: "pol-ret-2" }, changes: 1 }));
    const markup = policyRow({ kind: "return", savedPolicyId: "pol-ret-1" });
    expect(markup).toContain("Not saved");
    expect(markup).toMatch(/<button[^>]*>Save<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    // Return policies have no Card Shellz check.
    expect(markup).not.toContain("Works with Card Shellz shipping");
    expect(markup).not.toContain("What your shipping policy needs");
  });

  it("keeps Save off while the page's counter is off or the setup is being read again", () => {
    drafts(draft({ editor: "return", place: "Return policy", base: { policyId: "pol-ret-1" }, value: { policyId: "pol-ret-2" }, changes: 1 }));
    expect(policyRow({ kind: "return", saveCallbacks: { disabled: true, onSaveStarted: noop, onSaveSettled: noop } }))
      .toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(policyRow({ kind: "return", setup: { ...read(setup()), isFetching: true } }))
      .toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it("shows the lone usable policy as Suggested · not saved only inside the open editor (C18)", () => {
    const lone = setup({
      selection: NOTHING_SAVED,
      options: { ...setup().options, fulfillmentPolicies: [fulfillment("pol-ship-1", "Free Standard US")] },
    });
    drafts();
    const closed = policyRow({ setup: read(lone), savedPolicyId: null });
    expect(closed).toContain("Not set · Needed to list");
    expect(closed).not.toContain("Suggested");
    expect(closed).not.toContain("Not saved");

    drafts(draft({ base: { policyId: null }, value: { policyId: "pol-ship-1" }, changes: 1 }));
    const open = policyRow({ setup: read(lone), savedPolicyId: null });
    expect(open).toContain("Suggested · not saved");
    expect(open).toContain("Not saved");
    expect(open).not.toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it("says when eBay has no policy of a kind", () => {
    drafts(draft({ editor: "return", place: "Return policy", base: { policyId: null }, value: { policyId: null } }));
    const none = setup({ selection: NOTHING_SAVED, options: { ...setup().options, returnPolicies: [] } });
    const markup = policyRow({ kind: "return", setup: read(none), savedPolicyId: null });
    expect(markup).toContain("You don&#x27;t have a return policy on eBay yet. Make one in eBay Seller Hub, then check again.");
    expect(markup).toContain("Open eBay Seller Hub ↗");
    expect(markup).toContain(">Check eBay again</button>");
    expect(markup).not.toContain('type="radio"');
  });

  it("says when none of the shipping policies fits, with what a policy needs", () => {
    drafts(draft({ base: { policyId: null }, value: { policyId: null } }));
    const noneFits = setup({
      selection: NOTHING_SAVED,
      options: { ...setup().options, fulfillmentPolicies: [fulfillment("pol-ship-2", "Economy, 1 day handling", TOO_SHORT)] },
    });
    const markup = policyRow({ setup: read(noneFits), savedPolicyId: null });
    expect(markup).toContain("None of your eBay shipping policies work with Card Shellz shipping.");
    expect(markup).toContain("Card Shellz ships your orders, so your eBay shipping policy must:");
    expect(markup).toContain("have a handling time of 2 business days or more");
    expect(markup).toContain("You decide what buyers pay for shipping.");
    expect(markup).not.toContain("Don&#x27;t see the one you want?");
  });

  it("locks the editor after a save nobody could confirm, with Check again in place of Save", () => {
    drafts(draft({
      base: { policyId: "pol-ship-1" },
      value: { policyId: "pol-ship-1" },
      phase: "uncertain",
      message: "We couldn't confirm your save.",
      attempt: { signature: "{}", key: "ls-policy:abc12345" },
    }));
    const markup = policyRow();
    expect(markup).toContain("We couldn&#x27;t confirm your save.");
    expect(markup).toMatch(/<button[^>]*>Check again<\/button>/);
    expect(markup).not.toMatch(/>Save<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(markup).toMatch(/<fieldset disabled=""/);
  });

  it("offers Load latest after a conflict, and shows Saving… while saving", () => {
    drafts(draft({ base: { policyId: "pol-ship-1" }, value: { policyId: "pol-ship-1" }, phase: "conflict", message: "This changed in another window." }));
    expect(policyRow()).toContain(">Load latest and keep my changes</button>");
    drafts(draft({ base: { policyId: "pol-ship-1" }, value: { policyId: "pol-ship-1" }, phase: "saving" }));
    expect(policyRow()).toMatch(/<button[^>]*disabled=""[^>]*>Saving…<\/button>/);
  });

  it("opens as a bottom sheet on a phone", () => {
    stubPhone();
    drafts(draft({ base: { policyId: "pol-ship-1" }, value: { policyId: "pol-ship-1" } }));
    const markup = policyRow();
    expect(markup).toContain('data-side="bottom"');
    expect(markup).toContain('data-surface="sheet"');
  });
});

const SHELVES: DropshipEbayStoreCategoryOption[] = [
  { categoryId: "shelf-11", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
  { categoryId: "shelf-12", categoryName: "Penny Sleeves", path: "Supplies:Penny Sleeves", level: 2 },
];

function shelves(categories: DropshipEbayStoreCategoryOption[] | undefined = SHELVES, error: unknown = null): StoreShelvesRead {
  return { data: categories === undefined ? undefined : { categories }, error, isFetching: false, refetch: vi.fn(async () => undefined) };
}

function shelfRow(overrides: Partial<ShelfDefaultRowProps> = {}): string {
  return render(React.createElement(ShelfDefaultRow, {
    setup: read(setup()),
    shelves: shelves(),
    rightPick: EDITABLE,
    rightNone: EDITABLE,
    onSaved: noop,
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
    ...overrides,
  }));
}

describe("ShelfDefaultRow", () => {
  it("reads None, or the saved shelves by path, first then second", () => {
    drafts();
    const none = shelfRow();
    expect(none).toContain('data-testid="store-default-row-shelf"');
    expect(none).toContain(">None</div>");
    expect(none).toContain('aria-label="Change Store shelf"');
    const two = shelfRow({ setup: read(setup({ storeShelfDefault: { ids: ["shelf-11", "shelf-12"], names: ["Supplies:Toploaders", "Supplies:Penny Sleeves"] } })) });
    expect(two).toContain("Supplies › Toploaders · second: Supplies › Penny Sleeves");
    expect(two).not.toContain("shelf-11");
  });

  it("marks a saved shelf eBay no longer lists", () => {
    drafts();
    const markup = shelfRow({ setup: read(setup({ storeShelfDefault: { ids: ["shelf-99"], names: ["Old:Boxes"] } })) });
    expect(markup).toContain("Old › Boxes (no longer in your eBay store)");
  });

  it("says shelves are optional when the store has none, with no button", () => {
    drafts();
    const markup = shelfRow({ shelves: shelves([]) });
    expect(markup).toContain("Your eBay store has no shelves. That&#x27;s fine: shelves are optional.");
    expect(markup).not.toContain("<button");
  });

  it("says Checking eBay… while the setup loads, and can't-check words when it failed", () => {
    drafts();
    const loading = shelfRow({ setup: read(), rightPick: { editable: false, reason: "checking_ebay" }, rightNone: { editable: false, reason: "checking_ebay" } });
    expect(count(loading, "Checking eBay…")).toBe(1);
    const failed = shelfRow({ setup: read(undefined, new Error("x")), rightPick: { editable: false, reason: "unreachable" }, rightNone: { editable: false, reason: "unreachable" } });
    expect(count(failed, "Can&#x27;t check eBay right now")).toBe(1);
    expect(failed).not.toContain("<button");
  });

  it("edits a first and an optional second shelf, picked independently, with no ids shown", () => {
    drafts(draft({ editor: "shelf", place: "Store shelf", base: { first: null, second: null }, value: { first: null, second: null } }));
    const markup = shelfRow();
    expect(markup).toContain("Shelves are the categories in your own eBay store. Optional.");
    expect(markup).toContain(">Shelf</label>");
    expect(markup).toContain(">Second shelf (optional)</label>");
    expect(markup).toContain("Pick a first shelf first");
    expect(markup).toContain("Changing the first shelf never changes the second one.");
    expect(markup).toContain("Supplies › Toploaders");
    expect(markup).toContain('placeholder="Search your shelves"');
    expect(markup).not.toContain("Store category");
    expect(markup).not.toContain("shelf-11");
    // The second picker waits for a first shelf.
    expect(markup).toMatch(/aria-label="Second shelf \(optional\)"[^>]*disabled=""/);
    expect(markup).not.toMatch(/aria-label="Shelf"[^>]*disabled=""/);
  });

  it("offers None as each picker's clear choice, and refuses the same shelf twice", () => {
    drafts(draft({ editor: "shelf", place: "Store shelf", base: { first: null, second: null }, value: { first: "shelf-11", second: "shelf-11" }, changes: 2 }));
    const markup = shelfRow();
    expect(count(markup, '<div role="option">None</div>')).toBe(2);
    expect(markup).toContain("Pick two different shelves.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(markup).not.toContain("Pick a first shelf first");
  });

  it("saves a changed shelf, and shows the field error when the shelf is gone", () => {
    drafts(draft({ editor: "shelf", place: "Store shelf", base: { first: null, second: null }, value: { first: "shelf-11", second: null }, changes: 1 }));
    expect(shelfRow()).not.toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    drafts(draft({
      editor: "shelf",
      place: "Store shelf",
      base: { first: null, second: null },
      value: { first: "shelf-11", second: null },
      changes: 1,
      phase: "refused",
      message: "That shelf is gone from your eBay store.",
      code: "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID",
    }));
    expect(shelfRow()).toMatch(/<p role="alert"[^>]*>That shelf is gone from your eBay store.<\/p>/);
  });

  it("still lets the vendor choose None during a sign-in, with the pickers off", () => {
    const saved = setup({ storeShelfDefault: { ids: ["shelf-11"], names: ["Supplies:Toploaders"] } });
    const signIn = { editable: false, reason: "sign_in" } as const;
    drafts();
    const closed = shelfRow({ setup: read(saved), shelves: shelves(undefined, new Error("403")), rightPick: signIn });
    expect(closed).toContain('aria-label="Change Store shelf"');
    drafts(draft({ editor: "shelf", place: "Store shelf", base: { first: "shelf-11", second: null }, value: { first: "shelf-11", second: null } }));
    const open = shelfRow({ setup: read(saved), shelves: shelves(undefined, new Error("403")), rightPick: signIn });
    expect(open).toContain("Reconnect eBay to change this.");
    expect(open).toContain(">Set to None</button>");
    expect(open).toMatch(/aria-label="Shelf"[^>]*disabled=""/);
    // eBay can't be read, so the saved shelf is not called gone.
    expect(open).not.toContain("no longer in your eBay store");
    expect(open).toContain("Supplies › Toploaders");
    // With nothing saved there is nothing to set to None, so the row stays closed.
    drafts();
    expect(shelfRow({ shelves: shelves(undefined, new Error("403")), rightPick: signIn })).not.toContain("Change Store shelf");
  });
});

function note(overrides: Partial<ShipFromRepairNoteProps> = {}): string {
  return render(React.createElement(ShipFromRepairNote, {
    setup: read(setup({ missingFields: ["merchantLocationKey"] })),
    right: EDITABLE,
    onSaved: noop,
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
    ...overrides,
  }));
}

describe("ShipFromRepairNote", () => {
  it("shows nothing when the ship-from location is right", () => {
    drafts();
    expect(note({ setup: read(setup()), right: { editable: false, reason: "not_needed" } })).toBe("");
    expect(note({ setup: read() })).toBe("");
  });

  it("asks to update where items ship from, with Update now", () => {
    drafts();
    const markup = note();
    expect(markup).toContain('data-testid="ship-from-repair-note"');
    expect(markup).toContain("Card Shellz needs to update where your items ship from.");
    expect(markup).toMatch(/<button[^>]*>Update now<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Update now<\/button>/);
  });

  it("turns Update now off with its hint while a policy change isn't saved (C19)", () => {
    drafts(draft({ editor: "return", place: "Return policy", base: { policyId: "pol-ret-1" }, value: { policyId: "pol-ret-2" }, changes: 1 }));
    const fromDraft = note();
    expect(fromDraft).toMatch(/<button[^>]*disabled=""[^>]*>Update now<\/button>/);
    expect(fromDraft).toContain("Save or cancel your policy change first.");
    drafts();
    const fromRight = note({ right: { editable: false, reason: "save_policy_first" } });
    expect(fromRight).toMatch(/<button[^>]*disabled=""[^>]*>Update now<\/button>/);
    expect(count(fromRight, "Save or cancel your policy change first.")).toBe(1);
    // Another editor's change does not hold it up.
    drafts(draft({ editor: "description", place: "Description", changes: 1 }));
    expect(note()).not.toContain("Save or cancel");
  });

  it("offers Check again after a repair nobody could confirm, and says Saved after one", () => {
    drafts(draft({ editor: "shipFrom", place: "Ship-from location", phase: "uncertain", message: "We couldn't confirm your save.", attempt: { signature: "{}", key: "ls-ship-from:abc12345" } }));
    const uncertain = note();
    expect(uncertain).toMatch(/<button[^>]*>Check again<\/button>/);
    expect(uncertain).not.toMatch(/<button[^>]*disabled=""[^>]*>Check again<\/button>/);
    expect(uncertain).toContain("We couldn&#x27;t confirm your save.");
    // The other editors are not held up by it (decideOpen), so the note promises no wait.
    expect(uncertain).not.toContain("Other settings can be changed");
    // A newer read that says the location is right (the repair may have landed) still offers Check
    // again: it is the only way out of the unconfirmed repair.
    const landed = note({ setup: read(setup()), right: { editable: false, reason: "not_needed" } });
    expect(landed).toMatch(/<button[^>]*>Check again<\/button>/);
    expect(landed).not.toMatch(/<button[^>]*disabled=""[^>]*>Check again<\/button>/);
    expect(landed).not.toContain("Card Shellz needs to update where your items ship from.");
    drafts(draft({ editor: "shipFrom", place: "Ship-from location", open: false, phase: "saved", savedAtMs: 0 }), true);
    const saved = note({ setup: read(setup()), right: { editable: false, reason: "not_needed" } });
    expect(saved).toMatch(/<p role="status"[^>]*>Saved<\/p>/);
    expect(saved).not.toContain("Update now");
  });

  it("reads the setup with throwOnError, so a read cancelled in flight counts as failed, not as the cached answer", () => {
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/listing-settings/ShipFromRepairNote.tsx"), "utf8");
    expect(source).toContain("readShipFromRepairStart(() => setup.refetch({ throwOnError: true }))");
    expect(source).not.toContain("readShipFromRepairStart(() => setup.refetch())");
  });

  it("gives the reason and no button while eBay needs a sign-in", () => {
    drafts();
    const markup = note({ right: { editable: false, reason: "sign_in" } });
    expect(markup).toContain("Card Shellz needs to update where your items ship from.");
    expect(markup).toContain("Reconnect eBay to change this.");
    expect(markup).not.toContain("<button");
  });
});

describe("EbayStoreCategoryCombobox", () => {
  const props = { ariaLabel: "Primary eBay Store category", categories: SHELVES, onValueChange: noop, placeholder: "Optional", value: "shelf-11" };

  it("reads as it always has without the new props", () => {
    const markup = render(React.createElement(EbayStoreCategoryCombobox, props));
    expect(markup).toContain("Store category shelf-11");
    expect(markup).toContain("Clear optional category");
    expect(markup).toContain('placeholder="Search your eBay Store categories..." aria-label="Search your eBay Store categories"');
    expect(markup).toContain("No matching Store categories.");
  });

  it("hides ids and uses the given words", () => {
    const markup = render(React.createElement(EbayStoreCategoryCombobox, {
      ...props,
      hideIds: true,
      clearLabel: "None",
      searchPlaceholder: "Search your shelves",
      emptyMessage: "No matching shelves.",
    }));
    expect(markup).not.toContain("Store category shelf-");
    expect(markup).not.toContain("shelf-11");
    expect(markup).toContain('<div role="option">None</div>');
    expect(markup).toContain('placeholder="Search your shelves" aria-label="Search your shelves"');
    expect(markup).toContain("No matching shelves.");
  });
});
