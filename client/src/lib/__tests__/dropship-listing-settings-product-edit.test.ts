import { describe, expect, it } from "vitest";
import { descriptionTextSchema } from "@shared/dropship/listing-content";
import { listingSettingTemplateTextSchema } from "@shared/dropship/listing-setting-values";
import { saveProductSettingsInputSchema } from "@shared/dropship/listing-setting-writes";
import { listingSettingsProductOwnSettingsSchema, type ListingSettingsProductDetail } from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  listingSettingsEditRights,
  type ListingSettingsReadState,
  type ListingSettingsRightsInput,
  type ListingSetupFacts,
} from "../dropship-listing-settings-access";
import {
  decideOpen,
  productEditorId,
  reduceListingSettingsDraft,
  type DraftValue,
  type ListingSettingsDraft,
} from "../dropship-listing-settings-drafts";
import { sizePriceDraftValue } from "../dropship-listing-settings-drawer";
import type { PolicySetupFacts } from "../dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";
import {
  PRODUCT_EDIT_FIELDS,
  ProductSettingsRequestError,
  changedFields,
  choicesFromOwn,
  decideDrawerEdit,
  descriptionEditorAnswer,
  descriptionEditorCheck,
  descriptionEditorResult,
  descriptionFieldEditor,
  drawerChangeKind,
  ebayCategoryChoiceLabel,
  ebayCategoryChoiceReady,
  ebayCategoryFieldEditor,
  ebayCategoryPick,
  emptyChoices,
  emptyProductPriceChange,
  fieldChoiceReady,
  isPriceCheckRef,
  isProductPriceChanged,
  mainTextProblem,
  markedAfterReload,
  normalizedVendorText,
  ownTextCheckChoices,
  policyFieldEditor,
  productFieldRights,
  productPriceBaseMoved,
  productPriceBaseOf,
  productPriceDraftValue,
  productPriceDraftWithCheck,
  productPriceEditAction,
  productPriceRights,
  productSettingsDraftValue,
  productSettingsEditAction,
  productSettingsPatch,
  productSettingsSaveBody,
  productSettingsSignature,
  readProductPriceDraft,
  readProductSettingsDraft,
  rebaseProductPriceDraft,
  rebaseProductSettingsDraft,
  sizeLeftoverFields,
  sizesDifferPick,
  storeShelfEditorChoice,
  storeShelfFieldEditor,
  templateTextProblem,
  textCounter,
  type DrawerChangeKind,
  type FieldChoice,
  type SizesDifferSetting,
  type PolicyEditField,
  type ProductOwnSettings,
  type ProductSettingsChoices,
} from "../dropship-listing-settings-product-edit";

/** Editing a product's own settings (plan PR 10, 4.4). Fixtures are parsed by the shared contract. */

const STORE = 22;
const PRODUCT = 11;
const EDITOR = productEditorId(PRODUCT);

function own(overrides: Partial<ProductOwnSettings["own"]> = {}, revisionId: number | null = 5): ProductOwnSettings {
  return listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: STORE,
    productId: PRODUCT,
    revisionId,
    own: {
      price: null, ebayCategory: null, storeShelf: null,
      shippingPolicy: { id: "F2", name: "Fast Free" }, returnPolicy: null, paymentPolicy: { id: "P1", name: null },
      textAbove: null, textBelow: null, mainText: null,
      ...overrides,
    },
    generatedAt: "2026-10-14T12:00:00.000Z",
  });
}

const OWN = own();
const NONE_OWN = listingSettingsProductOwnSettingsSchema.parse({
  storeConnectionId: STORE, productId: PRODUCT, revisionId: null,
  own: { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null },
  generatedAt: "2026-10-14T12:00:00.000Z",
});

const choices = (overrides: Partial<ProductSettingsChoices>): ProductSettingsChoices => ({ ...emptyChoices(), ...overrides });

/** A settings draft opened on `base`, then edited to `value`. Every step frozen, so a mutation would throw. */
function draftOf(base: DraftValue, value: DraftValue = base): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: Object.freeze(base) });
  return Object.freeze(reduceListingSettingsDraft(Object.freeze(opened!), { type: "edit", value: Object.freeze(value) })!);
}

const setupChecked: ListingSetupFacts = {
  access: { canEdit: true, reason: null },
  revision: 4,
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  missingFields: [],
};

function rights(overrides: Partial<ListingSettingsRightsInput> = {}) {
  return listingSettingsEditRights({
    account: { status: "active", entitlementStatus: "active" },
    summary: { storeStatus: "connected", catalog: { state: "ok", products: 3, sizes: 9 } },
    setup: { data: setupChecked, error: null },
    shelves: { data: { categories: [] }, error: null },
    blocked: null,
    ...overrides,
  });
}

