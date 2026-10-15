import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listingSettingsProductDetailSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsSizePriceSchema,
  type ListingSettingsProductDetail,
  type ListingSettingsProductOwnSettings,
  type ListingSettingsSizePrice,
} from "@shared/dropship/listing-settings";
import { listingSettingsProductOwnQueryOptions, listingSettingsProductQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { productEditorId, reduceListingSettingsDraft, type ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import { drawerSettingRows, sizePriceDraftValue } from "@/lib/dropship-listing-settings-drawer";
import {
  descriptionFieldEditor,
  ebayCategoryFieldEditor,
  emptyChoices,
  policyFieldEditor,
  productSettingsDraftValue,
  storeShelfFieldEditor,
  type ProductSettingsChoices,
} from "@/lib/dropship-listing-settings-product-edit";
import { policyEditorChoices, type PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import type { DropshipEbayFulfillmentPolicyOption, DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import { DrawerDescriptionEditor, OwnTextCheckNotice } from "../listing-settings/DrawerDescriptionEditor";
import { DrawerEbayCategoryEditor, DrawerFieldEditor, DrawerShelfEditor, type DrawerFieldEditorProps } from "../listing-settings/DrawerFieldEditor";
import { DrawerSettingRow } from "../listing-settings/DrawerSettingRow";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { PolicyChoiceList } from "../listing-settings/PolicyChoiceList";
import { ProductDrawer, type ProductDrawerProps } from "../listing-settings/ProductDrawer";

/**
 * The drawer's editing (Listing settings PR 10, plan 4.3, 4.5, 4.9, 5.2-5.6): [Change] only with a
 * right, the inline editor's policies with their Card Shellz fit and "Use default", the eBay
 * category, shelf and description editors' choices and counters, "Sizes differ" quick picks, the
 * main text's check, and the drawer with a draft of each kind (D2). Static renders: the step's one
 * draft is set per test, since the real provider can't start with one.
 */

const state = vi.hoisted(() => ({ drafts: null as unknown }));

vi.mock("../listing-settings/ListingSettingsDraftsProvider", () => ({
  useListingSettingsDrafts: () => state.drafts,
}));

/** Radix renders a sheet into a portal, which a static render leaves out: render it in place (plan 3.1: every export). */
vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? createElement("div", { "data-mock": "sheet" }, children) : null),
    SheetContent: ({ children, "data-testid": testId }: Props) => createElement("div", { "data-testid": testId }, children),
    SheetHeader: ({ children }: Props) => createElement("div", null, children),
    SheetTitle: ({ children }: Props) => createElement("h2", null, children),
    SheetDescription: ({ children }: Props) => createElement("p", null, children),
  };
});

const STORE = 22;
const PRODUCT = 11;
const SIZE_A = 101;
const GENERATED_AT = "2026-10-09T12:00:00.000Z";
const EDITOR = productEditorId(PRODUCT);
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const RIGHTS: ProductDrawerProps["rights"] = {
  exactPrice: EDITABLE, productSettings: EDITABLE, shipping: EDITABLE, policies: EDITABLE, ebayCategory: EDITABLE, shelfPick: EDITABLE,
  priceCheck: EDITABLE,
};
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.drafts = null;
});

function fulfillment(id: string, name: string, overrides: Partial<DropshipEbayFulfillmentPolicyOption> = {}): DropshipEbayFulfillmentPolicyOption {
  return { id, name, compatible: true, compatibilityChecked: true, compatibilityIssues: [], ...overrides };
}

const TOO_SHORT = { compatible: false, compatibilityIssues: [{ code: "handling_time_too_short", message: "x" }] };

const SETUP_ANSWER: PolicySetupFacts = {
  selection: { merchantLocationKey: "cs", fulfillmentPolicyId: "pol-ship-1", returnPolicyId: "pol-ret-1", paymentPolicyId: "pol-pay-1" },
  storedNames: { fulfillmentPolicyName: "Free Standard US", returnPolicyName: "30 days, buyer pays", paymentPolicyName: "eBay payments" },
  options: {
    merchantLocations: [],
    fulfillmentPolicies: [fulfillment("pol-ship-1", "Free Standard US"), fulfillment("pol-ship-2", "Economy, 1 day handling", TOO_SHORT)],
    returnPolicies: [{ id: "pol-ret-1", name: "30 days, buyer pays" }, { id: "pol-ret-2", name: "No returns" }],
    paymentPolicies: [{ id: "pol-pay-1", name: "eBay payments" }],
  },
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  fulfillmentCapability: {
    marketplaceId: "EBAY_US", requiredHandlingTimeBusinessDays: 2, destinationCountry: "US", destinationRegions: ["US"],
    destinationCoverageComplete: true, supportedServices: [], evidenceHash: "h",
    source: { omsChannelId: 1, originWarehouseId: 1, rateBookId: 1, rateBookCode: "R", rateTableId: 1, serviceLevelId: 1, fulfillmentRoutingRevision: 1 },
  } as DropshipEbayListingSetupResponse["fulfillmentCapability"],
};
const SETUP: ListingSettingsReadState<PolicySetupFacts> = { data: SETUP_ANSWER, error: null };

const OWN: ListingSettingsProductOwnSettings = listingSettingsProductOwnSettingsSchema.parse({
  storeConnectionId: STORE, productId: PRODUCT, revisionId: 5,
  own: { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null,
    returnPolicy: { id: "pol-ret-2", name: "No returns" }, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null },
  generatedAt: GENERATED_AT,
});

function sizePrice(overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return listingSettingsSizePriceSchema.parse({
    productVariantId: SIZE_A, productId: PRODUCT, productName: "Penny Sleeves", sizeName: "Pack of 100", sku: "PSL-100",
    priceCents: 1499, source: "exact", rule: null, basis: null, basisAmountCents: null, issue: null, costCents: 980,
    belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: 7, ...overrides,
  });
}

