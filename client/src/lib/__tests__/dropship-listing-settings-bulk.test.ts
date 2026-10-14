import { describe, expect, it } from "vitest";
import { MAX_LISTING_SETTING_BULK_PRODUCTS } from "@shared/dropship/listing-setting-values";
import { MAX_BULK_TEXT_BYTES, patchTextBytes, saveProductsBulkInputSchema } from "@shared/dropship/listing-setting-writes";
import { listingSettingsProductIdsResponseSchema } from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  listingSettingsEditRights,
  type ListingSettingsReadState,
  type ListingSettingsRightsInput,
  type ListingSetupFacts,
} from "../dropship-listing-settings-access";
import {
  BULK_EDITOR_ID,
  classifyWriteFailure,
  productEditorId,
  reduceListingSettingsDraft,
  type DraftValue,
  type ListingSettingsDraft,
} from "../dropship-listing-settings-drafts";
import { descriptionEditorResult, readProductSettingsDraft, type DescriptionEditorState } from "../dropship-listing-settings-product-edit";
import {
  BULK_EDIT_FIELDS,
  BulkRequestError,
  bulkChangedFields,
  bulkAfterSave,
  bulkDescriptionEditorResult,
  bulkDescriptionFieldEditor,
  bulkDiscard,
  bulkDraftValue,
  bulkEbayCategoryFieldEditor,
  bulkEditAction,
  bulkFieldChoiceReady,
  bulkFieldRights,
  bulkHoldsSave,
  bulkPatch,
  bulkPolicyFieldEditor,
  bulkReload,
  bulkSaveBody,
  bulkSavedFor,
  bulkSelectionBar,
  bulkSettingRows,
  bulkSheetOpen,
  bulkSheetState,
  bulkSignature,
  bulkStoreShelfEditorChoice,
  bulkStoreShelfFieldEditor,
  bulkTextBytes,
  bulkTextTooLarge,
  emptyBulkChoices,
  readBulkDraft,
  type BulkChoices,
  type BulkSheetInput,
} from "../dropship-listing-settings-bulk";
import { emptySelection, reduceListingSettingsSelection, sameSelection, type PickedProducts } from "../dropship-listing-settings-selection";
import type { PolicySetupFacts } from "../dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";

/** "Set for selected" (plan PR 10, 6.2-6.6; W6). */

const STORE = 22;
const PRODUCTS = [{ productId: 12, expectedRevisionId: null }, { productId: 11, expectedRevisionId: 5 }] as const;
const choices = (overrides: Partial<BulkChoices>): BulkChoices => ({ ...emptyBulkChoices(), ...overrides });
const picked = (products: PickedProducts["products"], extra: Partial<PickedProducts> = {}): PickedProducts =>
  ({ products, missing: 0, total: products.length, matched: null, ...extra });

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

const SETUP: PolicySetupFacts = {
  selection: { merchantLocationKey: "cs", fulfillmentPolicyId: "F1", returnPolicyId: null, paymentPolicyId: "P1" },
  storedNames: { fulfillmentPolicyName: null, returnPolicyName: null, paymentPolicyName: null },
  options: {
    merchantLocations: [],
    fulfillmentPolicies: [{ id: "F1", name: "Standard", compatible: true, compatibilityChecked: true, compatibilityIssues: [] }],
    returnPolicies: [{ id: "R1", name: "30 days" }],
    paymentPolicies: [{ id: "P1", name: "eBay payments" }],
  },
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  fulfillmentCapability: null,
};
const LIVE: ListingSettingsReadState<PolicySetupFacts> = { data: SETUP, error: null };
const SHELVES = [{ categoryId: "S1", categoryName: "Sleeves", path: "Supplies:Sleeves", level: 1 }];

/** The sheet's draft opened on `products`, then edited to `edit`. Every step frozen, so a mutation would throw. */
function bulkDraft(edit: Partial<BulkChoices> = {}, products: PickedProducts["products"] = PRODUCTS): ListingSettingsDraft {
  const base = bulkDraftValue(products);
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: BULK_EDITOR_ID, place: "Set for selected", base: Object.freeze(base) });
  return Object.freeze(reduceListingSettingsDraft(Object.freeze(opened!), { type: "edit", value: Object.freeze(bulkDraftValue(products, choices(edit))) })!);
}

/** Own text above of `bytes` UTF-8 bytes, in 2-byte characters (4,000 characters = 8,000 bytes, the most one part holds). */
const twoByteText = (bytes: number) => "é".repeat(bytes / 2);

