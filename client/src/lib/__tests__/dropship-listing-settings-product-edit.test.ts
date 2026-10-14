import { describe, expect, it } from "vitest";
import { saveProductSettingsInputSchema } from "@shared/dropship/listing-setting-writes";
import { listingSettingsProductOwnSettingsSchema, type ListingSettingsProductDetail } from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  listingSettingsEditRights,
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
import {
  PRODUCT_EDIT_FIELDS,
  ProductSettingsRequestError,
  changedFields,
  choicesFromOwn,
  decideDrawerEdit,
  drawerChangeKind,
  emptyChoices,
  fieldChoiceReady,
  markedAfterReload,
  policyFieldEditor,
  productFieldRights,
  productSettingsDraftValue,
  productSettingsEditAction,
  productSettingsPatch,
  productSettingsSaveBody,
  productSettingsSignature,
  readProductSettingsDraft,
  rebaseProductSettingsDraft,
  sizeLeftoverFields,
  type DrawerChangeKind,
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
  it("edits the three policies in 10a, in the drawer's order", () => {
    expect(PRODUCT_EDIT_FIELDS).toEqual(["shippingPolicy", "returnPolicy", "paymentPolicy"]);
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
    });
    expect(choicesFromOwn(NONE_OWN)).toEqual({ shippingPolicy: { mode: "default" }, returnPolicy: { mode: "default" }, paymentPolicy: { mode: "default" } });
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
    expect(build({ price: null })).toThrow(ProductSettingsRequestError);
    expect(build({ mainText: { text: "Mine" } })).toThrow(/doesn't save/);
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
    type Settings = Pick<ListingSettingsProductDetail["settings"], "shippingPolicy" | "returnPolicy" | "paymentPolicy">;
    const entry = (policyId: string, source: "size" | "product" | "category" | "store_default", ids: number[]) =>
      ({ value: { policyId }, sources: [{ source, ruleName: source === "category" ? "Sleeves" : null, productVariantIds: ids }] });
    const settings: Settings = {
      shippingPolicy: [entry("F1", "store_default", [101, 102])],
      returnPolicy: [entry("R1", "product", [101]), entry("R9", "size", [102])],
      paymentPolicy: [{ value: { policyId: "P1" }, sources: [
        { source: "product", ruleName: null, productVariantIds: [101] }, { source: "size", ruleName: null, productVariantIds: [102] }] }],
    };
    expect(sizeLeftoverFields(settings)).toEqual(["returnPolicy", "paymentPolicy"]);
    expect(sizeLeftoverFields({ ...settings, returnPolicy: [entry("R1", "category", [101, 102])], paymentPolicy: [entry("P1", "product", [101, 102])] }))
      .toEqual([]);
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
  it("lets every field be set and reset when every right is there", () => {
    for (const field of PRODUCT_EDIT_FIELDS) expect(productFieldRights(rights(), field)).toEqual({ canSet: true, canDefault: true, reason: null });
  });

  it("leaves only Use default under a sign-in or an eBay refusal (D4)", () => {
    const signIn = rights({ summary: { storeStatus: "needs_reauth", catalog: { state: "ok", products: 3, sizes: 9 } } });
    const signInCode = rights({ blocked: { kind: "sign_in", diagnosticReference: null } });
    const denied = rights({ setup: { error: new DropshipApiError({ message: "x", status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED" }) } });
    for (const field of PRODUCT_EDIT_FIELDS) {
      expect(productFieldRights(signIn, field)).toEqual({ canSet: false, canDefault: true, reason: "sign_in" });
      expect(productFieldRights(signInCode, field)).toEqual({ canSet: false, canDefault: true, reason: "sign_in" });
      expect(productFieldRights(denied, field)).toMatchObject({ canSet: false, canDefault: true });
    }
  });

  it("leaves Use default while eBay or Card Shellz shipping can't be read, which a pick needs", () => {
    const down = rights({ setup: { error: new DropshipApiError({ message: "x", status: 502, code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE" }) } });
    expect(productFieldRights(down, "returnPolicy")).toEqual({ canSet: false, canDefault: true, reason: "unreachable" });
    const loading = rights({ setup: { data: undefined, error: null } });
    expect(productFieldRights(loading, "paymentPolicy")).toEqual({ canSet: false, canDefault: true, reason: "checking_ebay" });
    const shipping = rights({ setup: { data: { ...setupChecked, checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "R", kind: "setup_incomplete" } } } } });
    expect(productFieldRights(shipping, "shippingPolicy")).toEqual({ canSet: false, canDefault: true, reason: "shipping_setup" });
    expect(productFieldRights(shipping, "returnPolicy")).toEqual({ canSet: true, canDefault: true, reason: null });
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
      for (const field of PRODUCT_EDIT_FIELDS) expect(productFieldRights(cell, field)).toEqual({ canSet: false, canDefault: false, reason: "banner" });
    }
    // The paused vendor's store shelf right stays on for W2, but a product's settings stay off (C16).
    expect(cells[0].shelfPick.editable).toBe(true);
    expect(productFieldRights(rights({ account: null }), "shippingPolicy")).toEqual({ canSet: false, canDefault: false, reason: "loading" });
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
  const editor = (field: (typeof PRODUCT_EDIT_FIELDS)[number], overrides: Partial<Parameters<typeof policyFieldEditor>[0]> = {}) =>
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