describe("choices", () => {
  it("edits the three policies (10a), then the eBay category, the shelf and the description's parts (10b), in the drawer's order", () => {
    expect(PRODUCT_EDIT_FIELDS).toEqual(["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "textAbove", "textBelow", "mainText"]);
    expect(changedFields(emptyChoices())).toEqual([]);
    expect(changedFields(choices({ paymentPolicy: { mode: "default" }, shippingPolicy: { mode: "set", value: { id: "F9" } } })))
      .toEqual(["shippingPolicy", "paymentPolicy"]);
  });

  it("opens an editor on what the product has now, ids only, without touching the read", () => {
    const read = Object.freeze({ ...OWN, own: Object.freeze({ ...OWN.own }) });
    expect(choicesFromOwn(read)).toEqual({
      shippingPolicy: { mode: "set", value: { id: "F2" } },
      returnPolicy: { mode: "default" },
      paymentPolicy: { mode: "set", value: { id: "P1" } },
      ebayCategory: { mode: "default" }, storeShelf: { mode: "default" },
      textAbove: { mode: "default" }, textBelow: { mode: "default" }, mainText: { mode: "default" },
    });
    expect(Object.values(choicesFromOwn(NONE_OWN)).every((choice) => choice.mode === "default")).toBe(true);
  });
});

describe("productSettingsPatch and productSettingsSaveBody (D1)", () => {
  it("leaves out what is left, sends null for the default and the id alone for a pick", () => {
    expect(productSettingsPatch(emptyChoices())).toEqual({});
    const patch = productSettingsPatch(choices({ shippingPolicy: { mode: "set", value: { id: "F9" } }, returnPolicy: { mode: "default" } }));
    expect(patch).toEqual({ shippingPolicy: { id: "F9" }, returnPolicy: null });
    expect(Object.keys(patch)).not.toContain("paymentPolicy");
  });

  it("builds the body the shared schema accepts, with ids only and never a price", () => {
    const body = productSettingsSaveBody({ key: "ls-product:1", expectedRevisionId: 5, patch: { shippingPolicy: { id: "F9" }, returnPolicy: null } });
    expect(body).toEqual({ idempotencyKey: "ls-product:1", expectedRevisionId: 5, patch: { shippingPolicy: { id: "F9" }, returnPolicy: null } });
    expect(saveProductSettingsInputSchema.safeParse(body).success).toBe(true);
    const text = JSON.stringify(body);
    for (const never of ["sizePrices", "expectedPrices", "price", "mainText", "name", "Fast Free"]) expect(text).not.toContain(never);
    // A product with no settings row yet sends a null revision.
    expect(productSettingsSaveBody({ key: "ls-product:2", expectedRevisionId: null, patch: { paymentPolicy: null } }).expectedRevisionId).toBeNull();
  });

  it("throws on an empty patch, a field the drawer doesn't save, or a body the schema refuses", () => {
    const build = (patch: object, key = "ls-product:1") => () => productSettingsSaveBody({ key, expectedRevisionId: 5, patch });
    expect(build({})).toThrow(ProductSettingsRequestError);
    expect(build({ shippingPolicy: undefined })).toThrow("There is no change to save.");
    expect(build({ price: null })).toThrow(/doesn't save/);
    expect(build({ price: null, mainText: { text: "Mine" } })).toThrow(/doesn't save/);
    expect(build({ shippingPolicy: { id: "" } })).toThrow(/can't be sent/);
    expect(build({ shippingPolicy: { id: "x".repeat(101) } })).toThrow(ProductSettingsRequestError);
    expect(build({ shippingPolicy: { id: "F9", name: "Fast" } })).toThrow(ProductSettingsRequestError);
    expect(build({ shippingPolicy: { id: "F9" } }, "short")).toThrow(ProductSettingsRequestError);
    try {
      build({ price: null })();
    } catch (error) {
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_REQUEST_INVALID", context: { fields: ["price"] } });
    }
  });
});

describe("productSettingsSignature", () => {
  const patch = { shippingPolicy: { id: "F9" }, returnPolicy: null };

  it("is the same for the same request whatever the key order", () => {
    expect(productSettingsSignature(STORE, PRODUCT, 5, patch)).toBe(productSettingsSignature(STORE, PRODUCT, 5, { returnPolicy: null, shippingPolicy: { id: "F9" } }));
    expect(productSettingsSignature(STORE, PRODUCT, 5, { ...patch, paymentPolicy: undefined })).toBe(productSettingsSignature(STORE, PRODUCT, 5, patch));
  });

  it("differs by revision, store, product and value, and tells null from absent", () => {
    const signature = productSettingsSignature(STORE, PRODUCT, 5, patch);
    for (const other of [
      productSettingsSignature(STORE, PRODUCT, 6, patch),
      productSettingsSignature(STORE, PRODUCT, null, patch),
      productSettingsSignature(23, PRODUCT, 5, patch),
      productSettingsSignature(STORE, 12, 5, patch),
      productSettingsSignature(STORE, PRODUCT, 5, { ...patch, shippingPolicy: { id: "F8" } }),
      productSettingsSignature(STORE, PRODUCT, 5, { shippingPolicy: { id: "F9" } }),
      productSettingsSignature(STORE, PRODUCT, 5, { ...patch, paymentPolicy: null }),
    ]) {
      expect(other).not.toBe(signature);
    }
  });
});

describe("the drawer's draft and its kinds of change (D2)", () => {
  const base = productSettingsDraftValue(OWN);
  const twoChanges = productSettingsDraftValue(OWN, choices({ returnPolicy: { mode: "set", value: { id: "R4" } }, paymentPolicy: { mode: "default" } }));

  it("counts each changed setting as one change in the bar", () => {
    expect(base).toEqual({ ...emptyChoices(), own: OWN.own, expectedRevisionId: 5 });
    expect(draftOf(base, twoChanges).changes).toBe(2);
    // Back to what is saved: nothing to save.
    expect(draftOf(base, productSettingsDraftValue(OWN, choices({ shippingPolicy: { mode: "set", value: { id: "F2" } }, returnPolicy: { mode: "default" } }))).changes).toBe(0);
  });

  it("reads a settings value, and nothing else, as one", () => {
    expect(readProductSettingsDraft(twoChanges)).toEqual(twoChanges);
    expect(readProductSettingsDraft(sizePriceDraftValue({ productVariantId: 101, expectedRevisionId: 7, exact: "12.00" }))).toBeNull();
    expect(readProductSettingsDraft({ ...base, expectedRevisionId: 0 })).toBeNull();
    expect(readProductSettingsDraft({ ...base, shippingPolicy: { mode: "set", value: { id: "" } } })).toBeNull();
    expect(readProductSettingsDraft({ ...base, own: null })).toBeNull();
  });

  it("says which kind of change the product's draft holds", () => {
    const size = sizePriceDraftValue({ productVariantId: 101, expectedRevisionId: 7, exact: "14.99" });
    expect(drawerChangeKind(null, EDITOR)).toBe("none");
    expect(drawerChangeKind(draftOf(base), EDITOR)).toBe("none");
    expect(drawerChangeKind(draftOf(base, twoChanges), EDITOR)).toBe("settings");
    expect(drawerChangeKind(draftOf(size, { ...size, exact: "12.00" }), EDITOR)).toBe("size_price");
    const price = productPriceDraftValue(OWN, { price: { mode: "default" }, releaseExactPrices: true, check: null });
    expect(drawerChangeKind(draftOf(productPriceDraftValue(OWN), price), EDITOR)).toBe("product_price");
    expect(drawerChangeKind(draftOf(base, twoChanges), productEditorId(12))).toBe("none");
    // A save that is out or unconfirmed still holds its change.
    const saving = reduceListingSettingsDraft(draftOf(base, twoChanges), { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(drawerChangeKind(saving, EDITOR)).toBe("settings");
  });

  it("lets one kind of change wait for the other (D2)", () => {
    const cases: Array<[DrawerChangeKind, DrawerChangeKind, "edit" | "finish_first"]> = [
      ["none", "settings", "edit"], ["none", "size_price", "edit"],
      ["settings", "settings", "edit"], ["size_price", "size_price", "edit"],
      ["settings", "size_price", "finish_first"], ["size_price", "settings", "finish_first"],
    ];
    for (const [current, wanted, decision] of cases) expect({ current, wanted, decision: decideDrawerEdit(current, wanted) }).toEqual({ current, wanted, decision });
  });
});

describe("productSettingsEditAction ([Done])", () => {
  const pick = (id: string) => ({ mode: "set", value: { id } }) as const;

  it("starts a new draft on the own read, with its revision", () => {
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: OWN, field: "shippingPolicy", choice: pick("F9") });
    expect(action).toEqual({
      kind: "start",
      base: { ...emptyChoices(), own: OWN.own, expectedRevisionId: 5 },
      value: { ...emptyChoices(), shippingPolicy: pick("F9"), own: OWN.own, expectedRevisionId: 5 },
    });
  });

  it("adds to a settings draft that holds changes, keeping the revision the vendor saw", () => {
    const held = draftOf(productSettingsDraftValue(OWN), productSettingsDraftValue(OWN, choices({ shippingPolicy: pick("F9") })));
    const action = productSettingsEditAction({ draft: held, editor: EDITOR, own: own({}, 6), field: "returnPolicy", choice: pick("R4") });
    expect(action).toMatchObject({ kind: "edit", reopen: false, value: { shippingPolicy: pick("F9"), returnPolicy: pick("R4"), expectedRevisionId: 5 } });
    const hidden = reduceListingSettingsDraft(held, { type: "close" })!;
    expect(productSettingsEditAction({ draft: hidden, editor: EDITOR, own: OWN, field: "returnPolicy", choice: pick("R4") })).toMatchObject({ kind: "edit", reopen: true });
  });

  it("puts nothing in the draft for a choice that asks for what is saved: no draft opens, nothing is asked", () => {
    expect(productSettingsEditAction({ draft: null, editor: EDITOR, own: OWN, field: "shippingPolicy", choice: pick("F2") })).toEqual({ kind: "no_change" });
    expect(productSettingsEditAction({ draft: null, editor: EDITOR, own: OWN, field: "returnPolicy", choice: { mode: "default" } })).toEqual({ kind: "no_change" });
    // Over another editor's changes it asks nothing about them (decideOpen would ask), and a saved size's flash stays.
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: "price", place: "Store defaults", base: { recipe: "a" } });
    const storeDefault = reduceListingSettingsDraft(opened, { type: "edit", value: { recipe: "b" } })!;
    expect(decideOpen(storeDefault, EDITOR)).toBe("ask");
    expect(productSettingsEditAction({ draft: storeDefault, editor: EDITOR, own: OWN, field: "shippingPolicy", choice: pick("F2") })).toEqual({ kind: "no_change" });
    // While a size's price waits too: nothing is started, so nothing waits.
    const size = sizePriceDraftValue({ productVariantId: 101, expectedRevisionId: 7, exact: "14.99" });
    expect(productSettingsEditAction({ draft: draftOf(size, { ...size, exact: "12.00" }), editor: EDITOR, own: OWN, field: "returnPolicy", choice: { mode: "default" } }))
      .toEqual({ kind: "no_change" });
    // In a settings draft that holds changes, the same choice takes its field back to no change.
    const held = draftOf(productSettingsDraftValue(OWN), productSettingsDraftValue(OWN, choices({ shippingPolicy: pick("F9"), returnPolicy: pick("R4") })));
    const back = productSettingsEditAction({ draft: held, editor: EDITOR, own: OWN, field: "shippingPolicy", choice: pick("F2") });
    expect(back.kind === "edit" && changedFields(back.value)).toEqual(["returnPolicy"]);
  });

  it("keeps the product's own value a change while a size still sets the field for itself", () => {
    // NONE_OWN: no own return policy; a size's leftover sets one, so the row reads "Set on this size".
    const defaultBack = productSettingsEditAction({ draft: null, editor: EDITOR, own: NONE_OWN, leftovers: ["returnPolicy"], field: "returnPolicy", choice: { mode: "default" } });
    expect(defaultBack).toMatchObject({ kind: "start", value: { returnPolicy: { mode: "default" } } });
    expect(defaultBack.kind === "start" && productSettingsPatch(defaultBack.value)).toEqual({ returnPolicy: null });
    // Picking the product's own policy again clears the sizes' leftovers too.
    const sameAgain = productSettingsEditAction({ draft: null, editor: EDITOR, own: OWN, leftovers: ["shippingPolicy"], field: "shippingPolicy", choice: pick("F2") });
    expect(sameAgain.kind === "start" && productSettingsPatch(sameAgain.value)).toEqual({ shippingPolicy: { id: "F2" } });
    // A leftover on another field changes nothing here.
    expect(productSettingsEditAction({ draft: null, editor: EDITOR, own: NONE_OWN, leftovers: ["shippingPolicy"], field: "returnPolicy", choice: { mode: "default" } }))
      .toEqual({ kind: "no_change" });
    // In a draft that holds changes, and in the value it starts from.
    const held = draftOf(productSettingsDraftValue(NONE_OWN), productSettingsDraftValue(NONE_OWN, choices({ shippingPolicy: pick("F9") })));
    expect(productSettingsEditAction({ draft: held, editor: EDITOR, own: NONE_OWN, leftovers: ["paymentPolicy"], field: "paymentPolicy", choice: { mode: "default" } }))
      .toMatchObject({ kind: "edit", value: { shippingPolicy: pick("F9"), paymentPolicy: { mode: "default" } } });
    expect(productSettingsDraftValue(NONE_OWN, choices({ returnPolicy: { mode: "default" } }), ["returnPolicy"]).returnPolicy).toEqual({ mode: "default" });
    expect(productSettingsDraftValue(NONE_OWN, choices({ returnPolicy: { mode: "default" } })).returnPolicy).toEqual({ mode: "leave" });
  });

  it("finds the fields a size still sets for itself in the product's settings in full", () => {
    type Settings = Pick<ListingSettingsProductDetail["settings"], "shippingPolicy" | "returnPolicy" | "paymentPolicy" | "storeShelf" | "mainText">;
    const entry = (policyId: string, source: "size" | "product" | "category" | "store_default", ids: number[]) =>
      ({ value: { policyId }, sources: [{ source, ruleName: source === "category" ? "Sleeves" : null, productVariantIds: ids }] });
    const settings: Settings = {
      shippingPolicy: [entry("F1", "store_default", [101, 102])],
      returnPolicy: [entry("R1", "product", [101]), entry("R9", "size", [102])],
      paymentPolicy: [{ value: { policyId: "P1" }, sources: [
        { source: "product", ruleName: null, productVariantIds: [101] }, { source: "size", ruleName: null, productVariantIds: [102] }] }],
      storeShelf: [{ value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [101, 102] }] }],
      mainText: [{ value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [101, 102] }] }],
    };
    expect(sizeLeftoverFields(settings)).toEqual(["returnPolicy", "paymentPolicy"]);
    expect(sizeLeftoverFields({ ...settings, returnPolicy: [entry("R1", "category", [101, 102])], paymentPolicy: [entry("P1", "product", [101, 102])] }))
      .toEqual([]);
    // 10b: a size's own shelf or main text is a leftover too (the eBay category and the text above and below have no per-size table).
    expect(sizeLeftoverFields({
      ...settings,
      storeShelf: [{ value: { names: ["Toploaders"] }, sources: [{ source: "size", ruleName: null, productVariantIds: [102] }] },
        { value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [101] }] }],
      mainText: [{ value: { own: true }, sources: [{ source: "size", ruleName: null, productVariantIds: [101] }] },
        { value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [102] }] }],
    })).toEqual(["returnPolicy", "paymentPolicy", "storeShelf", "mainText"]);
  });

  it("waits for a size's price, and for a save that is out or unconfirmed", () => {
    const size = sizePriceDraftValue({ productVariantId: 101, expectedRevisionId: 7, exact: "14.99" });
    const sizeDraft = draftOf(size, { ...size, exact: "12.00" });
    expect(productSettingsEditAction({ draft: sizeDraft, editor: EDITOR, own: OWN, field: "shippingPolicy", choice: pick("F9") })).toEqual({ kind: "finish_first" });
    const held = draftOf(productSettingsDraftValue(OWN), productSettingsDraftValue(OWN, choices({ shippingPolicy: pick("F9") })));
    const saving = reduceListingSettingsDraft(held, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(productSettingsEditAction({ draft: saving, editor: EDITOR, own: OWN, field: "returnPolicy", choice: pick("R4") })).toEqual({ kind: "locked" });
    // An unchanged size draft (or a saved one) is no change: a settings edit starts over it.
    expect(productSettingsEditAction({ draft: draftOf(size), editor: EDITOR, own: OWN, field: "returnPolicy", choice: pick("R4") }).kind).toBe("start");
    // A save of the settings that is out or unconfirmed is locked even for a choice that changes nothing.
    expect(productSettingsEditAction({ draft: saving, editor: EDITOR, own: OWN, field: "shippingPolicy", choice: pick("F2") })).toEqual({ kind: "locked" });
  });
});