const DETAIL: ListingSettingsProductDetail = listingSettingsProductDetailSchema.parse({
  storeConnectionId: STORE,
  product: { productId: PRODUCT, productName: "Penny Sleeves", category: "Sleeves", sizesChosen: 1, sizesTotal: 1,
    priceRange: { minCents: 1499, maxCents: 1499 }, exactPriceCount: 1, ownSettings: ["return_policy"], sizesDiffer: [], fixes: [] },
  settings: {
    shippingPolicy: [{ value: { policyId: "pol-ship-1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [SIZE_A] }] }],
    returnPolicy: [{ value: { policyId: "pol-ret-2" }, sources: [{ source: "product", ruleName: null, productVariantIds: [SIZE_A] }] }],
    paymentPolicy: [{ value: { policyId: "pol-pay-1" }, sources: [{ source: "category", ruleName: "Sleeves", productVariantIds: [SIZE_A] }] }],
    ebayCategory: [{ value: { categoryId: "261328", categoryName: "Card Sleeves" }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [SIZE_A] }] }],
    storeShelf: [{ value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A] }] }],
    descriptionTemplate: [{ value: { hasIntroduction: false, hasFooter: false, groupConflict: false }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A] }] }],
    mainText: [{ value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [SIZE_A] }] }],
  },
  sizes: [{ price: sizePrice(), fixes: [], stockUnits: 40 }],
  stock: { state: "ok", checkedAt: GENERATED_AT },
  generatedAt: GENERATED_AT,
});

function draftsValue(draft: ListingSettingsDraft | null): ListingSettingsDraftsValue {
  const value: ListingSettingsDraftsValue = {
    draft, savedFlashVisible: false, now: () => 0,
    open: vi.fn(() => true), edit: vi.fn(), startSave: vi.fn(() => null), settle: vi.fn(), rebase: vi.fn(),
    discard: vi.fn(), close: vi.fn(), requestClose: vi.fn(),
  };
  state.drafts = value;
  return value;
}

function settingsDraft(choices: Partial<ProductSettingsChoices>): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Penny Sleeves", base: productSettingsDraftValue(OWN) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: productSettingsDraftValue(OWN, { ...emptyChoices(), ...choices }) })!;
}

function sizeDraft(exact: string): ListingSettingsDraft {
  const base = { productVariantId: SIZE_A, expectedRevisionId: 7, exact: "14.99" };
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Penny Sleeves", base: sizePriceDraftValue(base) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: sizePriceDraftValue({ ...base, exact }) })!;
}

function render(node: React.ReactElement, client = new QueryClient()): string {
  vi.stubGlobal("React", React);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, node));
  } finally {
    client.clear();
  }
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
}

/** The drawer on product 11 with its two reads answered (DETAIL and OWN unless given), the given draft and rights. */
function renderDrawer(draft: ListingSettingsDraft | null, props: Partial<ProductDrawerProps> = {},
  reads: { detail?: ListingSettingsProductDetail; own?: ListingSettingsProductOwnSettings } = {}): string {
  draftsValue(draft);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(listingSettingsProductQueryOptions(STORE, PRODUCT).queryKey, reads.detail ?? DETAIL);
  client.setQueryData(listingSettingsProductOwnQueryOptions(STORE, PRODUCT).queryKey, reads.own ?? OWN);
  return render(React.createElement(ProductDrawer, {
    storeConnectionId: STORE, storeName: "Marz Cards", target: { productId: PRODUCT }, rights: RIGHTS, setup: SETUP,
    summaryRecipe: null, onClose: noop, saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop,
    onGoToStep1: noop, onGoToStep3: noop, ...props,
  }), client);
}

/** One row's markup, from its testid to the next row's (a row's own lines carry `<key>-pending`, `<key>-line`). */
function rowOf(markup: string, key: string): string {
  const start = markup.indexOf(`data-testid="drawer-setting-${key}"`);
  const rest = markup.slice(start + 1);
  const next = /data-testid="drawer-setting-[A-Za-z]+"/.exec(rest);
  return markup.slice(start, next === null ? undefined : start + 1 + next.index);
}