describe("the choices (plan 6.2)", () => {
  it("sets the drawer's eight settings, never the price, each starting as Leave as is", () => {
    expect(BULK_EDIT_FIELDS).toEqual(["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "textAbove", "textBelow", "mainText"]);
    expect(BULK_EDIT_FIELDS).not.toContain("price");
    expect(bulkChangedFields(emptyBulkChoices())).toEqual([]);
    expect(bulkChangedFields(choices({ mainText: { mode: "default" }, shippingPolicy: { mode: "set", value: { id: "F1" } } })))
      .toEqual(["shippingPolicy", "mainText"]);
  });
});

describe("bulkPatch and the W6 body (plan 6.2, D1)", () => {
  it("sends Leave as absent, Use default as null and Set as ids or text only, with no price key at all", () => {
    const patch = bulkPatch(choices({
      shippingPolicy: { mode: "set", value: { id: "F1" } },
      returnPolicy: { mode: "default" },
      ebayCategory: { mode: "set", value: { categoryId: "183454", categoryName: "Card Sleeves" } },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S2", "S1"] } },
      textAbove: { mode: "set", value: { mode: "own", text: "Ships today." } },
      textBelow: { mode: "set", value: { mode: "none" } },
      mainText: { mode: "default" },
    }));
    expect(patch).toEqual({
      shippingPolicy: { id: "F1" }, returnPolicy: null, ebayCategory: { categoryId: "183454" },
      storeShelf: { mode: "own", shelfIds: ["S2", "S1"] }, textAbove: { mode: "own", text: "Ships today." }, textBelow: { mode: "none" },
      mainText: null,
    });
    expect(Object.keys(patch)).not.toContain("price");
    expect(JSON.stringify(patch)).not.toMatch(/Card Sleeves|price/);
    expect(bulkPatch(emptyBulkChoices())).toEqual({});
  });

  it("builds a body the shared schema takes: products ascending, text as the server stores it", () => {
    const body = bulkSaveBody({ key: "ls-bulk:1", products: PRODUCTS, patch: { textAbove: { mode: "own", text: "  Ships today.\r\n" }, mainText: null } });
    expect(body).toEqual({
      idempotencyKey: "ls-bulk:1",
      products: [{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }],
      patch: { textAbove: { mode: "own", text: "Ships today." }, mainText: null },
    });
    expect(saveProductsBulkInputSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body)).toEqual(["idempotencyKey", "products", "patch"]);
  });

  it("refuses before sending: Leave everywhere, a price (even null), own main text, no product, a product twice, more than 10,000", () => {
    const refuse = (input: Parameters<typeof bulkSaveBody>[0]) => expect(() => bulkSaveBody(input)).toThrow(BulkRequestError);
    refuse({ key: "ls-bulk:1", products: PRODUCTS, patch: {} });
    refuse({ key: "ls-bulk:1", products: PRODUCTS, patch: { shippingPolicy: undefined } });
    refuse({ key: "ls-bulk:1", products: PRODUCTS, patch: { price: null } as never });
    refuse({ key: "ls-bulk:1", products: PRODUCTS, patch: { price: { kind: "retail_percent", percentBps: 1000 } } as never });
    refuse({ key: "ls-bulk:1", products: PRODUCTS, patch: { mainText: { text: "Our own words." } } });
    refuse({ key: "ls-bulk:1", products: [], patch: { mainText: null } });
    refuse({ key: "ls-bulk:1", products: [PRODUCTS[0], PRODUCTS[0]], patch: { mainText: null } });
    refuse({ key: "x", products: PRODUCTS, patch: { mainText: null } });
    const tooMany = Array.from({ length: MAX_LISTING_SETTING_BULK_PRODUCTS + 1 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null }));
    refuse({ key: "ls-bulk:1", products: tooMany, patch: { mainText: null } });
    expect(bulkSaveBody({ key: "ls-bulk:1", products: tooMany.slice(1), patch: { mainText: null } }).products).toHaveLength(10_000);
    const named = (() => {
      try { bulkSaveBody({ key: "ls-bulk:1", products: PRODUCTS, patch: { price: null } as never }); } catch (error) { return error; }
      return null;
    })();
    expect(named).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_REQUEST_INVALID", context: { fields: ["price"] } });
  });

  it("keeps a 10,000-product body inside the 1 MiB parser, at the most text the budget lets through", () => {
    // `S/interfaces/http/dropship-bulk-json.middleware.ts` DROPSHIP_BULK_JSON_LIMIT_BYTES (the server's; not imported into a client test).
    const BULK_JSON_LIMIT_BYTES = 1024 * 1024;
    const products = Array.from({ length: MAX_LISTING_SETTING_BULK_PRODUCTS }, (_, index) => ({
      productId: 2_147_483_647 - index, expectedRevisionId: 2_147_483_647 - index,
    }));
    // 30,000,000 / 10,000 = 3,000 bytes of text a product: the most the budget passes for 10,000 products.
    const text = "x".repeat(1_500);
    const patch = {
      shippingPolicy: { id: "p".repeat(100) }, returnPolicy: { id: "r".repeat(100) }, paymentPolicy: { id: "y".repeat(100) },
      ebayCategory: { categoryId: "1".repeat(10) }, storeShelf: { mode: "own" as const, shelfIds: ["s".repeat(100), "t".repeat(100)] },
      textAbove: { mode: "own" as const, text }, textBelow: { mode: "own" as const, text }, mainText: null,
    };
    expect(bulkTextBytes(products.length, patch)).toBe(MAX_BULK_TEXT_BYTES);
    const body = bulkSaveBody({ key: `ls-bulk:${"k".repeat(192)}`, products, patch });
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    expect(bytes).toBeLessThanOrEqual(BULK_JSON_LIMIT_BYTES);
  });
});

describe("the text budget (plan 6.5; S/application/dropship-listing-products-bulk-service.ts)", () => {
  it("is the server's: products x the patch's UTF-8 bytes against MAX_BULK_TEXT_BYTES", () => {
    expect(MAX_BULK_TEXT_BYTES).toBe(30_000_000);
    // 3,750 x 8,000 = 30,000,000: at the budget, it passes; 3,751 does not (the server's `>`).
    const eightThousand = { textAbove: { mode: "own" as const, text: twoByteText(8_000) } };
    expect(eightThousand.textAbove.text).toHaveLength(4_000);
    expect(patchTextBytes(eightThousand)).toBe(8_000);
    expect(bulkTextBytes(3_750, eightThousand)).toBe(30_000_000);
    expect(bulkTextTooLarge(3_750, eightThousand)).toBe(false);
    expect(bulkTextTooLarge(3_751, eightThousand)).toBe(true);
    // The same bytes from text above and below of 4,000 plain characters each.
    const both = { textAbove: { mode: "own" as const, text: "a".repeat(4_000) }, textBelow: { mode: "own" as const, text: "b".repeat(4_000) } };
    expect(bulkTextTooLarge(3_750, both)).toBe(false);
    expect(bulkTextTooLarge(3_751, both)).toBe(true);
  });

  it("counts UTF-8 bytes, not characters, of the text as stored, and nothing for None, Use default or a reset", () => {
    expect(bulkTextBytes(1, { textAbove: { mode: "own", text: "€" } })).toBe(3);
    // One emoji is 2 UTF-16 units and 4 bytes.
    expect(bulkTextBytes(1, { textBelow: { mode: "own", text: "🃏" } })).toBe(4);
    expect(bulkTextBytes(2, { textAbove: { mode: "own", text: "é" }, textBelow: { mode: "own", text: "ab" } })).toBe(8);
    // As stored: CRLF is one line break and the ends are trimmed (`SH/listing-content.ts`).
    expect(bulkTextBytes(1, { textAbove: { mode: "own", text: "  a\r\nb  " } })).toBe(3);
    expect(bulkTextBytes(10_000, { textAbove: { mode: "none" }, textBelow: null, mainText: null, shippingPolicy: { id: "F1" } })).toBe(0);
    expect(bulkTextBytes(0, { textAbove: { mode: "own", text: "x" } })).toBe(0);
  });

  it("refuses a body over the budget before it is sent, and takes one at it", () => {
    const products = Array.from({ length: 3_751 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null }));
    const patch = { textAbove: { mode: "own" as const, text: twoByteText(8_000) } };
    expect(() => bulkSaveBody({ key: "ls-bulk:1", products, patch })).toThrow(expect.objectContaining({
      code: "DROPSHIP_LISTING_SETTINGS_BULK_REQUEST_INVALID", context: expect.objectContaining({ reason: "text_budget", productCount: 3_751 }),
    }));
    expect(bulkSaveBody({ key: "ls-bulk:1", products: products.slice(1), patch }).products).toHaveLength(3_750);
  });
});

