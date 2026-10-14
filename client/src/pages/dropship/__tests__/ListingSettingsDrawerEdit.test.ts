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
  emptyChoices,
  policyFieldEditor,
  productSettingsDraftValue,
  type ProductSettingsChoices,
} from "@/lib/dropship-listing-settings-product-edit";
import { policyEditorChoices, type PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import type { DropshipEbayFulfillmentPolicyOption, DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import { DrawerFieldEditor, type DrawerFieldEditorProps } from "../listing-settings/DrawerFieldEditor";
import { DrawerSettingRow } from "../listing-settings/DrawerSettingRow";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { PolicyChoiceList } from "../listing-settings/PolicyChoiceList";
import { ProductDrawer, type ProductDrawerProps } from "../listing-settings/ProductDrawer";

/**
 * The drawer's policy editing (Listing settings PR 10, plan 4.3, 4.5, 4.9): [Change] only with a
 * right, the inline editor's policies with their Card Shellz fit and "Use default", and the drawer
 * with a draft of each kind (D2). Static renders: the step's one draft is set per test, since the
 * real provider can't start with one.
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
const RIGHTS: ProductDrawerProps["rights"] = { exactPrice: EDITABLE, productSettings: EDITABLE, shipping: EDITABLE, policies: EDITABLE };
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

/** The drawer on product 11 with its two reads answered, the given draft and rights. */
function renderDrawer(draft: ListingSettingsDraft | null, props: Partial<ProductDrawerProps> = {}): string {
  draftsValue(draft);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(listingSettingsProductQueryOptions(STORE, PRODUCT).queryKey, DETAIL);
  client.setQueryData(listingSettingsProductOwnQueryOptions(STORE, PRODUCT).queryKey, OWN);
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

const CHANGE_BUTTON = /<button[^>]*aria-label="Change [a-z ]+ for Penny Sleeves"[^>]*>Change<\/button>/g;

/** The radio's whole label that holds `words`: its input, and whether that input is checked. */
function labelWith(markup: string, words: string): string {
  const at = markup.indexOf(words);
  expect(at).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<label", at), markup.indexOf("</label>", at));
}

describe("Change on the drawer's policy rows (plan 4.10: Change when W5 allows; a new pick needs both rights)", () => {
  it("shows Change on the three policy rows when W5 and the eBay picks are allowed", () => {
    const markup = renderDrawer(null);
    expect(markup.match(CHANGE_BUTTON)).toHaveLength(3);
    for (const key of ["shippingPolicy", "returnPolicy", "paymentPolicy"]) {
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
    expect(markup.match(CHANGE_BUTTON)).toHaveLength(3);
    expect(text(rowOf(markup, "returnPolicy"))).toContain("Sign in to eBay again to pick a new one. You can still use the default.");
  });

  it("says only the default is left when a banner takes the new picks away and names no line of its own (D4)", () => {
    const banner: ListingSettingsRight = { editable: false, reason: "banner" };
    const markup = renderDrawer(null, { rights: { ...RIGHTS, shipping: banner, policies: banner } });
    expect(markup.match(CHANGE_BUTTON)).toHaveLength(3);
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
    expect(markup.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(3);
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
    expect(uncertainMarkup.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(3);
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

  it("has no button without a way to open its editor, and none on a row 10a doesn't edit", () => {
    expect(render(React.createElement(DrawerSettingRow, { row: rows[0] }))).not.toContain("<button");
    expect(render(React.createElement(DrawerSettingRow, { row: rows[3], productName: "Penny Sleeves", onChange: noop }))).not.toContain("<button");
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