const CHANGE_BUTTON = /<button[^>]*aria-label="Change [A-Za-z ]+ for Penny Sleeves"[^>]*>Change<\/button>/g;
/** Every row of the drawer, in its order; each has [Change] from 10b. */
const ROW_KEYS = ["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "descriptionTemplate"] as const;

/** The radio's whole label that holds `words`: its input, and whether that input is checked. */
function labelWith(markup: string, words: string): string {
  const at = markup.indexOf(words);
  expect(at).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<label", at), markup.indexOf("</label>", at));
}

describe("Change on the drawer's rows (plan 4.10, 5.2: Change when W5 allows; a new pick needs both rights)", () => {
  it("shows Change on every row when W5 and the eBay picks are allowed", () => {
    const markup = renderDrawer(null);
    expect(markup.match(CHANGE_BUTTON)).toHaveLength(6);
    for (const key of ROW_KEYS) {
      expect(rowOf(markup, key)).toMatch(/aria-expanded="false"/);
      expect(rowOf(markup, key)).not.toMatch(/disabled=""[^>]*>Change/);
    }
  });

  it("has no Change on any row when a paused account, inactive .ops, a blocked store or too many sizes take W5 away", () => {
    for (const reason of ["banner", "loading"] as const) {
      const off: ListingSettingsRight = { editable: false, reason };
      const markup = renderDrawer(null, { rights: { ...RIGHTS, productSettings: off } });
      // The rows still show their values, with no button to change them.
      expect(text(rowOf(markup, "returnPolicy"))).toContain("No returns Set for this product");
      expect(text(rowOf(markup, "shippingPolicy"))).toContain("Free Standard US Store default");
      expect(markup.match(/>Change<\/button>/g)).toBeNull();
    }
  });

  it("offers Change for the default only under a sign-in, with the field line (D4)", () => {
    const signIn: ListingSettingsRight = { editable: false, reason: "sign_in" };
    const markup = renderDrawer(null, { rights: { ...RIGHTS, shipping: signIn, policies: signIn }, setup: { data: undefined, error: new Error("403") } });
    expect(markup.match(CHANGE_BUTTON)).toHaveLength(6);
    expect(text(rowOf(markup, "returnPolicy"))).toContain("Sign in to eBay again to pick a new one. You can still use the default.");
  });

  it("says only the default is left when a banner takes the new picks away and names no line of its own (D4)", () => {
    const banner: ListingSettingsRight = { editable: false, reason: "banner" };
    const markup = renderDrawer(null, { rights: { ...RIGHTS, shipping: banner, policies: banner } });
    expect(markup.match(CHANGE_BUTTON)).toHaveLength(6);
    for (const key of ["shippingPolicy", "returnPolicy", "paymentPolicy"]) {
      expect(text(rowOf(markup, key))).toContain("You can't pick a new one right now. You can still use the default.");
    }
  });

  it("says where each value comes from, a category by name, and no id", () => {
    const words = text(renderDrawer(null));
    expect(words).toContain("No returns Set for this product");
    expect(words).toContain("eBay payments From category: Sleeves");
    expect(words).not.toMatch(/pol-|261328|DROPSHIP_/);
  });
});

describe("the drawer with a draft of each kind (D2)", () => {
  it("shows a settings change as not saved, counts it, and holds every size's price", () => {
    const markup = renderDrawer(settingsDraft({ returnPolicy: { mode: "default" }, shippingPolicy: { mode: "set", value: { id: "pol-ship-1" } } }));
    expect(text(rowOf(markup, "returnPolicy"))).toContain("→ Use default · Not saved");
    expect(text(rowOf(markup, "shippingPolicy"))).toContain("→ Free Standard US · Not saved");
    expect(text(markup)).toContain("● Not saved · 2 changes");
    expect(markup).not.toMatch(/disabled=""[^>]*>Save product/);
    const size = markup.slice(markup.indexOf('data-testid="drawer-price-section"'), markup.indexOf('data-testid="drawer-settings"'));
    expect(text(size)).toContain("Save or discard your other change first.");
    expect(size).toMatch(/readOnly=""/i);
  });

  it("keeps Change off with the one-change line while a size's price holds a change", () => {
    const markup = renderDrawer(sizeDraft("12.00"));
    expect(markup.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(6);
    expect(text(rowOf(markup, "shippingPolicy"))).toContain("Save or discard your other change first.");
    expect(text(markup)).toContain("● Not saved · 1 change");
  });

  it("offers Load latest after a conflict, and Check again after a save nobody could confirm", () => {
    const sent = reduceListingSettingsDraft(settingsDraft({ returnPolicy: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "ls-product:k" } })!;
    const conflict = reduceListingSettingsDraft(sent, { type: "failure", key: "ls-product:k",
      failure: { phase: "conflict", message: "This changed in another window.", code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", status: 409, fields: [] } })!;
    const conflictMarkup = renderDrawer(conflict);
    expect(text(conflictMarkup)).toContain("This changed in another window.");
    expect(conflictMarkup).toContain(">Load latest and keep my changes</button>");
    const uncertain = reduceListingSettingsDraft(sent, { type: "failure", key: "ls-product:k",
      failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null, fields: [] } })!;
    const uncertainMarkup = renderDrawer(uncertain);
    expect(text(uncertainMarkup)).toContain("We couldn't confirm your save.");
    expect(uncertainMarkup).toContain(">Check again</button>");
    // Locked: no row can change, and Discard is off.
    expect(uncertainMarkup.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(6);
    expect(uncertainMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Discard<\/button>/);
  });

  it("tells a refusal that names no row in the footer", () => {
    const sent = reduceListingSettingsDraft(settingsDraft({ returnPolicy: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "ls-product:k" } })!;
    const refused = reduceListingSettingsDraft(sent, { type: "failure", key: "ls-product:k",
      failure: { phase: "refused", message: "This change couldn't be saved. Reload the page and try again.", code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", status: 400, fields: [] } })!;
    const footer = renderDrawer(refused);
    const bar = footer.slice(footer.indexOf('data-testid="product-drawer-footer"'));
    expect(bar).toContain('role="alert"');
    expect(text(bar)).toContain("This change couldn't be saved. Reload the page and try again.");
  });
});

describe("DrawerSettingRow with edit state", () => {
  const draft = reduceListingSettingsDraft(settingsDraft({ shippingPolicy: { mode: "set", value: { id: "pol-ship-2" } } }), {
    type: "rebase", latest: productSettingsDraftValue(OWN), marked: ["shippingPolicy"],
  })!;
  const rows = drawerSettingRows(DETAIL, SETUP, {
    own: { data: OWN, error: null }, rights: RIGHTS, draft, editor: EDITOR, openField: "shippingPolicy",
    failure: { message: "That policy is no longer on eBay. Pick another one.", fields: ["shippingPolicy"] },
  });

  it("shows the pending change, the marked line, the refusal, and Change named for the product", () => {
    const markup = render(React.createElement(DrawerSettingRow, { row: rows[0], productName: "Penny Sleeves", onChange: noop, editor: React.createElement("p", null, "EDITOR") }));
    const words = text(markup);
    expect(words).toContain("→ Economy, 1 day handling · Not saved");
    expect(words).toContain("Changed in another window too");
    expect(markup).toMatch(/role="alert"[^>]*>That policy is no longer on eBay\. Pick another one\./);
    expect(markup).toMatch(/aria-label="Change shipping policy for Penny Sleeves"[^>]*aria-expanded="true"/);
    expect(words).toContain("EDITOR");
    // [Change] is described by the change it holds, so it is read out when focus comes back to it after Done.
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`id="${describedBy}"`);
    expect(markup).toMatch(new RegExp(`id="${describedBy}"[^>]*>→ Economy, 1 day handling · Not saved`));
    // With nothing pending, nothing describes it; a row given a ref can take focus but is never tabbed to.
    const unchanged = render(React.createElement(DrawerSettingRow, { row: rows[1], productName: "Penny Sleeves", onChange: noop, rowRef: noop }));
    expect(unchanged).not.toContain("aria-describedby");
    expect(unchanged).toMatch(/data-testid="drawer-setting-returnPolicy"/);
    expect(unchanged).toMatch(/tabindex="-1"/i);
  });

  it("has no button without a way to open its editor, and none on a row without edit facts", () => {
    expect(render(React.createElement(DrawerSettingRow, { row: rows[0] }))).not.toContain("<button");
    // 10b gives every row its edit state; a row read without edit facts (PR 7) still has no button.
    expect(rows[3].edit).not.toBeNull();
    expect(render(React.createElement(DrawerSettingRow, { row: drawerSettingRows(DETAIL, SETUP)[3], productName: "Penny Sleeves", onChange: noop })))
      .not.toContain("<button");
  });
});

describe("DrawerFieldEditor (plan 4.5)", () => {
  function editor(field: "shippingPolicy" | "returnPolicy", rights = { canSet: true, canDefault: true }, overrides: Partial<DrawerFieldEditorProps> = {}): string {
    const model = policyFieldEditor({ field, rights, draftChoice: { mode: "leave" }, own: OWN, setup: SETUP });
    return render(React.createElement(DrawerFieldEditor, {
      model, title: field === "shippingPolicy" ? "Shipping policy" : "Return policy", productName: "Penny Sleeves",
      message: null, onDone: noop, onCancel: noop, ...overrides,
    }));
  }

  it("lists eBay's shipping policies with whether each works with Card Shellz shipping, then Use default", () => {
    const markup = editor("shippingPolicy");
    const words = text(markup);
    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(words).toContain("Free Standard US ✓ Works with Card Shellz shipping");
    expect(words).toMatch(/Economy, 1 day handling ✗ Can't use: /);
    expect(words).toContain("Use default");
    // A policy that can't be used can't be picked; no id shows.
    expect(markup).toMatch(/<input type="radio"[^>]*disabled=""/);
    expect(words).not.toMatch(/pol-ship/);
    // The product has no own shipping policy: it opens on Use default alone, and Done is on.
    expect(labelWith(markup, "Use default")).toMatch(/<input type="radio"[^>]*checked=""/);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
    expect(words).toContain("Cancel");
    expect(markup).toContain('data-testid="drawer-field-editor-shippingPolicy"');
    expect(markup).toContain("Shipping policy for Penny Sleeves");
  });

  it("opens on the product's own policy", () => {
    const markup = editor("returnPolicy");
    expect(labelWith(markup, "No returns")).toMatch(/checked=""/);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
  });

  it("opens with nothing picked, and Done off, while a size still sets the field for itself", () => {
    const model = policyFieldEditor({ field: "returnPolicy", rights: { canSet: true, canDefault: true }, draftChoice: { mode: "leave" }, own: OWN, leftover: true, setup: SETUP });
    const markup = render(React.createElement(DrawerFieldEditor, {
      model, title: "Return policy", productName: "Penny Sleeves", message: null, onDone: noop, onCancel: noop,
    }));
    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(markup).not.toContain('checked=""');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
  });

  it("names its group and list with the product", () => {
    const markup = editor("shippingPolicy");
    expect(markup).toMatch(/role="group"[^>]*aria-label="Shipping policy for Penny Sleeves"/);
    expect(markup).toContain('<legend class="sr-only">Shipping policy for Penny Sleeves</legend>');
  });

  it("shows only Use default when no new policy can be picked (D4)", () => {
    const markup = editor("returnPolicy", { canSet: false, canDefault: true });
    expect(markup.match(/type="radio"/g)).toHaveLength(1);
    expect(text(markup)).toContain("Use default");
    expect(text(markup)).not.toContain("30 days, buyer pays");
  });

  it("says why Done didn't take the choice", () => {
    const markup = editor("returnPolicy", undefined, { message: "Save or discard your other change first." });
    expect(markup).toMatch(/role="alert"[^>]*>Save or discard your other change first\./);
  });
});

describe("PolicyChoiceList (plan 4.3: extracted from PolicyDefaultRow)", () => {
  const choices = policyEditorChoices(SETUP_ANSWER, "shipping");

  it("draws nothing after eBay's policies without an extra choice", () => {
    const markup = render(React.createElement(PolicyChoiceList, {
      name: "g", legend: "Shipping policy", choices, picked: "pol-ship-1", disabled: false, marked: true, suggestedId: "pol-ship-1", onPick: noop,
    }));
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(text(markup)).toContain("Changed in another window too");
    expect(text(markup)).toContain("Suggested · not saved");
    expect(text(markup)).not.toContain("Use default");
  });

  it("adds an extra choice in the same group", () => {
    const markup = render(React.createElement(PolicyChoiceList, {
      name: "g", legend: "Shipping policy", choices, picked: null, disabled: true, marked: false, suggestedId: null, onPick: noop,
      extra: { label: "Use default", checked: true, onPick: noop },
    }));
    expect(markup.match(/name="g"/g)).toHaveLength(3);
    expect(markup).toMatch(/<fieldset disabled=""/);
    expect(labelWith(markup, "Use default")).toMatch(/checked=""/);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10b: the eBay category, store shelf and description rows (plan 5.2-5.4, 5.6)
// ---------------------------------------------------------------------------

const SIZE_B = 102;
const SHELVES = [
  { categoryId: "S1", categoryName: "Sleeves", path: "Supplies:Sleeves", level: 2 },
  { categoryId: "S2", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
  { categoryId: "S3", categoryName: "Sale", path: "Sale", level: 1 },
];

/** Product 11 with its own eBay category, two shelves, text above and a main text Card Shellz changed under. */
const OWN_10B: ListingSettingsProductOwnSettings = listingSettingsProductOwnSettingsSchema.parse({
  ...OWN,
  revisionId: 6,
  own: {
    ...OWN.own,
    ebayCategory: { categoryId: "183436", categoryName: "Toploaders" },
    storeShelf: { mode: "own", shelves: [{ id: "S1", name: "Supplies › Sleeves" }, { id: "S2", name: "Supplies › Toploaders" }] },
    textAbove: { mode: "own", text: "Ships in a rigid mailer." },
    mainText: { text: "Our own words.", needsCheck: true },
  },
});

/** Two sizes whose shipping policy differs: the store default on one, a leftover of the older per-size settings on the other. */
const DETAIL_DIFFER: ListingSettingsProductDetail = listingSettingsProductDetailSchema.parse({
  ...DETAIL,
  product: { ...DETAIL.product, sizesChosen: 2, sizesTotal: 2, ownSettings: ["return_policy", "shipping_policy"], sizesDiffer: ["shipping_policy"] },
  settings: {
    ...DETAIL.settings,
    shippingPolicy: [
      { value: { policyId: "pol-ship-1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [SIZE_A] }] },
      { value: { policyId: "pol-ship-2" }, sources: [{ source: "size", ruleName: null, productVariantIds: [SIZE_B] }] },
    ],
    returnPolicy: [{ value: { policyId: "pol-ret-2" }, sources: [{ source: "product", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    paymentPolicy: [{ value: { policyId: "pol-pay-1" }, sources: [{ source: "category", ruleName: "Sleeves", productVariantIds: [SIZE_A, SIZE_B] }] }],
    ebayCategory: [{ value: { categoryId: "261328", categoryName: "Card Sleeves" }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    storeShelf: [{ value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    descriptionTemplate: [{ value: { hasIntroduction: false, hasFooter: false, groupConflict: false }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    mainText: [{ value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
  },
  sizes: [
    { price: sizePrice(), fixes: [], stockUnits: 40 },
    { price: sizePrice({ productVariantId: SIZE_B, sizeName: "Pack of 500", sku: "PSL-500", source: "catalog_price", settingRevisionId: null }), fixes: [], stockUnits: 9 },
  ],
});

/** The product's main text, its own and saved against an older Card Shellz product (5.4). */
const DETAIL_OWN_TEXT: ListingSettingsProductDetail = listingSettingsProductDetailSchema.parse({
  ...DETAIL,
  product: { ...DETAIL.product, ownSettings: ["return_policy", "description"], fixes: ["own_text_needs_check"] },
  settings: { ...DETAIL.settings, mainText: [{ value: { own: true }, sources: [{ source: "product", ruleName: null, productVariantIds: [SIZE_A] }] }] },
  sizes: [{ price: sizePrice(), fixes: ["own_text_needs_check"], stockUnits: 40 }],
});

describe("the eBay category, shelf and description rows in the drawer (plan 5.2, 5.4)", () => {
  it("names each row's Change for the product, and says in the header which values the category sets", () => {
    const markup = renderDrawer(null);
    expect(rowOf(markup, "ebayCategory")).toMatch(/aria-label="Change eBay category for Penny Sleeves"/);
    expect(rowOf(markup, "storeShelf")).toMatch(/aria-label="Change store shelf for Penny Sleeves"/);
    expect(rowOf(markup, "descriptionTemplate")).toMatch(/aria-label="Change description for Penny Sleeves"/);
    // The payment policy comes from the Sleeves category's settings (R:591).
    expect(text(markup)).toContain("Card Shellz category: Sleeves · From your Sleeves settings · 1 of 1 size selected");
    // Never "set in step 3" (5.7).
    expect(text(markup)).not.toContain("set in step 3");
  });

  it("keeps the eBay category and shelf rows to the default (and None) under a sign-in, and says why (D4)", () => {
    const signIn: ListingSettingsRight = { editable: false, reason: "sign_in" };
    const markup = renderDrawer(null, { rights: { ...RIGHTS, ebayCategory: signIn, shelfPick: signIn } });
    for (const key of ["ebayCategory", "storeShelf"]) {
      expect(rowOf(markup, key)).toMatch(/>Change<\/button>/);
      expect(text(rowOf(markup, key))).toContain("Sign in to eBay again to pick a new one. You can still use the default.");
    }
    // Text names no eBay value: the description row is untouched by the sign-in.
    expect(text(rowOf(markup, "descriptionTemplate"))).not.toContain("Sign in to eBay");
  });

  it("asks the main text's check under the closed Description row, with both answers named for the product (5.4)", () => {
    const own = listingSettingsProductOwnSettingsSchema.parse({ ...OWN_10B, own: { ...OWN.own, mainText: { text: "Our own words.", needsCheck: true } } });
    const markup = rowOf(renderDrawer(null, {}, { detail: DETAIL_OWN_TEXT, own }), "descriptionTemplate");
    expect(text(markup)).toContain("Card Shellz changed this product. Check your text still fits.");
    expect(markup).toMatch(/<button[^>]*aria-label="Keep my text for Penny Sleeves"[^>]*>Keep my text<\/button>/);
    expect(markup).toMatch(/<button[^>]*aria-label="Use Card Shellz text for Penny Sleeves"[^>]*>Use Card Shellz text<\/button>/);
    expect(markup).not.toMatch(/disabled=""[^>]*>Keep my text/);
    // Waiting for a size's price (D2): the answers wait as Change does.
    const waiting = rowOf(renderDrawer(sizeDraft("12.00"), {}, { detail: DETAIL_OWN_TEXT, own }), "descriptionTemplate");
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>Keep my text<\/button>/);
    // Answered in the draft: the pending line says so instead.
    const kept = rowOf(renderDrawer(settingsDraftOn(own, { mainText: { mode: "set", value: { text: "Our own words." } } }), {}, { detail: DETAIL_OWN_TEXT, own }), "descriptionTemplate");
    expect(text(kept)).not.toContain("Check your text still fits");
    expect(text(kept)).toContain("→ Main text: your own · Not saved");
  });

  it("offers only Use Card Shellz text when a size's own text needs the check but the product has none (5.4)", () => {
    const detail = listingSettingsProductDetailSchema.parse({ ...DETAIL_OWN_TEXT,
      settings: { ...DETAIL.settings, mainText: [{ value: { own: true }, sources: [{ source: "size", ruleName: null, productVariantIds: [SIZE_A] }] }] } });
    const markup = rowOf(renderDrawer(null, {}, { detail }), "descriptionTemplate");
    expect(text(markup)).toContain("Card Shellz changed this product. Check your text still fits.");
    expect(markup).not.toContain(">Keep my text</button>");
    expect(markup).toContain(">Use Card Shellz text</button>");
  });
});

describe("Sizes differ in the drawer (plan 5.3)", () => {
  // The leftover's pol-ship-2 as eBay lists it once it works with Card Shellz shipping (SETUP's is too short a handling time).
  const SETUP_FITS: ListingSettingsReadState<PolicySetupFacts> = { error: null, data: { ...SETUP_ANSWER, options: { ...SETUP_ANSWER.options,
    fulfillmentPolicies: [fulfillment("pol-ship-1", "Free Standard US"), fulfillment("pol-ship-2", "Economy, 1 day handling")] } } };

  it("puts Use default for all sizes and Use for all sizes beside the values, each named with the value and the product", () => {
    const row = rowOf(renderDrawer(null, { setup: SETUP_FITS }, { detail: DETAIL_DIFFER }), "shippingPolicy");
    expect(text(row)).toContain("Sizes differ. Pick one for all sizes.");
    expect(row).toMatch(/<button[^>]*aria-label="Use default for all sizes of Penny Sleeves"[^>]*>Use default for all sizes<\/button>/);
    expect(row).toMatch(/<button[^>]*aria-label="Use Economy, 1 day handling for all sizes of Penny Sleeves"[^>]*>Use for all sizes<\/button>/);
    expect(text(row)).not.toMatch(/pol-ship/);
  });

  it("offers no Use for all sizes for a policy the row's editor wouldn't take (review CE3 / UX2)", () => {
    // pol-ship-2 doesn't work with Card Shellz shipping: its editor's Done is off for it, so no one-click pick either.
    const row = rowOf(renderDrawer(null, {}, { detail: DETAIL_DIFFER }), "shippingPolicy");
    expect(row).toContain(">Use default for all sizes</button>");
    expect(row).not.toContain(">Use for all sizes</button>");
    expect(text(row)).toContain("Sizes differ. Pick one for all sizes.");
  });

  it("reads the row's change not saved yet with a quick pick (review UX3)", () => {
    const held = rowOf(renderDrawer(settingsDraftOn(OWN, { shippingPolicy: { mode: "set", value: { id: "pol-ship-1" } } }), { setup: SETUP_FITS }, { detail: DETAIL_DIFFER }), "shippingPolicy");
    const pending = /<p id="([^"]+)"[^>]*data-testid="drawer-setting-shippingPolicy-pending"/.exec(held);
    expect(pending).not.toBeNull();
    expect(held.match(new RegExp(`<button[^>]*aria-describedby="${pending![1]}"[^>]*>Use (default )?for all sizes</button>`, "g"))).toHaveLength(2);
    // Nothing held: no description to point at.
    expect(rowOf(renderDrawer(null, { setup: SETUP_FITS }, { detail: DETAIL_DIFFER }), "shippingPolicy")).not.toMatch(/aria-describedby="[^"]*"[^>]*>Use (default )?for all sizes/);
  });

  it("hides Use for all sizes under a sign-in, keeps Use default for all sizes, and waits for a size's price (D4, D2)", () => {
    const signIn: ListingSettingsRight = { editable: false, reason: "sign_in" };
    const row = rowOf(renderDrawer(null, { rights: { ...RIGHTS, shipping: signIn, policies: signIn }, setup: SETUP_FITS }, { detail: DETAIL_DIFFER }), "shippingPolicy");
    expect(row).toContain(">Use default for all sizes</button>");
    expect(row).not.toContain(">Use for all sizes</button>");
    const waiting = rowOf(renderDrawer(sizeDraft("12.00"), { setup: SETUP_FITS }, { detail: DETAIL_DIFFER }), "shippingPolicy");
    expect(waiting.match(/<button[^>]*disabled=""[^>]*>Use (default )?for all sizes<\/button>/g)).toHaveLength(2);
  });

  it("has no quick pick when nothing can be changed, and keeps PR 7's words", () => {
    const off: ListingSettingsRight = { editable: false, reason: "banner" };
    const row = rowOf(renderDrawer(null, { rights: { ...RIGHTS, productSettings: off } }, { detail: DETAIL_DIFFER }), "shippingPolicy");
    expect(row).not.toContain("for all sizes</button>");
    expect(text(row)).toContain("Sizes have different values. Each size keeps its own for now.");
  });
});

/** A settings draft on `own` holding these choices. */
function settingsDraftOn(own: ListingSettingsProductOwnSettings, choices: Partial<ProductSettingsChoices>): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Penny Sleeves", base: productSettingsDraftValue(own) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: productSettingsDraftValue(own, { ...emptyChoices(), ...choices }) })!;
}

function editorProps() {
  return { title: "x", productName: "Penny Sleeves", message: null, onCancel: noop };
}

describe("DrawerEbayCategoryEditor (plan 5.2)", () => {
  function ebayEditor(own: ListingSettingsProductOwnSettings, rights = { canSet: true, canDefault: true }, draftChoice: Parameters<typeof ebayCategoryFieldEditor>[0]["draftChoice"] = { mode: "leave" }): string {
    return render(React.createElement(DrawerEbayCategoryEditor, {
      ...editorProps(), title: "eBay category", storeConnectionId: STORE,
      model: ebayCategoryFieldEditor({ rights, draftChoice, own }), onDone: noop,
    }));
  }

  it("opens on Use default for a product without its own category, with a button to pick one", () => {
    const markup = ebayEditor(OWN);
    expect(markup.match(/type="radio"/g)).toHaveLength(1);
    expect(labelWith(markup, "Use default")).toMatch(/checked=""/);
    expect(markup).toContain(">Pick an eBay category</button>");
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
    expect(markup).toMatch(/role="group"[^>]*aria-label="eBay category for Penny Sleeves"/);
    expect(markup).toContain('data-testid="drawer-field-editor-ebayCategory"');
  });

  it("opens on the product's own category by name, never its number, with Pick another", () => {
    const markup = ebayEditor(OWN_10B);
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(labelWith(markup, "Toploaders")).toMatch(/checked=""/);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
    expect(markup).toContain(">Pick another</button>");
    expect(markup).not.toContain("183436");
  });

  it("opens on the draft's pick, by the name the picker gave", () => {
    const markup = ebayEditor(OWN, undefined, { mode: "set", value: { categoryId: "183435", categoryName: "Card Sleeves" } });
    expect(labelWith(markup, "Card Sleeves")).toMatch(/checked=""/);
    expect(markup).not.toContain("183435");
  });

  it("names a picked category with no known name as the row does, not with the picker's words (review UX7)", () => {
    // A "Use for all sizes" pick from a value eBay gave no name for.
    const markup = ebayEditor(OWN, undefined, { mode: "set", value: { categoryId: "183435" } });
    expect(labelWith(markup, "An eBay category")).toMatch(/checked=""/);
    expect(markup).not.toMatch(/<span[^>]*>Pick an eBay category<\/span>/);
    expect(markup).not.toContain("183435");
  });

  it("offers only Use default when no new category can be picked, and Done waits for it (D4)", () => {
    const markup = ebayEditor(OWN_10B, { canSet: false, canDefault: true });
    expect(markup.match(/type="radio"/g)).toHaveLength(1);
    expect(text(markup)).toContain("Use default");
    expect(markup).not.toContain("Pick another");
    expect(markup).not.toContain('checked=""');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
  });
});

describe("DrawerShelfEditor (plan 5.2)", () => {
  function shelfEditor(input: Partial<Parameters<typeof storeShelfFieldEditor>[0]> = {}): string {
    const model = storeShelfFieldEditor({
      rights: { canSet: true, canDefault: true, canNone: true }, draftChoice: { mode: "leave" }, own: OWN_10B, shelves: SHELVES, ...input,
    });
    return render(React.createElement(DrawerShelfEditor, { ...editorProps(), title: "Store shelf", model, onDone: noop }));
  }

  it("opens on the product's own two shelves, by name, with None and Use default", () => {
    const markup = shelfEditor();
    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(labelWith(markup, "Own shelves")).toMatch(/checked=""/);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
    expect(text(markup)).toContain("None");
    expect(text(markup)).toContain("Use default");
    // Two boxes, first and second, named for the product; each shows its shelf's path, never its id.
    expect(markup).toMatch(/aria-label="Shelf for Penny Sleeves"[^>]*>(?:(?!<\/button>).)*Supplies › Sleeves(?:(?!<\/button>).)*<\/button>/);
    expect(markup).toMatch(/aria-label="Second shelf \(optional\) for Penny Sleeves"[^>]*>(?:(?!<\/button>).)*Supplies › Toploaders(?:(?!<\/button>).)*<\/button>/);
    expect(markup).not.toMatch(/Store category|S1|S2/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
  });

  it("opens on None, and on Use default, as the product has it", () => {
    const none = listingSettingsProductOwnSettingsSchema.parse({ ...OWN_10B, own: { ...OWN_10B.own, storeShelf: { mode: "none" } } });
    expect(labelWith(shelfEditor({ own: none }), "None")).toMatch(/checked=""/);
    expect(labelWith(shelfEditor({ own: OWN }), "Use default")).toMatch(/checked=""/);
  });

  it("offers None and Use default alone when no new shelf can be picked, and Done waits for one of them (D4)", () => {
    const markup = shelfEditor({ rights: { canSet: false, canDefault: true, canNone: true } });
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup).not.toContain("Own shelves");
    expect(markup).not.toContain('role="combobox"');
    expect(markup).not.toContain('checked=""');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
  });

  it("opens with nothing picked while a size still sets its own shelf, and says so when the store has no shelves", () => {
    expect(shelfEditor({ leftover: true })).not.toContain('checked=""');
    const empty = shelfEditor({ own: OWN, shelves: [] });
    expect(text(empty)).toContain("Your eBay store has no shelves. That's fine: shelves are optional.");
    expect(empty).not.toContain("Own shelves");
  });
});

describe("DrawerDescriptionEditor (plan 5.2, 5.4)", () => {
  const RIGHTS_ALL = { canSet: true, canDefault: true, canNone: true };
  function descriptionEditor(input: Partial<Parameters<typeof descriptionFieldEditor>[0]> = {}): string {
    const model = descriptionFieldEditor({ rights: RIGHTS_ALL, draftChoices: emptyChoices(), own: OWN_10B, ...input });
    return render(React.createElement(DrawerDescriptionEditor, { ...editorProps(), title: "Description", model, onDone: noop }));
  }
  const part = (markup: string, field: string) => {
    const start = markup.indexOf(`data-testid="drawer-description-${field}"`);
    expect(start).toBeGreaterThan(-1);
    return markup.slice(start, markup.indexOf("</fieldset>", start));
  };

  it("gives text above and below Use default, None and Own text, and the main text Use Card Shellz text and Own text", () => {
    const markup = descriptionEditor();
    expect(text(part(markup, "textAbove"))).toMatch(/Text above Use default None Own text/);
    expect(text(part(markup, "textBelow"))).toMatch(/Text below Use default None Own text/);
    expect(text(part(markup, "mainText"))).toMatch(/Main text .*Use Card Shellz text Own text/);
    expect(markup).toMatch(/role="group"[^>]*aria-label="Description for Penny Sleeves"/);
    expect(markup).toContain('data-testid="drawer-field-editor-description"');
  });

  it("opens each part on what the product has, own text prefilled, with its counter", () => {
    const markup = descriptionEditor();
    expect(labelWith(part(markup, "textAbove"), "Own text")).toMatch(/checked=""/);
    expect(part(markup, "textAbove")).toMatch(/<textarea[^>]*aria-label="Text above for Penny Sleeves"[^>]*>Ships in a rigid mailer\.<\/textarea>/);
    expect(text(part(markup, "textAbove"))).toContain("24 / 4,000");
    expect(labelWith(part(markup, "textBelow"), "Use default")).toMatch(/checked=""/);
    expect(part(markup, "textBelow")).not.toContain("<textarea");
    expect(labelWith(part(markup, "mainText"), "Own text")).toMatch(/checked=""/);
    expect(part(markup, "mainText")).toMatch(/<textarea[^>]*>Our own words\.<\/textarea>/);
    expect(text(part(markup, "mainText"))).toContain("14 / 20,000");
  });

  it("counts the text as typed, and marks text over its limit before anything is sent (5.4)", () => {
    const over = "a".repeat(4_000) + "🙂";
    const markup = descriptionEditor({ draftChoices: { ...emptyChoices(), textAbove: { mode: "set", value: { mode: "own", text: over } } } });
    const above = part(markup, "textAbove");
    // An emoji is two UTF-16 units, as the server's max counts it.
    expect(text(above)).toContain("4,002 / 4,000");
    expect(above).toMatch(/aria-invalid="true"/);
    expect(above).toMatch(/class="[^"]*text-rose-800[^"]*">4,002 \/ 4,000/);
    expect(part(descriptionEditor(), "textAbove")).not.toContain("aria-invalid");
  });

  it("puts the check on top of the main text while Card Shellz changed the product (5.4)", () => {
    const main = part(descriptionEditor({ detail: DETAIL_OWN_TEXT }), "mainText");
    expect(text(main)).toContain("Card Shellz changed this product. Check your text still fits.");
    expect(main).toContain(">Keep my text</button>");
    expect(main).toContain(">Use Card Shellz text</button>");
    // Once the draft answers it, the editor no longer asks.
    const answered = descriptionEditor({ draftChoices: { ...emptyChoices(), mainText: { mode: "default" } } });
    expect(answered).not.toContain("Check your text still fits");
  });

  it("opens the main text with nothing picked while a size keeps its own text and the product has none", () => {
    const main = part(descriptionEditor({ own: OWN, leftovers: ["mainText"] }), "mainText");
    expect(main).not.toContain('checked=""');
    expect(main).not.toContain("<textarea");
  });

  it("opens the main text with nothing picked while a size keeps its own text, though the product has its own (review CE2)", () => {
    const main = part(descriptionEditor({ leftovers: ["mainText"] }), "mainText");
    expect(main).not.toContain('checked=""');
    expect(main).not.toContain("<textarea");
    // [Keep my text] would delete that size's text: never offered then (review CE1).
    const stale = listingSettingsProductOwnSettingsSchema.parse({ ...OWN_10B, own: { ...OWN_10B.own, mainText: { text: "Our own words.", needsCheck: true } } });
    const checked = part(descriptionEditor({ own: stale, leftovers: ["mainText"], detail: DETAIL_OWN_TEXT }), "mainText");
    expect(text(checked)).toContain("Card Shellz changed this product. Check your text still fits.");
    expect(checked).not.toContain(">Keep my text</button>");
    expect(checked).toContain(">Use Card Shellz text</button>");
  });

  it("asks for both parts while two older description rules tie (review CE4)", () => {
    const tie = listingSettingsProductDetailSchema.parse({ ...DETAIL, product: { ...DETAIL.product, fixes: ["description_group_conflict"] },
      settings: { ...DETAIL.settings, descriptionTemplate: [{ value: { hasIntroduction: false, hasFooter: false, groupConflict: true },
        sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A] }] }] },
      sizes: [{ price: sizePrice(), fixes: ["description_group_conflict"], stockUnits: 40 }] });
    const markup = descriptionEditor({ own: OWN, detail: tie });
    expect(text(markup)).toContain("Set both text above and text below, your own or None, to fix this.");
    expect(part(markup, "textAbove")).not.toContain('checked=""');
    expect(part(markup, "textBelow")).not.toContain('checked=""');
    expect(descriptionEditor({ own: OWN })).not.toContain("drawer-description-conflict");
  });
});

describe("OwnTextCheckNotice (5.4)", () => {
  it("offers Use Card Shellz text alone when there is no own text to keep", () => {
    const markup = render(React.createElement(OwnTextCheckNotice, {
      check: { keep: null, useCardShellz: { mode: "default" } }, productName: "Penny Sleeves", disabled: true, onAnswer: noop,
    }));
    expect(markup).not.toContain("Keep my text");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Use Card Shellz text<\/button>/);
  });
});