describe("bulkSignature (D5)", () => {
  const patch = { shippingPolicy: { id: "F1" }, storeShelf: { mode: "own" as const, shelfIds: ["S1", "S2"] } };

  it("is the same whatever order the products or the patch's keys come in", () => {
    const reversed = [...PRODUCTS].reverse();
    expect(bulkSignature(STORE, PRODUCTS, patch)).toBe(bulkSignature(STORE, reversed, patch));
    expect(bulkSignature(STORE, PRODUCTS, patch)).toBe(bulkSignature(STORE, PRODUCTS, { storeShelf: { shelfIds: ["S1", "S2"], mode: "own" }, shippingPolicy: { id: "F1" } }));
  });

  it("differs by revision, by product, by store, by patch and by shelf order", () => {
    const base = bulkSignature(STORE, PRODUCTS, patch);
    expect(bulkSignature(STORE, [PRODUCTS[0], { productId: 11, expectedRevisionId: 6 }], patch)).not.toBe(base);
    expect(bulkSignature(STORE, [PRODUCTS[0]], patch)).not.toBe(base);
    expect(bulkSignature(23, PRODUCTS, patch)).not.toBe(base);
    expect(bulkSignature(STORE, PRODUCTS, { ...patch, shippingPolicy: null })).not.toBe(base);
    expect(bulkSignature(STORE, PRODUCTS, { ...patch, storeShelf: { mode: "own", shelfIds: ["S2", "S1"] } })).not.toBe(base);
  });
});

describe("bulkFieldRights (D3, D4)", () => {
  it("gives every row while W6 and the eBay reads allow, and the main text only its reset", () => {
    for (const field of BULK_EDIT_FIELDS) {
      const canNone = field === "storeShelf" || field === "textAbove" || field === "textBelow";
      expect({ field, rights: bulkFieldRights(rights(), field) })
        .toEqual({ field, rights: { canSet: field !== "mainText", canDefault: true, canNone, reason: null } });
    }
  });

  it("leaves Use default (and None) only under a sign-in or eBay refusing access; own text stays (D4)", () => {
    for (const cell of [rights({ blocked: { kind: "sign_in", diagnosticReference: null } }), rights({ blocked: { kind: "access_denied", diagnosticReference: null } })]) {
      for (const field of ["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf"] as const) {
        expect(bulkFieldRights(cell, field)).toMatchObject({ canSet: false, canDefault: true, canNone: field === "storeShelf" });
      }
      expect(bulkFieldRights(cell, "textAbove")).toMatchObject({ canSet: true, canDefault: true, canNone: true });
    }
    expect(bulkFieldRights(rights({ blocked: { kind: "sign_in", diagnosticReference: null } }), "shippingPolicy").reason).toBe("sign_in");
  });

  it("takes every row away, the shelf and the text included, when W6 is off (D3)", () => {
    for (const cell of [
      rights({ account: { status: "paused", entitlementStatus: "active" } }),
      rights({ account: { status: "active", entitlementStatus: "lapsed" } }),
      rights({ summary: { storeStatus: "paused", catalog: { state: "ok", products: 3, sizes: 9 } } }),
      rights({ summary: { storeStatus: "connected", catalog: { state: "too_large", limit: 10_000 } } }),
      rights({ blocked: { kind: "other_site", diagnosticReference: null } }),
    ]) {
      for (const field of BULK_EDIT_FIELDS) {
        expect({ field, rights: bulkFieldRights(cell, field) }).toEqual({ field, rights: { canSet: false, canDefault: false, canNone: false, reason: "banner" } });
      }
    }
    expect(bulkFieldRights(rights({ account: null }), "textBelow")).toEqual({ canSet: false, canDefault: false, canNone: false, reason: "loading" });
  });
});