describe("productFieldRights (D3, D4, CC-C16)", () => {
  it("lets every field be set and reset when every right is there; None only for the shelf and the text above and below", () => {
    for (const field of PRODUCT_EDIT_FIELDS) {
      const canNone = field === "storeShelf" || field === "textAbove" || field === "textBelow";
      expect({ field, rights: productFieldRights(rights(), field) }).toEqual({ field, rights: { canSet: true, canDefault: true, canNone, reason: null } });
    }
  });

  it("leaves only Use default (and None) under a sign-in or an eBay refusal, for every field that picks an eBay value (D4)", () => {
    const signIn = rights({ summary: { storeStatus: "needs_reauth", catalog: { state: "ok", products: 3, sizes: 9 } } });
    const signInCode = rights({ blocked: { kind: "sign_in", diagnosticReference: null } });
    const denied = rights({ setup: { error: new DropshipApiError({ message: "x", status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED" }) } });
    for (const field of ["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf"] as const) {
      const canNone = field === "storeShelf";
      expect(productFieldRights(signIn, field)).toEqual({ canSet: false, canDefault: true, canNone, reason: "sign_in" });
      expect(productFieldRights(signInCode, field)).toEqual({ canSet: false, canDefault: true, canNone, reason: "sign_in" });
      expect(productFieldRights(denied, field)).toMatchObject({ canSet: false, canDefault: true, canNone });
    }
    // Own text names no eBay value: a sign-in leaves it whole.
    for (const field of ["textAbove", "textBelow", "mainText"] as const) {
      expect(productFieldRights(signIn, field)).toEqual({ canSet: true, canDefault: true, canNone: field !== "mainText", reason: null });
    }
  });

  it("leaves Use default while eBay or Card Shellz shipping can't be read, which a pick needs", () => {
    const down = rights({ setup: { error: new DropshipApiError({ message: "x", status: 502, code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE" }) } });
    expect(productFieldRights(down, "returnPolicy")).toEqual({ canSet: false, canDefault: true, canNone: false, reason: "unreachable" });
    const loading = rights({ setup: { data: undefined, error: null } });
    expect(productFieldRights(loading, "paymentPolicy")).toEqual({ canSet: false, canDefault: true, canNone: false, reason: "checking_ebay" });
    const shipping = rights({ setup: { data: { ...setupChecked, checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "R", kind: "setup_incomplete" } } } } });
    expect(productFieldRights(shipping, "shippingPolicy")).toEqual({ canSet: false, canDefault: true, canNone: false, reason: "shipping_setup" });
    expect(productFieldRights(shipping, "returnPolicy")).toEqual({ canSet: true, canDefault: true, canNone: false, reason: null });
    // 10b: a shelf needs the setup and the shelves read; the eBay category picker reads eBay itself (W3's right).
    expect(productFieldRights(down, "storeShelf")).toEqual({ canSet: false, canDefault: true, canNone: true, reason: "unreachable" });
    expect(productFieldRights(down, "ebayCategory")).toEqual({ canSet: true, canDefault: true, canNone: false, reason: null });
    const shelvesLoading = rights({ shelves: { data: undefined, error: null } });
    expect(productFieldRights(shelvesLoading, "storeShelf")).toEqual({ canSet: false, canDefault: true, canNone: true, reason: "checking_ebay" });
    expect(productFieldRights(shelvesLoading, "textAbove")).toEqual({ canSet: true, canDefault: true, canNone: true, reason: null });
  });

  it("blocks every field for a paused vendor, inactive .ops, a blocked store or too many sizes (C16)", () => {
    const cells = [
      rights({ account: { status: "paused", entitlementStatus: "active" } }),
      rights({ account: { status: "active", entitlementStatus: "lapsed" } }),
      rights({ account: { status: "closed", entitlementStatus: "active" } }),
      rights({ summary: { storeStatus: "paused", catalog: { state: "ok", products: 3, sizes: 9 } } }),
      rights({ summary: { storeStatus: "disconnected", catalog: { state: "ok", products: 3, sizes: 9 } } }),
      rights({ summary: { storeStatus: "connected", catalog: { state: "too_large", limit: 10_000 } } }),
      rights({ blocked: { kind: "other_site", diagnosticReference: null } }),
    ];
    for (const cell of cells) {
      for (const field of PRODUCT_EDIT_FIELDS) {
        expect({ field, rights: productFieldRights(cell, field) }).toEqual({ field, rights: { canSet: false, canDefault: false, canNone: false, reason: "banner" } });
      }
    }
    // The paused vendor's store shelf right stays on for W2, but a product's shelf stays off (C16, D3).
    expect(cells[0].shelfPick.editable).toBe(true);
    expect(productFieldRights(cells[0], "storeShelf")).toEqual({ canSet: false, canDefault: false, canNone: false, reason: "banner" });
    expect(productFieldRights(rights({ account: null }), "shippingPolicy")).toEqual({ canSet: false, canDefault: false, canNone: false, reason: "loading" });
  });
});

describe("Load latest and keep my changes (R:542, C20)", () => {
  it("marks only the fields the vendor changed that another window moved", () => {
    const after = own({ shippingPolicy: { id: "F3", name: "Faster" }, returnPolicy: { id: "R1", name: "30 days" } }, 6);
    expect(markedAfterReload(OWN, after, ["shippingPolicy", "paymentPolicy"])).toEqual(["shippingPolicy"]);
    expect(markedAfterReload(OWN, after, ["returnPolicy"])).toEqual(["returnPolicy"]);
    expect(markedAfterReload(OWN, after, [])).toEqual([]);
    // A rename is the same policy.
    expect(markedAfterReload(OWN, own({ shippingPolicy: { id: "F2", name: "Renamed" } }, 6), ["shippingPolicy"])).toEqual([]);
  });

  it("puts the vendor's choices on the latest read, with its revision, and marks what both changed", () => {
    const mine = productSettingsDraftValue(OWN, choices({ shippingPolicy: { mode: "set", value: { id: "F9" } }, returnPolicy: { mode: "set", value: { id: "R4" } } }));
    const latest = own({ shippingPolicy: { id: "F3", name: "Faster" }, returnPolicy: { id: "R4", name: "60 days" } }, 6);
    const next = rebaseProductSettingsDraft(mine, latest);
    // R4 is saved now, so it is no longer a change; the shipping policy both changed is marked.
    expect(next.edited).toEqual({ ...emptyChoices(), shippingPolicy: { mode: "set", value: { id: "F9" } }, own: latest.own, expectedRevisionId: 6 });
    expect(next.latest).toEqual({ ...emptyChoices(), own: latest.own, expectedRevisionId: 6 });
    expect(next.marked).toEqual(["shippingPolicy"]);
    expect(next.keeps).toBe(true);

    let draft = draftOf(productSettingsDraftValue(OWN), mine);
    draft = reduceListingSettingsDraft(draft, { type: "edit", value: next.edited })!;
    draft = reduceListingSettingsDraft(draft, { type: "rebase", latest: next.latest, marked: next.marked })!;
    expect(draft).toMatchObject({ changes: 1, marked: ["shippingPolicy"], phase: "editing", attempt: null });
    expect(readProductSettingsDraft(draft.value)?.expectedRevisionId).toBe(6);
  });

  it("keeps nothing when another window saved the same choices, unless a size's leftover keeps one a change", () => {
    const mine = productSettingsDraftValue(OWN, choices({ shippingPolicy: { mode: "set", value: { id: "F9" } } }));
    const latest = own({ shippingPolicy: { id: "F9", name: "Fastest" } }, 6);
    const next = rebaseProductSettingsDraft(mine, latest);
    expect(next).toMatchObject({ keeps: false, marked: [] });
    expect(changedFields(next.edited)).toEqual([]);
    // A size still sets its own shipping policy: the pick still clears it, so it is kept.
    const leftover = rebaseProductSettingsDraft(mine, latest, ["shippingPolicy"]);
    expect(leftover).toMatchObject({ keeps: true, edited: { shippingPolicy: { mode: "set", value: { id: "F9" } }, expectedRevisionId: 6 } });
  });
});

describe("a policy row's editor (plan 4.5, D4)", () => {
  const setup: PolicySetupFacts = {
    selection: { merchantLocationKey: "cs", fulfillmentPolicyId: "F1", returnPolicyId: null, paymentPolicyId: "P1" },
    storedNames: { fulfillmentPolicyName: "Standard", returnPolicyName: null, paymentPolicyName: "eBay payments" },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [
        { id: "F1", name: "Standard", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
        { id: "F2", name: "Fast Free", compatible: false, compatibilityChecked: true, compatibilityIssues: [{ code: "handling_time_too_short", message: "x" }] },
      ],
      returnPolicies: [],
      paymentPolicies: [{ id: "P1", name: "eBay payments" }, { id: "P2", name: "Other" }],
    },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    fulfillmentCapability: null,
  };
  const both = { canSet: true, canDefault: true };
  const editor = (field: PolicyEditField, overrides: Partial<Parameters<typeof policyFieldEditor>[0]> = {}) =>
    policyFieldEditor({ field, rights: both, draftChoice: { mode: "leave" }, own: OWN, setup: { data: setup, error: null }, ...overrides });

  it("lists eBay's policies of the row's kind, in eBay's order, each shipping policy with its fit", () => {
    const shipping = editor("shippingPolicy");
    expect(shipping.kind).toBe("shipping");
    expect(shipping.choices?.map((choice) => [choice.id, choice.choosable, choice.fit?.fit ?? null])).toEqual([["F1", true, "works"], ["F2", false, "cant_use"]]);
    expect(editor("paymentPolicy").choices?.map((choice) => [choice.id, choice.fit])).toEqual([["P1", null], ["P2", null]]);
    expect(shipping.emptyLine).toBeNull();
  });

  it("opens on the draft's change, else the product's own policy, else Use default; never mutates", () => {
    expect(editor("shippingPolicy").initial).toEqual({ mode: "set", value: { id: "F2" } });
    expect(editor("returnPolicy").initial).toEqual({ mode: "default" });
    // A size's leftover makes the row read otherwise: nothing is picked until the vendor picks; a draft's change still shows.
    expect(editor("returnPolicy", { leftover: true }).initial).toEqual({ mode: "leave" });
    expect(editor("shippingPolicy", { leftover: true }).initial).toEqual({ mode: "leave" });
    expect(editor("returnPolicy", { leftover: true, draftChoice: { mode: "default" } }).initial).toEqual({ mode: "default" });
    expect(editor("paymentPolicy", { draftChoice: { mode: "default" } }).initial).toEqual({ mode: "default" });
    const frozen = Object.freeze({ own: Object.freeze({ ...OWN.own }) });
    expect(editor("paymentPolicy", { own: frozen }).initial).toEqual({ mode: "set", value: { id: "P1" } });
  });

  it("offers no list when a new policy can't be picked, or eBay's answer is not the latest read's", () => {
    expect(editor("shippingPolicy", { rights: { canSet: false, canDefault: true } }).choices).toBeNull();
    expect(editor("shippingPolicy", { setup: { data: setup, error: new Error("refetch failed") } }).choices).toBeNull();
    expect(editor("shippingPolicy", { setup: { data: undefined, error: null } }).choices).toBeNull();
    expect(editor("shippingPolicy", { setup: { data: { ...setup, checks: { ebay: "not_checked", fulfillment: { status: "checked" } } }, error: null } }).choices).toBeNull();
  });

  it("says when eBay has no policy of the kind", () => {
    const returns = editor("returnPolicy");
    expect(returns.choices).toEqual([]);
    expect(returns.emptyLine).toBe("You don't have a return policy on eBay yet. Make one in eBay Seller Hub, then check again.");
  });

  it("takes a usable listed policy or Use default when allowed, never leave or a policy it can't use", () => {
    const shipping = editor("shippingPolicy");
    expect(fieldChoiceReady(shipping, { mode: "set", value: { id: "F1" } })).toBe(true);
    expect(fieldChoiceReady(shipping, { mode: "set", value: { id: "F2" } })).toBe(false);
    expect(fieldChoiceReady(shipping, { mode: "set", value: { id: "GONE" } })).toBe(false);
    expect(fieldChoiceReady(shipping, { mode: "default" })).toBe(true);
    expect(fieldChoiceReady(shipping, { mode: "leave" })).toBe(false);
    const signIn = editor("shippingPolicy", { rights: { canSet: false, canDefault: true } });
    expect(fieldChoiceReady(signIn, { mode: "set", value: { id: "F1" } })).toBe(false);
    expect(fieldChoiceReady(signIn, { mode: "default" })).toBe(true);
    expect(fieldChoiceReady(editor("shippingPolicy", { rights: { canSet: false, canDefault: false } }), { mode: "default" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10b: the eBay category, the store shelf and the text (plan 5.2-5.6)
// ---------------------------------------------------------------------------

/** A product with every 10b value of its own; its main text was checked against the product as it is. */
const FULL = own({
  ebayCategory: { categoryId: "183454", categoryName: "Card Sleeves" },
  storeShelf: { mode: "own", shelves: [{ id: "S1", name: "Sleeves" }, { id: "S2", name: "Sleeves:Standard" }] },
  textAbove: { mode: "own", text: "Ships in 1 day." },
  textBelow: { mode: "none" },
  mainText: { text: "Our own words.", needsCheck: false },
});
/** The same product after Card Shellz changed it: its own main text needs a check. */
const STALE = own({ ...FULL.own, mainText: { text: "Our own words.", needsCheck: true } });

describe("10b's choices, patch and draft (plan 5.2, 5.4, 5.6)", () => {
  it("opens on the product's own values, its shelves by id", () => {
    expect(choicesFromOwn(FULL)).toMatchObject({
      ebayCategory: { mode: "set", value: { categoryId: "183454", categoryName: "Card Sleeves" } },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S1", "S2"] } },
      textAbove: { mode: "set", value: { mode: "own", text: "Ships in 1 day." } },
      textBelow: { mode: "set", value: { mode: "none" } },
      mainText: { mode: "set", value: { text: "Our own words." } },
    });
    expect(choicesFromOwn(own({ storeShelf: { mode: "none" } })).storeShelf).toEqual({ mode: "set", value: { mode: "none" } });
  });

  it("builds the patch with ids and text only: the category's number alone, shelves in order, None as none, the default as null", () => {
    const patch = productSettingsPatch(choices({
      ebayCategory: { mode: "set", value: { categoryId: "261328", categoryName: "Toploaders" } },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S2", "S1"] } },
      textAbove: { mode: "set", value: { mode: "none" } },
      textBelow: { mode: "default" },
      mainText: { mode: "set", value: { text: "Mine." } },
    }));
    expect(patch).toEqual({
      ebayCategory: { categoryId: "261328" }, storeShelf: { mode: "own", shelfIds: ["S2", "S1"] },
      textAbove: { mode: "none" }, textBelow: null, mainText: { text: "Mine." },
    });
    expect(JSON.stringify(patch)).not.toMatch(/Toploaders|catalogHash|name|price/);
    expect(productSettingsPatch(choices({ storeShelf: { mode: "set", value: { mode: "none" } } }))).toEqual({ storeShelf: { mode: "none" } });
    const body = productSettingsSaveBody({ key: "ls-product:3", expectedRevisionId: 5, patch });
    expect(saveProductSettingsInputSchema.safeParse(body).success).toBe(true);
    // Shelf order is part of the request: first, then second.
    expect(productSettingsSignature(STORE, PRODUCT, 5, patch))
      .not.toBe(productSettingsSignature(STORE, PRODUCT, 5, { ...patch, storeShelf: { mode: "own", shelfIds: ["S1", "S2"] } }));
  });

  it("refuses over-limit or empty text, a shelf twice and a sent name before anything is sent (5.4)", () => {
    const build = (patch: object) => () => productSettingsSaveBody({ key: "ls-product:1", expectedRevisionId: 5, patch });
    expect(build({ textAbove: { mode: "own", text: "x".repeat(4_001) } })).toThrow(ProductSettingsRequestError);
    expect(build({ textAbove: { mode: "own", text: `${"x".repeat(3_999)}  ` } })).toThrow(ProductSettingsRequestError);
    expect(build({ textBelow: { mode: "own", text: "   " } })).toThrow(ProductSettingsRequestError);
    expect(build({ mainText: { text: "x".repeat(20_001) } })).toThrow(ProductSettingsRequestError);
    expect(build({ storeShelf: { mode: "own", shelfIds: ["S1", "S1"] } })).toThrow(ProductSettingsRequestError);
    expect(build({ storeShelf: { mode: "own", shelfIds: ["S1", "S2", "S3"] } })).toThrow(ProductSettingsRequestError);
    expect(build({ ebayCategory: { categoryId: "261328", categoryName: "Toploaders" } })).toThrow(ProductSettingsRequestError);
    expect(build({ mainText: { text: "Mine.", catalogHash: "a".repeat(64) } })).toThrow(ProductSettingsRequestError);
    // Over as typed with a CRLF, though it would store at the limit (review T1).
    expect(build({ textAbove: { mode: "own", text: CRLF_4001 } })).toThrow(ProductSettingsRequestError);
    expect(build({ mainText: { text: CRLF_20001 } })).toThrow(ProductSettingsRequestError);
    // At the limits it is sent, and text goes as the server stores it (line breaks as \n, trimmed).
    expect(build({ textAbove: { mode: "own", text: "x".repeat(4_000) } })().patch.textAbove).toEqual({ mode: "own", text: "x".repeat(4_000) });
    expect(build({ mainText: { text: "x".repeat(20_000) } })().patch.mainText).toEqual({ text: "x".repeat(20_000) });
    expect(build({ textBelow: { mode: "own", text: CRLF_4000 } })().patch.textBelow).toEqual({ mode: "own", text: CRLF_4000.replace("\r\n", "\n") });
    expect(build({ mainText: { text: " a\r\nb " } })().patch.mainText).toEqual({ text: "a\nb" });
  });

  it("counts typed text that is what is saved as no change, but another shelf order or text as one", () => {
    const base = productSettingsDraftValue(FULL);
    const same = productSettingsDraftValue(FULL, choices({
      ebayCategory: { mode: "set", value: { categoryId: "183454" } },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S1", "S2"] } },
      textAbove: { mode: "set", value: { mode: "own", text: " Ships in 1 day.\r\n" } },
      textBelow: { mode: "set", value: { mode: "none" } },
      mainText: { mode: "set", value: { text: "Our own words." } },
    }));
    expect(changedFields(same)).toEqual([]);
    expect(draftOf(base, same).changes).toBe(0);
    const moved = productSettingsDraftValue(FULL, choices({
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S2", "S1"] } },
      textAbove: { mode: "set", value: { mode: "own", text: "Ships in 2 days. " } },
      textBelow: { mode: "default" },
      mainText: { mode: "default" },
    }));
    expect(changedFields(moved)).toEqual(["storeShelf", "textAbove", "textBelow", "mainText"]);
    expect(draftOf(base, moved).changes).toBe(4);
    // The draft keeps the text as typed (its box shows it); the body sends it as stored.
    expect(moved.textAbove).toEqual({ mode: "set", value: { mode: "own", text: "Ships in 2 days. " } });
  });

  it("keeps the main text a change while it needs a check, so [Keep my text] saves the same text again (5.4, A2)", () => {
    const keep = ownTextCheckChoices(STALE)!.keep!;
    expect(keep).toEqual({ mode: "set", value: { text: "Our own words." } });
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: STALE, field: "mainText", choice: keep });
    expect(action.kind === "start" && productSettingsPatch(action.value)).toEqual({ mainText: { text: "Our own words." } });
    // Checked already: the same text is no change; a size's leftover text still makes it one (W5 clears it).
    expect(productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, field: "mainText", choice: keep })).toEqual({ kind: "no_change" });
    expect(productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, leftovers: ["mainText"], field: "mainText", choice: keep }).kind).toBe("start");
    // [Use Card Shellz text] is the default.
    expect(ownTextCheckChoices(STALE)!.useCardShellz).toEqual({ mode: "default" });
    const cardShellz = productSettingsEditAction({ draft: null, editor: EDITOR, own: STALE, field: "mainText", choice: { mode: "default" } });
    expect(cardShellz.kind === "start" && productSettingsPatch(cardShellz.value)).toEqual({ mainText: null });
    // After a 409 the keep is still a change while the latest read still needs the check.
    const mine = productSettingsDraftValue(STALE, choices({ mainText: keep }));
    expect(rebaseProductSettingsDraft(mine, own({ ...STALE.own }, 6))).toMatchObject({ keeps: true, marked: [] });
    expect(rebaseProductSettingsDraft(mine, own({ ...FULL.own }, 6))).toMatchObject({ keeps: false });
  });

  it("offers the check's answers only when a text needs one, and only [Use Card Shellz text] for a size's own text (5.4)", () => {
    expect(ownTextCheckChoices(FULL)).toBeNull();
    expect(ownTextCheckChoices(OWN)).toBeNull();
    const sizeFix = { sizes: [{ fixes: ["own_text_needs_check"] }, { fixes: [] }] } as unknown as Pick<ListingSettingsProductDetail, "sizes">;
    const cardShellzOnly = { keep: null, useCardShellz: { mode: "default" } };
    expect(ownTextCheckChoices(OWN, sizeFix, ["mainText"])).toEqual(cardShellzOnly);
    // The product's text is checked and a size's own text needs the check: a "keep" would re-save the product's
    // text, and W5 would clear that size's text, so [Keep my text] is not offered (review CE1).
    expect(ownTextCheckChoices(FULL, sizeFix, ["mainText"])).toEqual(cardShellzOnly);
    expect(ownTextCheckChoices(FULL, sizeFix)).toEqual(cardShellzOnly);
    expect(ownTextCheckChoices(FULL, { sizes: [] } as unknown as Pick<ListingSettingsProductDetail, "sizes">)).toBeNull();
  });

  it("offers [Keep my text] only when the product's own text needs the check and no size keeps its own (5.4, review CE1)", () => {
    const keep = { keep: { mode: "set", value: { text: "Our own words." } }, useCardShellz: { mode: "default" } };
    expect(ownTextCheckChoices(STALE)).toEqual(keep);
    // Every size the product's own text flags carries the fix too (facts: the product's text against the product's hash),
    // with no text of its own: keeping the product's text deletes nothing.
    expect(ownTextCheckChoices(STALE, { sizes: [{ fixes: ["own_text_needs_check"] }] } as unknown as Pick<ListingSettingsProductDetail, "sizes">, [])).toEqual(keep);
    // Another size keeps its own text, whatever its check says: keeping the product's text would delete it.
    expect(ownTextCheckChoices(STALE, null, ["mainText"])).toEqual({ keep: null, useCardShellz: { mode: "default" } });
    // Other sizes' leftovers don't touch the main text.
    expect(ownTextCheckChoices(STALE, null, ["shippingPolicy", "storeShelf"])).toEqual(keep);
  });

  it("reads a draft of every 10b field's shape, and nothing else as one", () => {
    const value = productSettingsDraftValue(OWN, choices({
      ebayCategory: { mode: "set", value: { categoryId: "261328", categoryName: "Toploaders" } },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S1"] } },
      textAbove: { mode: "set", value: { mode: "none" } },
      textBelow: { mode: "set", value: { mode: "own", text: "Thanks!" } },
      mainText: { mode: "set", value: { text: "Mine." } },
    }));
    expect(readProductSettingsDraft(value)).toEqual(value);
    const base = productSettingsDraftValue(OWN);
    for (const bad of [
      { ...base, ebayCategory: { mode: "set", value: { categoryId: "" } } },
      { ...base, ebayCategory: { mode: "set", value: { categoryId: "1", categoryName: 7 } } },
      { ...base, storeShelf: { mode: "set", value: { mode: "own", shelfIds: [] } } },
      { ...base, storeShelf: { mode: "set", value: { mode: "some" } } },
      { ...base, textAbove: { mode: "set", value: { mode: "own" } } },
      { ...base, mainText: { mode: "set", value: { text: 7 } } },
      { ...base, mainText: undefined },
    ]) {
      expect(readProductSettingsDraft(bad as DraftValue)).toBeNull();
    }
  });

  it("puts several parts in the draft at once, keeps a part left out as the draft had it, and refuses a pick of another shape", () => {
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, picks: {
      textAbove: { mode: "default" }, textBelow: { mode: "set", value: { mode: "own", text: "Thanks!" } },
    } });
    expect(action).toMatchObject({
      kind: "start",
      value: { textAbove: { mode: "default" }, textBelow: { mode: "set", value: { mode: "own", text: "Thanks!" } }, mainText: { mode: "leave" } },
    });
    const held = draftOf(productSettingsDraftValue(FULL), productSettingsDraftValue(FULL, choices({ mainText: { mode: "default" } })));
    const joined = productSettingsEditAction({ draft: held, editor: EDITOR, own: FULL, picks: { textAbove: { mode: "set", value: { mode: "none" } } } });
    expect(joined.kind === "edit" && changedFields(joined.value)).toEqual(["textAbove", "mainText"]);
    expect(productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, picks: {} })).toEqual({ kind: "no_change" });
    expect(() => productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, picks: { mainText: { mode: "set", value: { id: "F2" } } } as never }))
      .toThrow(/doesn't edit/);
    expect(() => productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, picks: { price: { mode: "default" } } as never })).toThrow(/doesn't edit/);
  });

  it("marks a shelf, category or text another window moved after Load latest, never a renamed one", () => {
    const after = own({
      ...FULL.own,
      storeShelf: { mode: "own", shelves: [{ id: "S1", name: "Renamed" }, { id: "S2", name: "Sleeves:Standard" }] },
      ebayCategory: { categoryId: "183454", categoryName: "Renamed" },
      textAbove: { mode: "own", text: "Ships today." },
    }, 6);
    expect(markedAfterReload(FULL, after, ["ebayCategory", "storeShelf", "textAbove", "mainText"])).toEqual(["textAbove"]);
    expect(markedAfterReload(FULL, own({ ...FULL.own, storeShelf: { mode: "none" } }, 6), ["storeShelf"])).toEqual(["storeShelf"]);
  });
});

describe("10b's field editors (plan 5.2)", () => {
  const all = { canSet: true, canDefault: true, canNone: true };
  const signIn = { canSet: false, canDefault: true, canNone: true };

  it("opens the eBay category on the draft's pick, else the product's own, with its name to search from", () => {
    expect(ebayCategoryFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: FULL })).toEqual({
      field: "ebayCategory", canSet: true, canDefault: true,
      initial: { mode: "set", value: { categoryId: "183454", categoryName: "Card Sleeves" } }, initialQuery: "Card Sleeves",
    });
    expect(ebayCategoryFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: OWN })).toMatchObject({ initial: { mode: "default" }, initialQuery: "" });
    const picked = ebayCategoryPick({ categoryId: "261328", categoryName: "Toploaders" });
    expect(picked).toEqual({ mode: "set", value: { categoryId: "261328", categoryName: "Toploaders" } });
    expect(ebayCategoryFieldEditor({ rights: all, draftChoice: picked, own: FULL }).initialQuery).toBe("Toploaders");
    const noPick = ebayCategoryFieldEditor({ rights: signIn, draftChoice: { mode: "leave" }, own: FULL });
    expect(ebayCategoryChoiceReady(noPick, picked)).toBe(false);
    expect(ebayCategoryChoiceReady(noPick, { mode: "default" })).toBe(true);
    expect(ebayCategoryChoiceReady(all, picked)).toBe(true);
    expect(ebayCategoryChoiceReady(all, { mode: "leave" })).toBe(false);
  });

  it("names the own category radio as the row does, never by its number or the picker's words (review UX7)", () => {
    expect(ebayCategoryChoiceLabel({ categoryId: "261328", categoryName: "Toploaders" })).toBe("Toploaders");
    // A quick pick from a value eBay gave no name for: the row's words, and the search starts empty (no number is searched).
    expect(ebayCategoryChoiceLabel({ categoryId: "261328" })).toBe("An eBay category");
    expect(ebayCategoryChoiceLabel({ categoryId: "261328", categoryName: "  " })).toBe("An eBay category");
    expect(ebayCategoryFieldEditor({ rights: all, draftChoice: { mode: "set", value: { categoryId: "261328" } }, own: FULL }).initialQuery).toBe("");
  });

  const SHELVES = [
    { categoryId: "S1", categoryName: "Sleeves", path: "Sleeves", level: 1 },
    { categoryId: "S3", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
  ];

  it("opens the shelves on the product's own ids, and offers the shelves read plus its own shelves the read lacks", () => {
    const model = storeShelfFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: FULL, shelves: SHELVES });
    expect(model.initial).toEqual({ mode: "own", first: "S1", second: "S2" });
    expect(model.options?.map((option) => [option.categoryId, option.path])).toEqual([
      ["S1", "Sleeves"], ["S3", "Supplies › Toploaders"], ["S2", "Sleeves › Standard (no longer in your eBay store)"],
    ]);
    const noneOwn = own({ storeShelf: { mode: "none" } });
    expect(storeShelfFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: noneOwn, shelves: SHELVES }).initial).toEqual({ mode: "none", first: null, second: null });
    expect(storeShelfFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: OWN, shelves: SHELVES }).initial.mode).toBe("default");
    expect(storeShelfFieldEditor({ rights: all, draftChoice: { mode: "default" }, own: FULL, shelves: SHELVES }).initial.mode).toBe("default");
    // A size keeps its own shelf: nothing is picked until the vendor picks.
    expect(storeShelfFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: FULL, leftover: true, shelves: SHELVES }).initial.mode).toBe("leave");
    // No new shelf can be picked (a sign-in, or the shelves can't be read): None and Use default only.
    expect(storeShelfFieldEditor({ rights: signIn, draftChoice: { mode: "leave" }, own: FULL, shelves: SHELVES }).options).toBeNull();
    expect(storeShelfFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: FULL, shelves: null }).options).toBeNull();
  });

  it("takes one or two different shelves, None or the default, and says why it can't take a pair", () => {
    const model = storeShelfFieldEditor({ rights: all, draftChoice: { mode: "leave" }, own: FULL, shelves: SHELVES });
    const own2 = (first: string | null, second: string | null) => ({ mode: "own" as const, first, second });
    expect(storeShelfEditorChoice(model, own2("S3", null))).toEqual({ ok: true, choice: { mode: "set", value: { mode: "own", shelfIds: ["S3"] } } });
    expect(storeShelfEditorChoice(model, own2("S3", "S1"))).toEqual({ ok: true, choice: { mode: "set", value: { mode: "own", shelfIds: ["S3", "S1"] } } });
    expect(storeShelfEditorChoice(model, own2("S3", "S3"))).toEqual({ ok: false, problem: "Pick two different shelves." });
    expect(storeShelfEditorChoice(model, own2(null, "S3"))).toEqual({ ok: false, problem: "Pick a first shelf first" });
    expect(storeShelfEditorChoice(model, own2(null, null))).toEqual({ ok: false, problem: null });
    expect(storeShelfEditorChoice(model, own2("GONE", null))).toEqual({ ok: false, problem: null });
    expect(storeShelfEditorChoice(model, { mode: "none", first: null, second: null })).toEqual({ ok: true, choice: { mode: "set", value: { mode: "none" } } });
    expect(storeShelfEditorChoice(model, { mode: "default", first: null, second: null })).toEqual({ ok: true, choice: { mode: "default" } });
    expect(storeShelfEditorChoice(model, { mode: "leave", first: null, second: null })).toEqual({ ok: false, problem: null });
    const noPick = storeShelfFieldEditor({ rights: signIn, draftChoice: { mode: "leave" }, own: FULL, shelves: SHELVES });
    expect(storeShelfEditorChoice(noPick, own2("S3", null))).toEqual({ ok: false, problem: null });
    expect(storeShelfEditorChoice(noPick, { mode: "none", first: null, second: null }).ok).toBe(true);
    // The pick goes in the draft by id, and the patch sends the ids alone.
    const picked = storeShelfEditorChoice(model, own2("S3", "S1"));
    if (!picked.ok) throw new Error("expected a choice");
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, field: "storeShelf", choice: picked.choice });
    expect(action.kind === "start" && productSettingsPatch(action.value)).toEqual({ storeShelf: { mode: "own", shelfIds: ["S3", "S1"] } });
  });
});

/** Raw 4,001 characters (one CRLF) that store as 4,000, and raw 4,000 that store as 3,999; the same at the main text's limit. */
const CRLF_4001 = `${"x".repeat(1_999)}\r\n${"x".repeat(2_000)}`;
const CRLF_4000 = `${"x".repeat(1_998)}\r\n${"x".repeat(2_000)}`;
const CRLF_20001 = `${"x".repeat(9_999)}\r\n${"x".repeat(10_000)}`;
const CRLF_20000 = `${"x".repeat(9_998)}\r\n${"x".repeat(10_000)}`;

describe("text rules (plan 5.4, 5.5)", () => {
  it("counts the raw length, as the server bounds it before trimming", () => {
    expect(textCounter("  a\r\nb  ", "textAbove")).toEqual({ count: 8, max: 4_000, over: false });
    expect(textCounter("x".repeat(4_001), "textBelow")).toEqual({ count: 4_001, max: 4_000, over: true });
    expect(textCounter("x".repeat(20_000), "mainText")).toEqual({ count: 20_000, max: 20_000, over: false });
    expect(textCounter("x".repeat(20_001), "mainText")).toEqual({ count: 20_001, max: 20_000, over: true });
    expect(textCounter("x".repeat(4_000), "textAbove")).toEqual({ count: 4_000, max: 4_000, over: false });
    // A CRLF counts 2 as typed, though it is stored as one "\n": 4,001 typed is over (review T1).
    expect(textCounter(CRLF_4001, "textAbove")).toEqual({ count: 4_001, max: 4_000, over: true });
    expect(textCounter(CRLF_4000, "textBelow").over).toBe(false);
    // UTF-16 units, as Zod's max: a card emoji counts 2.
    expect(textCounter("🃏", "mainText").count).toBe(2);
  });

  it("checks own text with the shared schemas, in the vendor's words", () => {
    expect(templateTextProblem("Ships in 1 day.")).toBeNull();
    expect(templateTextProblem("x".repeat(4_000))).toBeNull();
    // Over the limit as typed, even where trimming would bring it under: the schema bounds the raw text.
    expect(templateTextProblem(`${"x".repeat(3_999)}  `)).toBe("Shorten it to 4,000 characters or fewer.");
    expect(templateTextProblem(" \r\n ")).toBe("Enter the text, or choose None.");
    expect(templateTextProblem("bad\u0007bell")).toBe(LISTING_SETTINGS_EDIT_WORDS.textBadCharacters);
    expect(mainTextProblem("x".repeat(20_001))).toBe("Shorten it to 20,000 characters or fewer.");
    expect(mainTextProblem("x".repeat(20_000))).toBeNull();
    // Over as typed with a CRLF, though it would store under the limit: refused, as the schema refuses it (review T1).
    expect(templateTextProblem(CRLF_4001)).toBe("Shorten it to 4,000 characters or fewer.");
    expect(templateTextProblem(CRLF_4000)).toBeNull();
    expect(mainTextProblem(CRLF_20001)).toBe("Shorten it to 20,000 characters or fewer.");
    expect(mainTextProblem(CRLF_20000)).toBeNull();
    expect(mainTextProblem("   ")).toBe("Enter your text, or use the Card Shellz text.");
    expect(mainTextProblem("bad\u0000")).toBe(LISTING_SETTINGS_EDIT_WORDS.textBadCharacters);
    expect(mainTextProblem("Our own words.")).toBeNull();
    // Every verdict agrees with the shared schema.
    for (const text of ["ok", "x".repeat(4_000), "x".repeat(4_001), "x".repeat(20_000), "x".repeat(20_001), " ", "a\u0000", " a\r\n",
      CRLF_4001, CRLF_4000, CRLF_20001, CRLF_20000]) {
      const name = `${text.slice(0, 8)}… (${text.length})`;
      expect({ name, ok: templateTextProblem(text) === null })
        .toEqual({ name, ok: listingSettingTemplateTextSchema.safeParse({ mode: "own", text }).success });
      expect({ name, ok: mainTextProblem(text) === null }).toEqual({ name, ok: descriptionTextSchema.safeParse(text).success });
    }
  });

  it("normalizes text exactly as the shared schema stores it", () => {
    for (const text of ["  a\r\nb\rc  ", "\n\nx", "plain"]) expect(normalizedVendorText(text)).toBe(descriptionTextSchema.parse(text));
  });
});