describe("the draft (plan 6.2, D6, D16)", () => {
  it("holds the ids read's products ascending, each with its revision, and one field per row", () => {
    const value = bulkDraftValue(PRODUCTS);
    expect(value.products).toEqual([{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }]);
    expect(readBulkDraft(value)).toBe(value);
    const draft = bulkDraft({ shippingPolicy: { mode: "default" }, mainText: { mode: "default" } });
    expect(draft).toMatchObject({ editor: "bulk", changes: 2 });
    // The products never count as a change while base and value name the same ones, with the same revisions.
    expect(draft.value.products).toEqual(draft.base.products);
    // A value on other revisions counts them as one more change, so a draft on old products can't hide.
    const moved = reduceListingSettingsDraft(draft, { type: "edit", value: bulkDraftValue([{ productId: 11, expectedRevisionId: 6 }, PRODUCTS[0]],
      choices({ shippingPolicy: { mode: "default" }, mainText: { mode: "default" } })) });
    expect(moved?.changes).toBe(3);
  });

  it("tells a bulk draft from a product's, and refuses one it can't trust", () => {
    const value = bulkDraftValue(PRODUCTS) as unknown as Record<string, unknown>;
    expect(readProductSettingsDraft(value as DraftValue)).toBeNull();
    for (const bad of [
      { ...value, products: undefined },
      { ...value, products: [{ productId: 11, expectedRevisionId: 5 }, { productId: 11, expectedRevisionId: 5 }] },
      { ...value, products: [{ productId: 0, expectedRevisionId: null }] },
      { ...value, products: [{ productId: 11, expectedRevisionId: 0 }] },
      { ...value, products: [{ productId: 11 }] },
      { ...value, products: Array.from({ length: 10_001 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null })) },
      { ...value, mainText: { mode: "set", value: { text: "Own." } } },
      { ...value, shippingPolicy: { mode: "set", value: { id: "" } } },
      { ...value, textAbove: undefined },
    ]) expect(readBulkDraft(bad as DraftValue)).toBeNull();
    expect(readBulkDraft({ ...value, products: [] } as DraftValue)).not.toBeNull();
  });

  it("puts an editor's choices in the open draft, on the same products; Leave as is takes a row back", () => {
    const draft = bulkDraft({ shippingPolicy: { mode: "default" } });
    const picks = { returnPolicy: { mode: "set" as const, value: { id: "R1" } } };
    const action = bulkEditAction({ draft, picks });
    expect(action.kind).toBe("edit");
    if (action.kind !== "edit") return;
    expect(action.value).toMatchObject({ shippingPolicy: { mode: "default" }, returnPolicy: { mode: "set", value: { id: "R1" } } });
    expect(action.value.products).toBe(readBulkDraft(draft.value)!.products);
    // Its own copy: the editor's object is never the draft's.
    expect(action.value.returnPolicy).not.toBe(picks.returnPolicy);
    const back = bulkEditAction({ draft, picks: { shippingPolicy: { mode: "leave" } } });
    expect(back.kind === "edit" && bulkChangedFields(back.value)).toEqual([]);
  });

  it("waits for the sheet's draft, stays still while a save is out or unconfirmed, and refuses a pick it doesn't set", () => {
    expect(bulkEditAction({ draft: null, picks: { mainText: { mode: "default" } } })).toEqual({ kind: "not_open" });
    const product = reduceListingSettingsDraft(null, { type: "open", editor: productEditorId(11), place: "Easy Glide Soft Sleeves", base: {} });
    expect(bulkEditAction({ draft: product, picks: { mainText: { mode: "default" } } })).toEqual({ kind: "not_open" });
    const saving = reduceListingSettingsDraft(bulkDraft({ mainText: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "ls-bulk:1" } });
    expect(bulkEditAction({ draft: saving, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "locked" });
    const uncertain = reduceListingSettingsDraft(saving, {
      type: "failure", key: "ls-bulk:1", failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null, fields: [] },
    });
    expect(bulkEditAction({ draft: uncertain, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "locked" });
    for (const picks of [{ price: { mode: "default" } }, { mainText: { mode: "set", value: { text: "Own." } } }, { shippingPolicy: { mode: "set", value: {} } }]) {
      expect(() => bulkEditAction({ draft: bulkDraft(), picks: picks as never })).toThrow(/doesn't set/);
    }
  });
});

describe("bulkSettingRows (plan 6.3, 3.4)", () => {
  const rows = (draft: ListingSettingsDraft | null, overrides: Partial<Parameters<typeof bulkSettingRows>[0]> = {}) =>
    bulkSettingRows({ draft, rights: rights(), openTarget: null, failure: null, setup: LIVE, shelves: SHELVES, ...overrides });

  it("gives the drawer's six rows, each reading Leave as is with Change, and its change below it, by name only", () => {
    const shown = rows(bulkDraft({
      shippingPolicy: { mode: "set", value: { id: "F1" } }, returnPolicy: { mode: "default" },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S1"] } },
      textAbove: { mode: "set", value: { mode: "own", text: "Ships today." } }, mainText: { mode: "default" },
    }));
    expect(shown.map((row) => [row.key, row.label])).toEqual([
      ["shippingPolicy", "Shipping policy"], ["returnPolicy", "Return policy"], ["paymentPolicy", "Payment policy"],
      ["ebayCategory", "eBay category"], ["storeShelf", "Store shelf"], ["descriptionTemplate", "Description"],
    ]);
    for (const row of shown) {
      expect(row.groups).toEqual([{ entries: [{ value: "Leave as is", tags: [], usedBy: null }], differ: null }]);
      expect(row.notes).toEqual([]);
      expect(row.edit).toMatchObject({ change: { shown: true, disabled: false }, picksDisabled: true, line: null, open: false, fieldError: null });
    }
    expect(shown.map((row) => row.edit?.pending)).toEqual([
      "→ Standard · Not saved", "→ Use default · Not saved", null, null, "→ Supplies › Sleeves · Not saved",
      "→ Text above: your own, main text: Card Shellz text · Not saved",
    ]);
    expect(shown[5].edit).toMatchObject({ kind: "description", check: null, choices: { textBelow: { mode: "leave" }, mainText: { mode: "default" } } });
    // The words shown name values, never an id, a code or the text itself.
    const words = shown.flatMap((row) => [...row.groups.flatMap((group) => group.entries.map((entry) => entry.value)), row.edit?.pending, row.edit?.line]);
    expect(JSON.stringify(words)).not.toMatch(/S1|F1|DROPSHIP_|Ships today/);
  });

  it("waits for the sheet's draft and for a save out or unconfirmed; marks the editor open and a refused row", () => {
    expect(rows(null).every((row) => row.edit?.change.disabled === true)).toBe(true);
    const saving = reduceListingSettingsDraft(bulkDraft({ mainText: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "k" } });
    expect(rows(saving).every((row) => row.edit?.change.disabled === true)).toBe(true);
    // While locked, the rows keep showing what the save sends.
    expect(rows(saving)[5].edit?.pending).toBe("→ Main text: Card Shellz text · Not saved");
    const failure = { message: "That shelf is gone from your eBay store.", fields: ["storeShelf"] };
    const sent = reduceListingSettingsDraft(bulkDraft({ storeShelf: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "k" } });
    const refusedDraft = reduceListingSettingsDraft(sent, {
      type: "failure", key: "k", failure: { phase: "refused", message: failure.message, code: "C", status: 422, fields: failure.fields },
    });
    const refused = rows(refusedDraft, { openTarget: "description", failure });
    expect(refused.map((row) => row.edit?.fieldError ?? null)).toEqual([null, null, null, null, failure.message, null]);
    expect(refused.map((row) => row.edit?.open)).toEqual([false, false, false, false, false, true]);
    // Once the vendor changes something (editing again), or before any refusal, the words leave the row.
    expect(rows(bulkDraft({ storeShelf: { mode: "default" } }), { failure }).every((row) => row.edit?.fieldError === null)).toBe(true);
  });

  it("says why a row offers only Use default under a sign-in, and offers nothing while W6 is off", () => {
    const signIn = rows(bulkDraft(), { rights: rights({ blocked: { kind: "sign_in", diagnosticReference: null } }) });
    expect(signIn[0].edit).toMatchObject({ canSet: false, canDefault: true, line: LISTING_SETTINGS_EDIT_WORDS.signInFieldLine });
    expect(signIn[4].edit).toMatchObject({ canSet: false, canNone: true, line: LISTING_SETTINGS_EDIT_WORDS.signInFieldLine });
    // Text needs no eBay: the Description row keeps own text.
    expect(signIn[5].edit).toMatchObject({ canSet: true, line: null });
    const paused = rows(bulkDraft(), { rights: rights({ account: { status: "paused", entitlementStatus: "active" } }) });
    for (const row of paused) expect(row.edit).toMatchObject({ change: { shown: false }, canSet: false, canDefault: false, line: null });
  });
});

describe("the rows' editors in bulk mode (plan 6.3, UX-m5)", () => {
  const both = { canSet: true, canDefault: true, canNone: true };

  it("opens each editor on the draft's choice, else with nothing picked (Leave as is)", () => {
    expect(bulkPolicyFieldEditor({ field: "shippingPolicy", rights: both, draftChoice: { mode: "leave" }, setup: LIVE }))
      .toMatchObject({ initial: { mode: "leave" }, choices: [{ id: "F1", choosable: true }] });
    expect(bulkPolicyFieldEditor({ field: "returnPolicy", rights: both, draftChoice: { mode: "default" }, setup: LIVE }).initial).toEqual({ mode: "default" });
    expect(bulkEbayCategoryFieldEditor({ rights: both, draftChoice: { mode: "leave" } })).toEqual({
      field: "ebayCategory", canSet: true, canDefault: true, initial: { mode: "leave" }, initialQuery: "",
    });
    expect(bulkEbayCategoryFieldEditor({ rights: both, draftChoice: { mode: "set", value: { categoryId: "183454", categoryName: " Card Sleeves " } } }).initialQuery)
      .toBe("Card Sleeves");
    const shelf = bulkStoreShelfFieldEditor({ rights: both, draftChoice: { mode: "leave" }, shelves: SHELVES });
    expect(shelf).toMatchObject({ initial: { mode: "leave", first: null, second: null }, canNone: true });
    expect(shelf.options?.map((option) => option.categoryId)).toEqual(["S1"]);
    expect(bulkStoreShelfFieldEditor({ rights: both, draftChoice: { mode: "set", value: { mode: "own", shelfIds: ["S1"] } }, shelves: SHELVES }).initial)
      .toEqual({ mode: "own", first: "S1", second: null });
  });

  it("lets Done take a row back to Leave as is, and otherwise checks as the drawer does", () => {
    const policy = bulkPolicyFieldEditor({ field: "shippingPolicy", rights: both, draftChoice: { mode: "default" }, setup: LIVE });
    expect(bulkFieldChoiceReady(policy, { mode: "leave" })).toBe(true);
    expect(bulkFieldChoiceReady(policy, { mode: "set", value: { id: "F1" } })).toBe(true);
    expect(bulkFieldChoiceReady(policy, { mode: "set", value: { id: "F9" } })).toBe(false);
    const category = bulkEbayCategoryFieldEditor({ rights: { canSet: false, canDefault: true }, draftChoice: { mode: "leave" } });
    expect(bulkFieldChoiceReady(category, { mode: "default" })).toBe(true);
    expect(bulkFieldChoiceReady(category, { mode: "set", value: { categoryId: "183454" } })).toBe(false);
    const shelf = bulkStoreShelfFieldEditor({ rights: both, draftChoice: { mode: "default" }, shelves: SHELVES });
    expect(bulkStoreShelfEditorChoice(shelf, { mode: "leave", first: null, second: null })).toEqual({ ok: true, choice: { mode: "leave" } });
    expect(bulkStoreShelfEditorChoice(shelf, { mode: "own", first: "S1", second: null })).toEqual({ ok: true, choice: { mode: "set", value: { mode: "own", shelfIds: ["S1"] } } });
    expect(bulkStoreShelfEditorChoice(shelf, { mode: "own", first: "S9", second: null })).toEqual({ ok: false, problem: null });
  });

  it("offers the main text only as the Card Shellz text, and checks own text above and below as typed", () => {
    const model = bulkDescriptionFieldEditor({ rights: both, draftChoices: { textAbove: { mode: "leave" }, textBelow: { mode: "set", value: { mode: "none" } }, mainText: { mode: "leave" } } });
    expect(model).toEqual({
      initial: { textAbove: { mode: "leave", text: "" }, textBelow: { mode: "none", text: "" }, mainText: { mode: "leave", text: "" } },
      canSet: true, canDefault: true, canNone: true, mainTextOwn: false, check: null, conflictLine: null,
    });
    const state = (overrides: Partial<DescriptionEditorState>): DescriptionEditorState => ({ ...model.initial, ...overrides });
    expect(bulkDescriptionEditorResult(model, state({ textAbove: { mode: "own", text: "Ships today." }, mainText: { mode: "default", text: "" } }))).toEqual({
      ok: true, picks: { textAbove: { mode: "set", value: { mode: "own", text: "Ships today." } }, mainText: { mode: "default" } },
    });
    // A part taken back to Leave as is goes in as a leave.
    expect(bulkDescriptionEditorResult(model, state({ textBelow: { mode: "leave", text: "" } }))).toEqual({ ok: true, picks: { textBelow: { mode: "leave" } } });
    expect(bulkDescriptionEditorResult(model, state({ textAbove: { mode: "own", text: "x".repeat(4_001) } })))
      .toEqual({ ok: false, problems: { textAbove: "Shorten it to 4,000 characters or fewer." } });
    expect(() => bulkDescriptionEditorResult(model, state({ mainText: { mode: "own", text: "Own." } }))).toThrow(/only reset the main text/);
    // The drawer's own [Done] never puts own main text in through a model that doesn't offer it (`mainTextOwn: false`).
    expect(descriptionEditorResult(model, state({ mainText: { mode: "own", text: "Own." } }))).toEqual({ ok: true, picks: {} });
    expect(descriptionEditorResult({ ...model, mainTextOwn: undefined }, state({ mainText: { mode: "own", text: "Own." } })))
      .toEqual({ ok: true, picks: { mainText: { mode: "set", value: { text: "Own." } } } });
  });
});

describe("opening the sheet, Load latest and Discard (D6, D16, D21, plan 6.5)", () => {
  const NOW = [{ productId: 11, expectedRevisionId: 6 }, { productId: 12, expectedRevisionId: null }];
  const saving = () => reduceListingSettingsDraft(bulkDraft({ mainText: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "k" } });
  const conflict = () => reduceListingSettingsDraft(saving(), {
    type: "failure", key: "k", failure: { phase: "conflict", message: "1 of the selected products changed in another window.", code: "C", status: 409, fields: [] },
  });

  it("waits for a read made for this opening, and opens on it with every row Leave as is", () => {
    expect(bulkSheetOpen(null, null)).toEqual({ kind: "wait" });
    expect(bulkSheetOpen(bulkDraft({ mainText: { mode: "default" } }), null)).toEqual({ kind: "wait" });
    expect(bulkSheetOpen(null, picked(NOW))).toEqual({ kind: "open", base: bulkDraftValue(NOW) });
    // An unchanged sheet draft, or another editor's, takes the new read too.
    expect(bulkSheetOpen(bulkDraft(), picked(NOW))).toEqual({ kind: "open", base: bulkDraftValue(NOW) });
    const product = reduceListingSettingsDraft(null, { type: "open", editor: productEditorId(11), place: "x", base: { a: 1 } });
    expect(bulkSheetOpen(product, picked(NOW)).kind).toBe("open");
  });

  it("closes, reading nothing, when the address opens it over another editor's change or save (D16)", () => {
    const product = reduceListingSettingsDraft(null, { type: "open", editor: productEditorId(11), place: "x", base: { a: 1 } })!;
    const changed = reduceListingSettingsDraft(product, { type: "edit", value: { a: 2 } })!;
    expect(bulkSheetOpen(changed, null)).toEqual({ kind: "elsewhere" });
    expect(bulkSheetOpen(changed, picked(NOW))).toEqual({ kind: "elsewhere" });
    expect(bulkSheetOpen(reduceListingSettingsDraft(changed, { type: "startSave", attempt: { signature: "s", key: "k" } }), null)).toEqual({ kind: "elsewhere" });
  });

  it("keeps a save out or unconfirmed without a read, so Check again resends it; and changes on the very same products", () => {
    expect(bulkSheetOpen(saving(), null)).toEqual({ kind: "keep" });
    expect(bulkSheetOpen(saving(), picked(NOW))).toEqual({ kind: "keep" });
    expect(bulkSheetOpen(saving(), picked([]))).toEqual({ kind: "keep" });
    expect(bulkSheetOpen(bulkDraft({ mainText: { mode: "default" } }), picked([...PRODUCTS].reverse()))).toEqual({ kind: "keep" });
    // Saved elsewhere since (11 moved from 5 to 6): the change stays on the revision it was made against, so the save's 409 says so.
    expect(bulkSheetOpen(bulkDraft({ mainText: { mode: "default" } }), picked(NOW))).toEqual({ kind: "keep" });
  });

  it("moves held changes onto other products, keeping the revisions they were made against, and opens nothing when none is chosen", () => {
    const held = bulkDraft({ shippingPolicy: { mode: "default" } });
    const more = [...NOW, { productId: 13, expectedRevisionId: 2 }];
    const kept = [{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }, { productId: 13, expectedRevisionId: 2 }];
    expect(bulkSheetOpen(held, picked(more))).toEqual({
      kind: "restart", base: bulkDraftValue(kept), value: bulkDraftValue(kept, choices({ shippingPolicy: { mode: "default" } })),
    });
    expect(bulkSheetOpen(held, picked([]))).toEqual({ kind: "none_left" });
    expect(bulkSheetOpen(null, picked([], { missing: 2 }))).toEqual({ kind: "none_left" });
  });

  it("Load latest keeps the vendor's choices on the revisions read now, starts again with nothing to keep, or finds none left", () => {
    const mine = readBulkDraft(bulkDraft({ shippingPolicy: { mode: "default" } }).value)!;
    expect(bulkReload(mine, picked(NOW))).toEqual({
      kind: "rebase", edited: bulkDraftValue(NOW, choices({ shippingPolicy: { mode: "default" } })), latest: bulkDraftValue(NOW), picked: picked(NOW),
    });
    expect(bulkReload(bulkDraftValue(PRODUCTS), picked(NOW))).toEqual({ kind: "restart", base: bulkDraftValue(NOW), picked: picked(NOW) });
    expect(bulkReload(mine, picked([]))).toEqual({ kind: "none_left", picked: picked([]) });
  });

  it("Discard takes every row back on the same products, but reads the ids again after a 409", () => {
    expect(bulkDiscard(bulkDraft({ shippingPolicy: { mode: "default" } }))).toEqual({ kind: "reset", value: bulkDraftValue(PRODUCTS) });
    expect(bulkDiscard(conflict())).toEqual({ kind: "reread" });
    expect(bulkDiscard(saving())).toEqual({ kind: "none" });
    expect(bulkDiscard(null)).toEqual({ kind: "none" });
  });

  it("says when the step's draft is a save out or unconfirmed (its sheet opens on it, ticks or none)", () => {
    expect(bulkHoldsSave(saving())).toBe(true);
    expect(bulkHoldsSave(conflict())).toBe(false);
    expect(bulkHoldsSave(bulkDraft({ shippingPolicy: { mode: "default" } }))).toBe(false);
    expect(bulkHoldsSave(null)).toBe(false);
  });
});

describe("bulkSheetState (plan 6.3, 3.7)", () => {
  const ticks = reduceListingSettingsSelection(emptySelection(STORE), { type: "togglePage", productIds: [11, 12, 13] });
  const read = listingSettingsProductIdsResponseSchema.parse({ total: 3, rows: [{ productId: 11, revisionId: 5 }, { productId: 12, revisionId: null }, { productId: 14, revisionId: 1 }] });
  const state = (overrides: Partial<BulkSheetInput>) => bulkSheetState({
    selection: ticks, ids: { data: read, error: null }, draft: null, opening: "open", rights: rights(), busy: false,
    savedFlashVisible: false, compact: false, fieldEditorOpen: false, failure: null, ...overrides,
  });
  const uncertain = (draft: ListingSettingsDraft) => reduceListingSettingsDraft(
    reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k" } }),
    { type: "failure", key: "k", failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null, fields: [] } },
  )!;

  it("says it is checking the selection's products while the ids read answers", () => {
    expect(state({ ids: { data: undefined, error: null }, opening: null })).toMatchObject({
      read: "loading", title: "Set for 3 products", loadingLine: "Checking 3 products…", lines: [], readProblem: null,
    });
  });

  it("says a failed read in words, too many checks in a minute apart", () => {
    expect(state({ ids: { error: new TypeError("Failed to fetch") } })).toMatchObject({ read: "failed", readProblem: LISTING_SETTINGS_BULK_WORDS.readFailed });
    expect(state({ ids: { error: new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "x" }) } }).readProblem)
      .toBe("Too many checks in a minute. Wait a moment and try again.");
  });

  it("titles the sheet from the ids read, says who was left out, and saves for the draft's products", () => {
    const shown = state({ draft: bulkDraft({ mainText: { mode: "default" } }) });
    expect(shown).toMatchObject({ read: "answered", title: "Set for 2 products", lines: ["1 product is no longer chosen and is left out."], noneLeft: null });
    expect(shown.footer).toMatchObject({ notSaved: "● Not saved · 1 change", primary: { action: "save", label: "Save for 2 products", disabled: false } });
    expect(state({ draft: bulkDraft({ mainText: { mode: "default" } }), compact: true }).footer).toMatchObject({ notSaved: "● Not saved · 1", primary: { label: "Save" } });
    // Select all: how many match now, against how many did.
    const all = reduceListingSettingsSelection(ticks, { type: "selectAllMatching", filter: { search: "", show: "all" }, total: 2 });
    expect(state({ selection: all }).lines).toEqual(["3 now match (was 2)."]);
  });

  it("turns Save off with words when nothing is chosen any more, or the text is over the budget (6.5)", () => {
    const none = state({ ids: { data: listingSettingsProductIdsResponseSchema.parse({ total: 0, rows: [] }), error: null }, draft: bulkDraft({ mainText: { mode: "default" } }) });
    expect(none).toMatchObject({ noneLeft: LISTING_SETTINGS_BULK_WORDS.noneChosen, footer: { primary: { action: "save", disabled: true } } });
    const many = Array.from({ length: 3_751 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null }));
    const heavy = state({ draft: bulkDraft({ textAbove: { mode: "set", value: { mode: "own", text: twoByteText(8_000) } } }, many) });
    expect(heavy).toMatchObject({
      footer: { primary: { action: "save", disabled: true }, message: { text: LISTING_SETTINGS_BULK_WORDS.tooMuchText, tone: "alert" } },
    });
    expect(state({ draft: bulkDraft({ textAbove: { mode: "set", value: { mode: "own", text: twoByteText(8_000) } } }, many.slice(1)) }).footer)
      .toMatchObject({ primary: { action: "save", disabled: false }, message: null });
  });

  it("keeps Check again on an unconfirmed save, and Esc then keeps the sheet open (3.4)", () => {
    const held = uncertain(bulkDraft({ mainText: { mode: "default" } }));
    expect(state({ draft: held })).toMatchObject({ escapeKeepsOpen: true, footer: { primary: { action: "resend", label: "Check again", disabled: false } } });
    expect(state({ draft: held, rights: rights({ blocked: { kind: "store_paused", diagnosticReference: null } }) }).footer.primary.disabled).toBe(true);
    expect(state({ draft: bulkDraft({ mainText: { mode: "default" } }) }).escapeKeepsOpen).toBe(false);
  });

  it("reopened on an unconfirmed save for other products, names that save's products, never the ticks or the read now (D21)", () => {
    // Saved for 11 and 12, unconfirmed; the vendor then cleared and ticked 13 alone.
    const held = uncertain(bulkDraft({ mainText: { mode: "default" } }));
    const other = reduceListingSettingsSelection(emptySelection(STORE), { type: "toggle", productId: 13 });
    const now = listingSettingsProductIdsResponseSchema.parse({ total: 3, rows: [{ productId: 11, revisionId: 5 }, { productId: 12, revisionId: null }, { productId: 13, revisionId: 2 }] });
    const reopened = state({ selection: other, ids: { data: now, error: null }, draft: held, opening: "keep" });
    expect(reopened).toMatchObject({
      title: "Set for 2 products", lines: ["This save is for the 2 products it was sent for."], noneLeft: null,
      footer: { primary: { action: "resend", label: "Check again" } },
    });
    // With nothing ticked there is no read at all: no loading or failure words, the same title and line.
    expect(state({ selection: emptySelection(STORE), ids: { data: undefined, error: null }, draft: held, opening: "keep" })).toMatchObject({
      title: "Set for 2 products", loadingLine: null, readProblem: null, lines: ["This save is for the 2 products it was sent for."],
    });
    // In place (the read named the same products), the read's own lines stay.
    expect(state({ draft: held }).lines).toEqual(["1 product is no longer chosen and is left out."]);
  });

  it("says a change kept from before now goes to the products read, while it is a change", () => {
    expect(state({ draft: bulkDraft({ mainText: { mode: "default" } }), opening: "restart" }).lines)
      .toEqual(["1 product is no longer chosen and is left out.", LISTING_SETTINGS_BULK_WORDS.carried]);
    expect(state({ draft: bulkDraft(), opening: "restart" }).lines).toEqual(["1 product is no longer chosen and is left out."]);
  });

  it("tells a refusal that names no row in the footer, and leaves one that names a row to it", () => {
    const sent = reduceListingSettingsDraft(bulkDraft({ storeShelf: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    const refuse = (fields: string[]) => reduceListingSettingsDraft(sent, {
      type: "failure", key: "k", failure: { phase: "refused", message: "Refused words.", code: "C", status: 422, fields },
    });
    expect(state({ draft: refuse([]), failure: { fields: [] } }).footer.message).toEqual({ text: "Refused words.", tone: "alert" });
    expect(state({ draft: refuse(["storeShelf"]), failure: { fields: ["storeShelf"] } }).footer.message).toBeNull();
  });
});

describe("W6's own refusals, code by code (plan 6.5)", () => {
  it.each([
    [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 3 }, "conflict", "3 of the selected products changed in another window."],
    [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_008_000, maxTextBytes: 30_000_000, productCount: 3_751 }, "refused", LISTING_SETTINGS_BULK_WORDS.tooMuchText],
    // A conflict, not a refusal: Load latest's new read leaves the product out, where a Save would be refused again (CLAUDE.md §6).
    [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", { productId: 11 }, "conflict", "A selected product is no longer in the Card Shellz catalog. Load the list again."],
  ] as const)("%i %s", (status, code, context, phase, words) => {
    expect(classifyWriteFailure("W6", new DropshipApiError({ status, code, message: "Server words.", context }))).toEqual({ phase, message: words, code, status, fields: [] });
  });
});