describe("the description editor (plan 5.2, 5.4)", () => {
  const W5 = { canSet: true, canDefault: true, canNone: true };
  const LEAVE_ALL = { textAbove: { mode: "leave" }, textBelow: { mode: "leave" }, mainText: { mode: "leave" } } as const;
  const editor = (overrides: Partial<Parameters<typeof descriptionFieldEditor>[0]> = {}) =>
    descriptionFieldEditor({ rights: W5, draftChoices: LEAVE_ALL, own: FULL, ...overrides });

  it("opens each part on what the product has, keeping its own text in the box", () => {
    expect(editor().initial).toEqual({
      textAbove: { mode: "own", text: "Ships in 1 day." },
      textBelow: { mode: "none", text: "" },
      mainText: { mode: "own", text: "Our own words." },
    });
    expect(editor({ own: OWN }).initial).toEqual({
      textAbove: { mode: "default", text: "" }, textBelow: { mode: "default", text: "" }, mainText: { mode: "default", text: "" },
    });
    // The draft's change shows; a default keeps the product's text to come back to.
    expect(editor({ draftChoices: { ...LEAVE_ALL, textAbove: { mode: "default" } } }).initial.textAbove).toEqual({ mode: "default", text: "Ships in 1 day." });
    // A size keeps its own main text and the product has none: nothing picked, and an empty box (5.4).
    expect(editor({ own: OWN, leftovers: ["mainText"] }).initial.mainText).toEqual({ mode: "leave", text: "" });
    expect(editor().check).toBeNull();
    expect(editor().conflictLine).toBeNull();
  });

  it("opens the main text with nothing picked while a size keeps its own, so the product's text can be used for every size (review CE2)", () => {
    // The product has its own text and a size keeps another: the box holds the product's text to choose.
    const model = editor({ leftovers: ["mainText"] });
    expect(model.initial.mainText).toEqual({ mode: "leave", text: "Our own words." });
    expect(model.initial.textAbove).toEqual({ mode: "own", text: "Ships in 1 day." });
    // [Done] as opened makes no pick.
    expect(descriptionEditorResult(model, model.initial)).toEqual({ ok: true, picks: {} });
    // Choosing Own text with the product's text is a pick, kept a change by the leftover: W5 clears the size's text.
    const result = descriptionEditorResult(model, { ...model.initial, mainText: { mode: "own", text: "Our own words." } });
    expect(result).toEqual({ ok: true, picks: { mainText: { mode: "set", value: { text: "Our own words." } } } });
    if (!result.ok) throw new Error("expected picks");
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, leftovers: ["mainText"], picks: result.picks });
    expect(action.kind === "start" && productSettingsPatch(action.value)).toEqual({ mainText: { text: "Our own words." } });
    // A draft's change still shows.
    expect(editor({ leftovers: ["mainText"], draftChoices: { ...LEAVE_ALL, mainText: { mode: "default" } } }).initial.mainText)
      .toEqual({ mode: "default", text: "Our own words." });
  });

  it("asks for both parts while two older description rules tie, opening a part the product doesn't set with nothing picked (review CE4)", () => {
    const tie = (groupConflict: boolean) => ({ sizes: [], settings: { descriptionTemplate: [
      { value: { hasIntroduction: false, hasFooter: false, groupConflict }, sources: [{ source: "group_rule" as const, ruleName: null, productVariantIds: [101] }] },
    ] } });
    const model = editor({ own: OWN, detail: tie(true) });
    expect(model.conflictLine).toBe("Set both text above and text below, your own or None, to fix this.");
    expect(model.initial.textAbove).toEqual({ mode: "leave", text: "" });
    expect(model.initial.textBelow).toEqual({ mode: "leave", text: "" });
    // "Use default" leaves the tie: the vendor picks own text or None for each part.
    const both = descriptionEditorResult(model, { ...model.initial,
      textAbove: { mode: "own", text: "Ships in 1 day." }, textBelow: { mode: "none", text: "" } });
    expect(both).toEqual({ ok: true, picks: {
      textAbove: { mode: "set", value: { mode: "own", text: "Ships in 1 day." } }, textBelow: { mode: "set", value: { mode: "none" } },
    } });
    // A part the product already sets opens on it; no tie, no line.
    expect(editor({ own: own({ textAbove: { mode: "none" } }), detail: tie(true) }).initial.textAbove).toEqual({ mode: "none", text: "" });
    expect(editor({ own: OWN, detail: tie(false) })).toMatchObject({ conflictLine: null, initial: { textAbove: { mode: "default" } } });
  });

  it("shows the check in the open editor only while the main text is as it opened (review UX5)", () => {
    const model = editor({ own: STALE });
    expect(descriptionEditorCheck(model, model.initial)).toEqual(model.check);
    // Text typed above or below keeps it.
    expect(descriptionEditorCheck(model, { ...model.initial, textAbove: { mode: "none", text: "" } })).toEqual(model.check);
    // An edit of the main text, or Card Shellz's text picked, is the answer: the notice steps back, so Keep never drops typed text.
    expect(descriptionEditorCheck(model, { ...model.initial, mainText: { mode: "own", text: "Our own words, shorter." } })).toBeNull();
    expect(descriptionEditorCheck(model, { ...model.initial, mainText: { mode: "default", text: "Our own words." } })).toBeNull();
    expect(descriptionEditorCheck(editor(), editor().initial)).toBeNull();
  });

  it("puts in the draft only the parts the vendor changed: None as none, own text as typed", () => {
    const model = editor();
    expect(descriptionEditorResult(model, model.initial)).toEqual({ ok: true, picks: {} });
    const result = descriptionEditorResult(model, {
      ...model.initial, textAbove: { mode: "none", text: "Ships in 1 day." }, textBelow: { mode: "own", text: "Thanks for buying!" },
    });
    expect(result).toEqual({ ok: true, picks: {
      textAbove: { mode: "set", value: { mode: "none" } }, textBelow: { mode: "set", value: { mode: "own", text: "Thanks for buying!" } },
    } });
    expect(descriptionEditorResult(model, { ...model.initial, mainText: { mode: "default", text: "Our own words." } }))
      .toEqual({ ok: true, picks: { mainText: { mode: "default" } } });
    // Switched to own text and back to None: no change.
    expect(descriptionEditorResult(model, { ...model.initial, textBelow: { mode: "none", text: "typed, then dropped" } })).toEqual({ ok: true, picks: {} });
    // Through the draft: None sends { mode: "none" }.
    if (!result.ok) throw new Error("expected picks");
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: FULL, picks: result.picks });
    expect(action.kind === "start" && productSettingsPatch(action.value)).toEqual({ textAbove: { mode: "none" }, textBelow: { mode: "own", text: "Thanks for buying!" } });
  });

  it("refuses text that can't be saved as typed, by part, so nothing goes in the draft or is sent", () => {
    const model = editor();
    expect(descriptionEditorResult(model, {
      textAbove: { mode: "own", text: "x".repeat(4_001) },
      textBelow: { mode: "own", text: "  " },
      mainText: { mode: "own", text: "" },
    })).toEqual({ ok: false, problems: {
      textAbove: "Shorten it to 4,000 characters or fewer.",
      textBelow: "Enter the text, or choose None.",
      mainText: "Enter your text, or use the Card Shellz text.",
    } });
    expect(descriptionEditorResult(model, { ...model.initial, mainText: { mode: "own", text: "x".repeat(20_001) } }))
      .toEqual({ ok: false, problems: { mainText: "Shorten it to 20,000 characters or fewer." } });
    expect(descriptionEditorResult(model, { ...model.initial, textAbove: { mode: "own", text: CRLF_4001 }, mainText: { mode: "own", text: CRLF_20001 } }))
      .toEqual({ ok: false, problems: { textAbove: "Shorten it to 4,000 characters or fewer.", mainText: "Shorten it to 20,000 characters or fewer." } });
    // At each limit it goes in the draft (review T1).
    expect(descriptionEditorResult(model, { ...model.initial, textAbove: { mode: "own", text: "x".repeat(4_000) }, mainText: { mode: "own", text: "x".repeat(20_000) } }))
      .toEqual({ ok: true, picks: {
        textAbove: { mode: "set", value: { mode: "own", text: "x".repeat(4_000) } }, mainText: { mode: "set", value: { text: "x".repeat(20_000) } },
      } });
  });

  it("never re-saves a prefilled main text by itself: only [Keep my text] does", () => {
    const model = editor({ own: STALE });
    expect(model.check).toEqual({ keep: { mode: "set", value: { text: "Our own words." } }, useCardShellz: { mode: "default" } });
    expect(descriptionEditorResult(model, model.initial)).toEqual({ ok: true, picks: {} });
    // Once the draft answers the check, it steps back (the row's pending line says so).
    expect(editor({ own: STALE, draftChoices: { ...LEAVE_ALL, mainText: model.check!.keep! } }).check).toBeNull();
  });

  it("answers the check from the open editor with the other parts as Done would put them, whatever the main text box holds", () => {
    const model = editor({ own: STALE });
    const keep = model.check!.keep!;
    // Only the answer: the same text, sent again.
    expect(descriptionEditorAnswer(model, model.initial, keep)).toEqual({ ok: true, picks: { mainText: { mode: "set", value: { text: "Our own words." } } } });
    // Text typed above goes in with it; what the main text box holds is not used.
    expect(descriptionEditorAnswer(model, {
      ...model.initial, textAbove: { mode: "own", text: "New words above." }, mainText: { mode: "own", text: "half typed" },
    }, model.check!.useCardShellz)).toEqual({ ok: true, picks: {
      textAbove: { mode: "set", value: { mode: "own", text: "New words above." } }, mainText: { mode: "default" },
    } });
    // A part that can't be saved stops the answer too, so nothing goes in the draft.
    expect(descriptionEditorAnswer(model, { ...model.initial, textBelow: { mode: "own", text: " " } }, keep))
      .toEqual({ ok: false, problems: { textBelow: "Enter the text, or choose None." } });
    // The model is never changed.
    expect(model.initial.mainText).toEqual({ mode: "own", text: "Our own words." });
  });
});

describe("sizesDifferPick (plan 5.3; UX-M5, CC-C17)", () => {
  type Settings = ListingSettingsProductDetail["settings"];
  type Source = Settings["shippingPolicy"][number]["sources"][number]["source"];
  const ALL = { canSet: true, canDefault: true };
  const SIGN_IN = { canSet: false, canDefault: true };
  const NOTHING = { canSet: false, canDefault: false };
  const from = (source: Source, ids: number[]) =>
    ({ source, ruleName: source === "category" ? "Sleeves" : source === "group_rule" ? "Envelopes" : null, productVariantIds: ids });
  const policy = (policyId: string | null, ...sources: Array<ReturnType<typeof from>>) => ({ value: { policyId }, sources });
  const shipping = (...values: Array<ReturnType<typeof policy>>): SizesDifferSetting => ({ key: "shippingPolicy", values });
  const category = (categoryId: string | null, categoryName: string | null, ...sources: Array<ReturnType<typeof from>>) =>
    ({ value: { categoryId, categoryName }, sources });
  const useDefault = { kind: "button", action: "use_default", label: "Use default for all sizes", field: "shippingPolicy", picks: { shippingPolicy: { mode: "default" } } };
  const useThis = (id: string) => ({ kind: "button", action: "use_this", label: "Use for all sizes", field: "shippingPolicy", picks: { shippingPolicy: { mode: "set", value: { id } } } });
  // The live setup read: every policy these cases name is on eBay, and every shipping policy works with Card Shellz shipping.
  const ship = (id: string) => ({ id, name: `Ship ${id}`, compatible: true, compatibilityChecked: true, compatibilityIssues: [] });
  const LIVE_SETUP: PolicySetupFacts = {
    selection: { merchantLocationKey: "cs", fulfillmentPolicyId: "F1", returnPolicyId: null, paymentPolicyId: "P1" },
    storedNames: { fulfillmentPolicyName: null, returnPolicyName: null, paymentPolicyName: null },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: ["F1", "F2", "F3", "F7", "F9"].map(ship),
      returnPolicies: [{ id: "R1", name: "30 days" }, { id: "R9", name: "60 days" }],
      paymentPolicies: [{ id: "P1", name: "eBay payments" }, { id: "P9", name: "Other" }],
    },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    fulfillmentCapability: null,
  };
  const LIVE: ListingSettingsReadState<PolicySetupFacts> = { data: LIVE_SETUP, error: null };
  const differPick = (setting: SizesDifferSetting, entry: SizesDifferSetting["values"][number], rights: typeof ALL,
    setup: ListingSettingsReadState<PolicySetupFacts> = LIVE) => sizesDifferPick(setting, entry, rights, setup);

  it("offers nothing while every size agrees", () => {
    const one = policy("F1", from("store_default", [101, 102]));
    expect(differPick(shipping(one), one, ALL)).toEqual({ kind: "none" });
  });

  it("row 1: a policy value with nothing set has no button", () => {
    const unset = policy(null, from("none", [101]));
    expect(differPick(shipping(unset, policy("F2", from("size", [102]))), unset, ALL)).toEqual({ kind: "none" });
  });

  it("row 2: every source the category or the store default, and no older group rule: Use default for all sizes", () => {
    const leftover = policy("F9", from("size", [102]));
    for (const entry of [
      policy("F1", from("store_default", [101])),
      policy("F1", from("category", [101])),
      policy("F1", from("category", [101]), from("store_default", [103])),
    ]) {
      expect(differPick(shipping(entry, leftover), entry, ALL)).toEqual(useDefault);
    }
    // An older group rule on another value: "Use default" can't take its sizes back, so it sets this value.
    const storeDefault = policy("F1", from("store_default", [101]));
    expect(differPick(shipping(storeDefault, policy("F7", from("group_rule", [102]))), storeDefault, ALL)).toEqual(useThis("F1"));
  });

  it("row 3: any other value: Use for all sizes", () => {
    const storeDefault = policy("F1", from("store_default", [101]));
    for (const [entry, id] of [
      [policy("F9", from("size", [102])), "F9"],
      [policy("F2", from("product", [102])), "F2"],
      [policy("F7", from("group_rule", [102])), "F7"],
      [policy("F3", from("size", [102]), from("store_default", [103])), "F3"],
    ] as const) {
      expect(differPick(shipping(storeDefault, entry), entry, ALL)).toEqual(useThis(id));
    }
    // The return and payment policies alike.
    const ret = policy("R9", from("size", [102]));
    expect(differPick({ key: "returnPolicy", values: [policy("R1", from("product", [101])), ret] }, ret, ALL))
      .toMatchObject({ field: "returnPolicy", picks: { returnPolicy: { mode: "set", value: { id: "R9" } } } });
    const pay = policy("P1", from("store_default", [101]));
    expect(differPick({ key: "paymentPolicy", values: [pay, policy("P9", from("size", [102]))] }, pay, ALL))
      .toMatchObject({ action: "use_default", field: "paymentPolicy", picks: { paymentPolicy: { mode: "default" } } });
  });

  it("row 3: offers Use for all sizes only for a policy the row's editor would take (review CE3 / UX2)", () => {
    const storeDefault = policy("F1", from("store_default", [101]));
    const incompatible: PolicySetupFacts = { ...LIVE_SETUP, options: { ...LIVE_SETUP.options, fulfillmentPolicies: [
      ...LIVE_SETUP.options.fulfillmentPolicies.filter((option) => option.id !== "F9"),
      { id: "F9", name: "Economy", compatible: false, compatibilityChecked: true, compatibilityIssues: [{ code: "handling_time_too_short", message: "x" }] },
    ] } };
    const unchecked: PolicySetupFacts = { ...LIVE_SETUP, options: { ...LIVE_SETUP.options, fulfillmentPolicies: [
      ...LIVE_SETUP.options.fulfillmentPolicies.filter((option) => option.id !== "F9"),
      { id: "F9", name: "Economy", compatible: true, compatibilityChecked: false, compatibilityIssues: [] },
    ] } };
    const leftover = policy("F9", from("size", [102]));
    const gone = policy("GONE", from("size", [102]));
    const setting = shipping(storeDefault, leftover);
    for (const setup of [
      { data: incompatible, error: null },
      { data: unchecked, error: null },
      { data: LIVE_SETUP, error: new Error("refetch failed") },
      { data: undefined, error: null },
      { data: { ...LIVE_SETUP, checks: { ebay: "not_checked" as const, fulfillment: { status: "checked" as const } } }, error: null },
    ]) {
      expect(differPick(setting, leftover, ALL, setup)).toEqual({ kind: "none" });
      // "Use default for all sizes" names no eBay value: it stays.
      expect(differPick(setting, storeDefault, ALL, setup)).toEqual(useDefault);
    }
    // A policy no longer on eBay.
    expect(differPick(shipping(storeDefault, gone), gone, ALL)).toEqual({ kind: "none" });
    const ret = policy("R-GONE", from("size", [102]));
    expect(differPick({ key: "returnPolicy", values: [policy("R1", from("product", [101])), ret] }, ret, ALL)).toEqual({ kind: "none" });
    // Choosable: the button, and the editor agrees.
    expect(differPick(setting, leftover, ALL)).toEqual(useThis("F9"));
    for (const [setup, id] of [[incompatible, "F9"], [LIVE_SETUP, "F9"], [LIVE_SETUP, "GONE"]] as const) {
      const editor = policyFieldEditor({ field: "shippingPolicy", rights: ALL, draftChoice: { mode: "leave" }, own: OWN, setup: { data: setup, error: null } });
      const entry = policy(id, from("size", [102]));
      expect(differPick(shipping(storeDefault, entry), entry, ALL, { data: setup, error: null }).kind === "button")
        .toBe(fieldChoiceReady(editor, { mode: "set", value: { id } }));
    }
  });

  it("row 4: the eBay category follows the same rule, set by its number", () => {
    const unset = category(null, null, from("none", [101]));
    const rule = category("99", "Envelopes", from("group_rule", [102]));
    const picked = category("183454", "Card Sleeves", from("catalog", [101]));
    expect(differPick({ key: "ebayCategory", values: [unset, rule] }, unset, ALL)).toEqual({ kind: "none" });
    expect(differPick({ key: "ebayCategory", values: [picked, rule] }, picked, ALL)).toEqual({
      kind: "button", action: "use_this", label: "Use for all sizes", field: "ebayCategory",
      picks: { ebayCategory: { mode: "set", value: { categoryId: "183454", categoryName: "Card Sleeves" } } },
    });
    const storeDefault = category("261328", null, from("store_default", [101]));
    const product = category("183454", "Card Sleeves", from("product", [102]));
    expect(differPick({ key: "ebayCategory", values: [storeDefault, product] }, storeDefault, ALL))
      .toMatchObject({ action: "use_default", field: "ebayCategory", picks: { ebayCategory: { mode: "default" } } });
    expect(differPick({ key: "ebayCategory", values: [storeDefault, rule] }, storeDefault, ALL))
      .toMatchObject({ action: "use_this", picks: { ebayCategory: { mode: "set", value: { categoryId: "261328" } } } });
  });

  it("row 5: the store shelf and the description show the line only", () => {
    const shelf = { value: { names: ["Sleeves"] }, sources: [from("size", [101])] };
    const noShelf = { value: { names: [] }, sources: [from("none", [102])] };
    const line = { kind: "line", line: "Sizes differ. Use Change to pick one for all sizes." };
    expect(differPick({ key: "storeShelf", values: [shelf, noShelf] }, shelf, ALL)).toEqual(line);
    const above = { value: { hasIntroduction: true, hasFooter: false, groupConflict: false }, sources: [from("group_rule", [101])] };
    const plain = { value: { hasIntroduction: false, hasFooter: false, groupConflict: false }, sources: [from("store_default", [102])] };
    expect(differPick({ key: "descriptionTemplate", values: [above, plain] }, plain, ALL)).toEqual(line);
    const ownText = { value: { own: true }, sources: [from("size", [101])] };
    const cardShellz = { value: { own: false }, sources: [from("catalog", [102])] };
    expect(differPick({ key: "mainText", values: [ownText, cardShellz] }, ownText, SIGN_IN)).toEqual(line);
    // Without a [Change] to point at, no line.
    expect(differPick({ key: "storeShelf", values: [shelf, noShelf] }, shelf, NOTHING)).toEqual({ kind: "none" });
  });

  it("shows a set only with canSet and a default only with canDefault: a sign-in hides Use for all sizes (D4)", () => {
    const storeDefault = policy("F1", from("store_default", [101]));
    const leftover = policy("F9", from("size", [102]));
    const setting = shipping(storeDefault, leftover);
    expect(differPick(setting, storeDefault, SIGN_IN)).toEqual(useDefault);
    expect(differPick(setting, leftover, SIGN_IN)).toEqual({ kind: "none" });
    expect(differPick(setting, storeDefault, NOTHING)).toEqual({ kind: "none" });
    expect(differPick(setting, leftover, NOTHING)).toEqual({ kind: "none" });
  });

  it("puts its pick in the draft as one change, which clears the sizes' leftovers on Save", () => {
    const storeDefault = policy("F1", from("store_default", [101]));
    const leftover = policy("F9", from("size", [102]));
    const pick = differPick(shipping(storeDefault, leftover), storeDefault, ALL);
    if (pick.kind !== "button") throw new Error("expected a button");
    // NONE_OWN follows the default already: only the leftover makes "Use default" a change (W5 null clears it).
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: NONE_OWN, leftovers: ["shippingPolicy"], picks: pick.picks });
    expect(action.kind === "start" && productSettingsPatch(action.value)).toEqual({ shippingPolicy: null });
    const keepOwn = differPick(shipping(policy("F2", from("product", [101])), leftover), policy("F2", from("product", [101])), ALL);
    if (keepOwn.kind !== "button") throw new Error("expected a button");
    const again = productSettingsEditAction({ draft: null, editor: EDITOR, own: OWN, leftovers: ["shippingPolicy"], picks: keepOwn.picks });
    expect(again.kind === "start" && productSettingsPatch(again.value)).toEqual({ shippingPolicy: { id: "F2" } });
  });
});