describe("bulkSelectionBar (plan 6.3, D3, D22)", () => {
  const EDITABLE = { editable: true, reason: null } as const;
  const tick = (...productIds: number[]) =>
    productIds.reduce((selection, productId) => reduceListingSettingsSelection(selection, { type: "toggle", productId }), emptySelection(STORE));
  const shown = (productIds: number[], total: number) => ({ productIds, total });
  const bar = (overrides: Partial<Parameters<typeof bulkSelectionBar>[0]>) =>
    bulkSelectionBar({ selection: emptySelection(STORE), shown: null, compact: false, right: EDITABLE, saved: null, heldSave: false, ...overrides });

  it("shows nothing until a product is ticked, then counts the ticks with Set for selected and Clear", () => {
    expect(bar({ shown: shown([11, 12, 13], 3) })).toMatchObject({ visible: false, count: "0 selected", offer: null, status: null, shownTick: "none", announcement: "" });
    expect(bar({ selection: tick(11, 13, 12), shown: shown([11, 12, 13, 14], 4) })).toEqual({
      visible: true, count: "3 selected", setForSelected: { label: "Set for selected", disabled: false }, reason: null, clear: "Clear",
      offer: null, status: null, shownTick: "some", announcement: "3 selected.",
    });
  });

  it("reads the count, the offer and a save's status out in one line (3.4)", () => {
    const page = [11, 12, 13];
    expect(bar({ selection: tick(...page), shown: shown(page, 312) }).announcement)
      .toBe("3 selected. All 3 on this page are selected. Select all 312 is available.");
    const ticks = tick(11, 12);
    expect(bar({ selection: ticks, saved: { productCount: 2, selection: ticks } }).announcement).toBe("2 selected. Saved for 2 products. Still selected.");
  });

  it("offers Select all N once every product shown is ticked and more match, in the page's or the phone's words", () => {
    const page = [11, 12, 13];
    expect(bar({ selection: tick(...page), shown: shown(page, 312) }).offer).toEqual({
      line: "All 3 on this page are selected.", label: "Select all 312", total: 312,
    });
    expect(bar({ selection: tick(...page), shown: shown(page, 312), compact: true }).offer?.line).toBe("All 3 shown are selected.");
    // Nothing more to select, no list yet, a list W6 can't name at once, or Select all already on: no offer.
    expect(bar({ selection: tick(...page), shown: shown(page, 3) }).offer).toBeNull();
    expect(bar({ selection: tick(...page), shown: null }).offer).toBeNull();
    expect(bar({ selection: tick(...page), shown: shown(page, MAX_LISTING_SETTING_BULK_PRODUCTS + 1) }).offer).toBeNull();
    const all = reduceListingSettingsSelection(tick(...page), { type: "selectAllMatching", filter: { search: "", show: "all" }, total: 312 });
    expect(bar({ selection: all, shown: shown(page, 312) })).toMatchObject({ count: "312 selected", offer: null, shownTick: "all" });
  });

  it("turns Set for selected off with the reason while W6 can't be used (D3), and says nothing more under a banner", () => {
    const checking = bar({ selection: tick(11), right: { editable: false, reason: "loading" } });
    expect(checking.setForSelected).toEqual({ label: "Set for selected", disabled: true });
    expect(checking.reason).toBe("Checking…");
    expect(bar({ selection: tick(11), right: { editable: false, reason: "banner" } }).reason).toBeNull();
  });

  it("says Still selected only while the saved products are the selection, and the count alone after", () => {
    const ticks = tick(11, 12);
    expect(bar({ selection: ticks, saved: { productCount: 2, selection: ticks } }).status).toBe("Saved for 2 products. Still selected.");
    // The same ticks as an equal value: still selected.
    expect(bar({ selection: tick(12, 11), saved: { productCount: 2, selection: ticks } }).status).toBe("Saved for 2 products. Still selected.");
    // The ticks changed since (Select all fell back, Clear while saving), or the save was an earlier one's (Check again on a held save).
    expect(bar({ selection: tick(13), saved: { productCount: 2, selection: ticks } }).status).toBe("Saved for 2 products.");
    expect(bar({ saved: { productCount: 1, selection: null } })).toMatchObject({ visible: true, status: "Saved for 1 product.", setForSelected: { disabled: true } });
  });

  it("keeps Set for selected on with nothing ticked while a save is out or unconfirmed, so Check again is in reach (D21)", () => {
    expect(bar({ heldSave: true })).toMatchObject({ visible: true, count: "0 selected", setForSelected: { disabled: false } });
    expect(bar({ heldSave: true, right: { editable: false, reason: "banner" } }).setForSelected.disabled).toBe(true);
  });
});