// ---------------------------------------------------------------------------
// The product's price (PR 10d, plan 7.2, 7.6, D1, D2, D6a)
// ---------------------------------------------------------------------------

describe("the product's price (PR 10d, plan 7.2, D1, D2, D6a)", () => {
  const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
  const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 0, rounding: "cent" };
  const CHECK = { reviewId: "11111111-1111-4111-8111-111111111111", reviewHash: "a".repeat(64), after: null };
  const PRICED = own({ price: RETAIL_20_UP });
  const SET = { price: { mode: "set" as const, value: COST_35 }, releaseExactPrices: false };
  const priceDraft = (base: ProductOwnSettings, change: { price: FieldChoice<PricingRecipe>; releaseExactPrices: boolean; check: typeof CHECK | null }) =>
    draftOf(productPriceDraftValue(base), productPriceDraftValue(base, change));

  it("keeps the price as one field of the draft: leave, Use default or a recipe, the release and the check", () => {
    expect(productPriceDraftValue(OWN)).toEqual({ priceChange: { price: { mode: "leave" }, releaseExactPrices: false, check: null }, ownPrice: null, revisionId: 5 });
    expect(emptyProductPriceChange()).toEqual({ price: { mode: "leave" }, releaseExactPrices: false, check: null });
    expect(productPriceDraftValue(OWN)).toEqual(productPriceDraftValue(OWN, emptyProductPriceChange()));
    const set = productPriceDraftValue(OWN, { ...SET, releaseExactPrices: true, check: CHECK });
    expect(set).toEqual({ priceChange: { price: { mode: "set", value: COST_35 }, releaseExactPrices: true, check: CHECK }, ownPrice: null, revisionId: 5 });
    expect(draftOf(productPriceDraftValue(OWN), set).changes).toBe(1);
    // What the product has is no change: "Use default" while it follows the default, its own recipe again; then no check either.
    expect(productPriceDraftValue(OWN, { price: { mode: "default" }, releaseExactPrices: false, check: CHECK }).priceChange)
      .toEqual({ price: { mode: "leave" }, releaseExactPrices: false, check: null });
    expect(productPriceDraftValue(PRICED, { price: { mode: "set", value: { ...RETAIL_20_UP } }, releaseExactPrices: false, check: CHECK }).priceChange)
      .toEqual({ price: { mode: "leave" }, releaseExactPrices: false, check: null });
    expect(productPriceDraftValue(PRICED, { price: { mode: "default" }, releaseExactPrices: false, check: null }).priceChange.price).toEqual({ mode: "default" });
    expect(productPriceDraftValue(PRICED, { ...SET, check: null }).ownPrice).toEqual(RETAIL_20_UP);
    // A release alone is a change, and keeps its check.
    expect(productPriceDraftValue(PRICED, { price: { mode: "leave" }, releaseExactPrices: true, check: CHECK }).priceChange)
      .toEqual({ price: { mode: "leave" }, releaseExactPrices: true, check: CHECK });
    // The recipe is copied through the contract, never shared with the editor; an off-contract one throws.
    const value = { ...COST_35 };
    const made = productPriceDraftValue(OWN, { price: { mode: "set", value }, releaseExactPrices: false, check: null }).priceChange.price;
    expect(made.mode === "set" && made.value).toEqual(COST_35);
    expect(made.mode === "set" && made.value).not.toBe(value);
    expect(() => productPriceDraftValue(OWN, { price: { mode: "set", value: { ...COST_35, markupBps: -1 } }, releaseExactPrices: false, check: null })).toThrow();
    expect(isProductPriceChanged({ price: { mode: "leave" }, releaseExactPrices: false })).toBe(false);
    expect(isProductPriceChanged({ price: { mode: "leave" }, releaseExactPrices: true })).toBe(true);
    expect(isProductPriceChanged({ price: { mode: "default" }, releaseExactPrices: false })).toBe(true);
  });

  it("reads only its own shape", () => {
    const set = productPriceDraftValue(OWN, { ...SET, check: CHECK });
    expect(readProductPriceDraft(set)).toEqual(set);
    expect(readProductPriceDraft(productPriceDraftValue(PRICED))).toEqual(productPriceDraftValue(PRICED));
    expect(readProductPriceDraft(productSettingsDraftValue(OWN))).toBeNull();
    expect(readProductPriceDraft(sizePriceDraftValue({ productVariantId: 101, expectedRevisionId: 7, exact: "12.00" }))).toBeNull();
    expect(readProductPriceDraft({ ...set, revisionId: 0 })).toBeNull();
    expect(readProductPriceDraft({ ...set, ownPrice: { basis: "catalog_retail" } })).toBeNull();
    expect(readProductPriceDraft({ ...set, priceChange: { ...set.priceChange, releaseExactPrices: "yes" } })).toBeNull();
    expect(readProductPriceDraft({ ...set, priceChange: { ...set.priceChange, check: { reviewId: "x", reviewHash: "y", after: null } } })).toBeNull();
    expect(readProductPriceDraft({ ...set, priceChange: { ...set.priceChange, price: { mode: "set", value: { basis: "catalog_retail" } } } })).toBeNull();
    for (const after of [null, "prices_moved", "already_applied", "expired"]) expect(isPriceCheckRef({ ...CHECK, after })).toBe(true);
    expect(isPriceCheckRef({ ...CHECK, after: "x" })).toBe(false);
    expect(isPriceCheckRef({ ...CHECK, reviewId: "1A111111-1111-4111-8111-111111111111" })).toBe(false);
    expect(isPriceCheckRef({ ...CHECK, reviewId: "1a111111-1111-4111-8111-111111111111" })).toBe(true);
    expect(isPriceCheckRef({ ...CHECK, reviewHash: "A".repeat(64) })).toBe(false);
    expect(isPriceCheckRef(null)).toBe(false);
  });

  it("says which kind of change the draft holds, and lets the kinds wait for each other (D2)", () => {
    const draft = priceDraft(OWN, { ...SET, check: null });
    expect(drawerChangeKind(draft, EDITOR)).toBe("product_price");
    expect(drawerChangeKind(draftOf(productPriceDraftValue(OWN)), EDITOR)).toBe("none");
    expect(drawerChangeKind(draft, productEditorId(12))).toBe("none");
    expect(drawerChangeKind(reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k" } }), EDITOR)).toBe("product_price");
    const cases: Array<[DrawerChangeKind, DrawerChangeKind, "edit" | "finish_first"]> = [
      ["none", "product_price", "edit"], ["product_price", "product_price", "edit"],
      ["settings", "product_price", "finish_first"], ["size_price", "product_price", "finish_first"],
      ["product_price", "settings", "finish_first"], ["product_price", "size_price", "finish_first"],
    ];
    for (const [current, wanted, decision] of cases) expect({ current, wanted, decision: decideDrawerEdit(current, wanted) }).toEqual({ current, wanted, decision });
    // A settings edit over a price change waits (the sizes do too, dropship-listing-settings-drawer.ts).
    expect(productSettingsEditAction({ draft, editor: EDITOR, own: OWN, field: "returnPolicy", choice: { mode: "set", value: { id: "R4" } } })).toEqual({ kind: "finish_first" });
  });

  it("[Check new prices] puts the choice in the draft: start, edit, finish first, locked, no change", () => {
    expect(productPriceEditAction({ draft: null, editor: EDITOR, own: OWN, change: SET }))
      .toEqual({ kind: "start", base: productPriceDraftValue(OWN), value: productPriceDraftValue(OWN, { ...SET, check: null }) });
    expect(productPriceEditAction({ draft: null, editor: EDITOR, own: OWN, change: { price: { mode: "default" }, releaseExactPrices: false } })).toEqual({ kind: "no_change", value: null });
    expect(productPriceEditAction({ draft: null, editor: EDITOR, own: PRICED, change: { price: { mode: "default" }, releaseExactPrices: false } })).toMatchObject({ kind: "start" });
    expect(productPriceEditAction({ draft: null, editor: EDITOR, own: PRICED, change: { price: { mode: "set", value: { ...RETAIL_20_UP } }, releaseExactPrices: false } })).toEqual({ kind: "no_change", value: null });
    expect(productPriceEditAction({ draft: null, editor: EDITOR, own: OWN, change: { price: { mode: "leave" }, releaseExactPrices: true } })).toMatchObject({ kind: "start" });
    // Over the settings or a size's price: finish first (D2).
    const settings = draftOf(productSettingsDraftValue(OWN), productSettingsDraftValue(OWN, choices({ shippingPolicy: { mode: "set", value: { id: "F9" } } })));
    expect(settings.changes).toBe(1);
    expect(productPriceEditAction({ draft: settings, editor: EDITOR, own: OWN, change: SET })).toEqual({ kind: "finish_first" });
    const sizeValue = sizePriceDraftValue({ productVariantId: 101, expectedRevisionId: 7, exact: "14.99" });
    expect(productPriceEditAction({ draft: draftOf(sizeValue, { ...sizeValue, exact: "12.00" }), editor: EDITOR, own: OWN, change: SET })).toEqual({ kind: "finish_first" });
    // Nothing to check over a clean settings draft, or over an unchanged other product's draft, opens nothing either.
    expect(productPriceEditAction({ draft: draftOf(productSettingsDraftValue(OWN)), editor: EDITOR, own: OWN, change: { price: { mode: "default" }, releaseExactPrices: false } })).toEqual({ kind: "no_change", value: null });
    // A price draft with changes keeps its start (the price and revision the vendor saw, D6a) and drops its check; reopen when hidden.
    const held = priceDraft(OWN, { ...SET, check: CHECK });
    expect(productPriceEditAction({ draft: held, editor: EDITOR, own: own({}, 9), change: { price: { mode: "default" }, releaseExactPrices: true } })).toEqual({
      kind: "edit", reopen: false, value: { priceChange: { price: { mode: "leave" }, releaseExactPrices: true, check: null }, ownPrice: null, revisionId: 5 },
    });
    // The choice undoes the change the draft holds (Use default while the product follows it, its own recipe again, the only
    // release unticked): nothing to check, and the draft takes the clean value, so the bar reads "All saved".
    expect(productPriceEditAction({ draft: held, editor: EDITOR, own: own({}, 9), change: { price: { mode: "default" }, releaseExactPrices: false } }))
      .toEqual({ kind: "no_change", value: productPriceDraftValue(OWN) });
    const heldPriced = priceDraft(PRICED, { ...SET, check: CHECK });
    expect(productPriceEditAction({ draft: heldPriced, editor: EDITOR, own: PRICED, change: { price: { mode: "set", value: { ...RETAIL_20_UP } }, releaseExactPrices: false } }))
      .toEqual({ kind: "no_change", value: productPriceDraftValue(PRICED) });
    const release = priceDraft(OWN, { price: { mode: "leave" }, releaseExactPrices: true, check: CHECK });
    expect(productPriceEditAction({ draft: release, editor: EDITOR, own: OWN, change: { price: { mode: "leave" }, releaseExactPrices: false } }))
      .toEqual({ kind: "no_change", value: productPriceDraftValue(OWN) });
    expect(productPriceEditAction({ draft: reduceListingSettingsDraft(held, { type: "close" }), editor: EDITOR, own: OWN, change: SET })).toMatchObject({ kind: "edit", reopen: true });
    const saving = reduceListingSettingsDraft(held, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(productPriceEditAction({ draft: saving, editor: EDITOR, own: OWN, change: SET })).toEqual({ kind: "locked" });
    // Saved: the next change starts from the own read as it is now.
    const saved = reduceListingSettingsDraft(saving, { type: "saved", key: "k", nowMs: 1 })!;
    expect(productPriceEditAction({ draft: saved, editor: EDITOR, own: own({ price: COST_35 }, 9), change: { price: { mode: "default" }, releaseExactPrices: false } }))
      .toEqual({ kind: "start", base: productPriceDraftValue(own({ price: COST_35 }, 9)), value: productPriceDraftValue(own({ price: COST_35 }, 9), { price: { mode: "default" }, releaseExactPrices: false, check: null }) });
  });

  it("puts the check in and takes it out, and compares the start with the own read (D6a)", () => {
    const value = productPriceDraftValue(OWN, { ...SET, check: null });
    expect(productPriceDraftWithCheck(value, CHECK)).toEqual({ ...value, priceChange: { ...value.priceChange, check: CHECK } });
    expect(productPriceDraftWithCheck(productPriceDraftWithCheck(value, CHECK), null)).toEqual(value);
    expect(productPriceDraftWithCheck(value, CHECK).priceChange.check).not.toBe(CHECK);
    expect(productPriceBaseOf(OWN)).toEqual({ ownPrice: null, revisionId: 5 });
    expect(productPriceBaseOf(PRICED)).toEqual({ ownPrice: RETAIL_20_UP, revisionId: 5 });
    expect(productPriceBaseMoved(productPriceBaseOf(OWN), { ownPrice: null, revisionId: 5 })).toBe(false);
    expect(productPriceBaseMoved(productPriceBaseOf(PRICED), { ownPrice: { ...RETAIL_20_UP }, revisionId: 5 })).toBe(false);
    expect(productPriceBaseMoved(productPriceBaseOf(OWN), { ownPrice: null, revisionId: 6 })).toBe(true);
    expect(productPriceBaseMoved(productPriceBaseOf(OWN), { ownPrice: RETAIL_20_UP, revisionId: 5 })).toBe(true);
    expect(productPriceBaseMoved(productPriceBaseOf(PRICED), { ownPrice: COST_35, revisionId: 5 })).toBe(true);
    expect(productPriceBaseMoved({ ownPrice: null, revisionId: null }, { ownPrice: null, revisionId: null })).toBe(false);
  });

  it("Load latest keeps the vendor's price on what is saved now, marks a price both changed, and says when nothing is left", () => {
    const mine = productPriceDraftValue(OWN, { ...SET, check: CHECK });
    const latest = own({ price: RETAIL_20_UP }, 6);
    expect(rebaseProductPriceDraft(mine, latest)).toEqual({
      edited: productPriceDraftValue(latest, { ...SET, check: null }),
      latest: productPriceDraftValue(latest),
      marked: ["priceChange"],
      keeps: true,
    });
    // The other window saved the very same price: nothing of the vendor's is left to keep.
    expect(rebaseProductPriceDraft(mine, own({ price: COST_35 }, 6))).toMatchObject({ keeps: false, marked: [] });
    // Only the revision moved (a settings save elsewhere): the price stays a change, not marked.
    expect(rebaseProductPriceDraft(mine, own({}, 6))).toEqual({ edited: productPriceDraftValue(own({}, 6), { ...SET, check: null }), latest: productPriceDraftValue(own({}, 6)), marked: [], keeps: true });
    // A release alone stays a change; "Use default" on a product that now follows the default is nothing.
    expect(rebaseProductPriceDraft(productPriceDraftValue(PRICED, { price: { mode: "leave" }, releaseExactPrices: true, check: CHECK }), own({}, 6))).toMatchObject({ keeps: true, marked: [] });
    expect(rebaseProductPriceDraft(productPriceDraftValue(PRICED, { price: { mode: "default" }, releaseExactPrices: false, check: null }), own({}, 6))).toMatchObject({ keeps: false, marked: [] });
  });

  it("takes W7's right alone: a recipe and Use default with it, nothing without (D3)", () => {
    expect(productPriceRights({ priceCheck: { editable: true, reason: null } })).toEqual({ canSet: true, canDefault: true, canNone: false, reason: null });
    expect(productPriceRights({ priceCheck: { editable: false, reason: "banner" } })).toEqual({ canSet: false, canDefault: false, canNone: false, reason: "banner" });
    expect(productPriceRights(rights({ blocked: { kind: "selling_paused", diagnosticReference: null } }))).toMatchObject({ canSet: false, reason: "banner" });
    expect(productPriceRights(rights({ blocked: { kind: "sign_in", diagnosticReference: null } }))).toMatchObject({ canSet: true, canDefault: true });
  });
});