describe("after a confirmed save (D22)", () => {
  const NOW = [{ productId: 11, expectedRevisionId: 6 }, { productId: 12, expectedRevisionId: null }];
  const all = reduceListingSettingsSelection(emptySelection(STORE), { type: "selectAllMatching", filter: { search: "", show: "all" }, total: 2 });
  const ticks = reduceListingSettingsSelection(emptySelection(STORE), { type: "togglePage", productIds: [11, 12, 13] });

  it("names the selection the saved products were read for, and how many matched, else none", () => {
    expect(bulkSavedFor({ products: NOW, openedOn: { selection: ticks, picked: picked(NOW, { missing: 1 }) } }))
      .toEqual({ productCount: 2, selection: ticks, matchedNow: null });
    // Ids are what count: a change kept on its older revisions is still for the same products.
    expect(bulkSavedFor({ products: PRODUCTS, openedOn: { selection: ticks, picked: picked(NOW) } }).selection).toBe(ticks);
    expect(bulkSavedFor({ products: NOW, openedOn: { selection: all, picked: picked(NOW, { matched: { now: 3, before: 2 } }) } }))
      .toEqual({ productCount: 2, selection: all, matchedNow: 3 });
    // An unconfirmed save resent after the sheet reopened without a read, or for other products than the read: no selection.
    expect(bulkSavedFor({ products: NOW, openedOn: null })).toEqual({ productCount: 2, selection: null, matchedNow: null });
    expect(bulkSavedFor({ products: NOW, openedOn: { selection: ticks, picked: picked([NOW[0]]) } }).selection).toBeNull();
  });

  it("counts what matched under Select all, so the bar agrees with the save, and keeps the status for that selection", () => {
    const after = bulkAfterSave({ productCount: 3, selection: all, matchedNow: 3 });
    expect(after.action).toEqual({ type: "matched", filter: { search: "", show: "all" }, total: 3 });
    const next = reduceListingSettingsSelection(all, after.action!);
    expect(next.all?.total).toBe(3);
    expect(after.status.productCount).toBe(3);
    expect(sameSelection(after.status.selection!, next)).toBe(true);
    expect(bulkSelectionBar({ selection: next, shown: null, compact: false, right: { editable: true, reason: null }, saved: after.status, heldSave: false }))
      .toMatchObject({ count: "3 selected", status: "Saved for 3 products. Still selected." });
    expect(bulkAfterSave({ productCount: 2, selection: ticks, matchedNow: null })).toEqual({ action: null, status: { productCount: 2, selection: ticks } });
    expect(bulkAfterSave({ productCount: 2, selection: null, matchedNow: null })).toEqual({ action: null, status: { productCount: 2, selection: null } });
  });
});
