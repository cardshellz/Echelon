import { z } from "zod";
import { ebayCategoryIdSchema } from "./ebay-category-rules";
import { descriptionTextSchema } from "./listing-content";
import { listingPriceCentsSchema } from "./listing-price";
import {
  MAX_LISTING_POLICY_ID_LENGTH,
  MAX_LISTING_SETTING_BULK_PRODUCTS,
  MAX_LISTING_STORE_SHELVES,
  listingSettingRequestKeySchema,
  listingSettingTemplateTextSchema,
  type ListingSettingTemplateText,
} from "./listing-setting-values";
import { pricingRecipeSchema } from "./pricing-rules";

/**
 * Route contracts of the listing-settings writers (Listing settings design
 * 8.5; plan PR 9, section 3.1), under
 * `/api/dropship/listings/stores/:storeConnectionId/listing-settings`. Every
 * write carries a request key; a retry with the same key and body answers what
 * the first one saved, and the page re-reads its views after any save, so
 * answers carry only outcomes and ids (plan P36).
 */

const id = z.number().int().positive().max(2_147_483_647);

/**
 * Size prices one request may save: W8's rows and W5's size prices (and, in
 * 9f, W7's releases). Each is one W9 price flow, measured at about
 * 28 statements on one connection (9a's PostgreSQL suite: 5,611 for 200
 * sizes, 14,008 for 500 flows), so 200 is about 11 s at a 2 ms round trip
 * against Heroku's 30 s router limit; 500 would be about 28 s. The design said
 * 500 (8.5 W8); 200 is plan P38's reversible bound, to be raised from the
 * logged timings.
 */
export const MAX_SIZE_PRICES_PER_REQUEST = 200;

/** Codes the listing-settings writes answer that no earlier route did (plan 3.3). */
export const LISTING_SETTING_WRITE_ERROR_CODES = Object.freeze({
  invalidInput: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT",
  rateLimited: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED",
  busy: "DROPSHIP_LISTING_SETTINGS_BUSY",
  replayIncomplete: "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE",
  internal: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
  /** A price the vendor was shown differs from the server's recompute (plan P14, P15). */
  pricesMoved: "DROPSHIP_LISTING_PRICES_MOVED",
  /** The store needs an eBay sign-in and the change names eBay values not saved yet (plan P13). */
  ebaySignInRequired: "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED",
} as const);

/**
 * Longest eBay id a listing-settings route accepts: the policy id columns'
 * width. A store shelf id is stored at most 40 characters
 * (MAX_LISTING_SHELF_ID_LENGTH), but a longer one is refused by the eBay step
 * with DROPSHIP_EBAY_STORE_CATEGORY_INVALID (422), not by the route (400), so
 * the vendor is told which shelf eBay does not know (plan 6.3).
 */
export const MAX_EBAY_ID_INPUT_LENGTH = 100;

/**
 * UTF-8 bytes of product text one heavy write may carry (plan P9 (b), 3.10
 * (b)): the stored text above, text below and main text of every product it
 * names, plus the text its patch sets, once per product. The bulk writer
 * reads each named product's whole row and builds a revision record from it,
 * so this bounds the text the write holds in the heap.
 *
 * The value is the output of plan 3.10's computed rule, judged on the live
 * (retained) heap: the heap V8 collects down to before it would fail, which
 * is what sets the risk of running out of memory. Most of the allocated peak
 * of a 10,000-product write is collectable garbage of its per-row work, not
 * text, so the rule does not judge that. The rule is the smaller of
 * 30,000,000 and floor to a million of (128 MiB - P0) / h, where the live
 * peak is measured with a full collection before each revision insert and
 * before COMMIT; P0 is the live peak of 10,000 products with no text; and h
 * is the worst, over the measured text edges, of (the edge's live peak - the
 * no-text live peak at the same product count) / the edge's text bytes.
 * 30,000,000 is P9's value and the ceiling: the rule never raises the budget
 * above it. The measurements and the arithmetic are in the description of
 * the pull request that set it (PR 9d). A safe, reversible bound, like P38.
 *
 * Raising it is always safe. Lowering it refuses, with 422, the same-key
 * retry of a W6 committed under the higher value whose patch total lies
 * between the two: W6's pure pre-check runs before the replay probe (plan
 * 7.5 #2), so the retry never reaches the probe that would answer it.
 */
export const MAX_BULK_TEXT_BYTES = 30_000_000;

/**
 * UTF-8 bytes of product text (text above, text below and main text, over
 * every product row) one store may keep saved (plan 3.10 (e)). Every read of
 * a store's listing settings loads all of it, so the cap bounds the heap of
 * each read. A write is refused only when it raises the store's total past
 * the cap, so a store over it can always shorten or remove text. Equal to the
 * bulk text budget, and moved with it.
 */
export const MAX_STORE_LISTING_TEXT_BYTES = MAX_BULK_TEXT_BYTES;

/** The parts of a patch that carry product text; any listing-settings patch, route or stored, has this shape. */
export interface ListingSettingTextPatch {
  textAbove?: ListingSettingTemplateText | null;
  textBelow?: ListingSettingTemplateText | null;
  mainText?: { text: string } | null;
}

const utf8 = new TextEncoder();

/**
 * UTF-8 bytes of the text a patch sets: each own text above or below and a
 * main text value. `none`, null and absent count 0. TextEncoder, not Buffer,
 * because the client imports this module. Pure.
 */
export function patchTextBytes(patch: Readonly<ListingSettingTextPatch>): number {
  let bytes = 0;
  for (const part of [patch.textAbove, patch.textBelow]) {
    if (part != null && part.mode === "own") bytes += utf8.encode(part.text).length;
  }
  if (patch.mainText != null) bytes += utf8.encode(patch.mainText.text).length;
  return bytes;
}

// ---------------------------------------------------------------------------
// Ids-only patch inputs (plan 6.3, P13), reused by W6, W12 and W7
// ---------------------------------------------------------------------------

/*
 * Route inputs name eBay values by id only. The server builds every stored
 * name and path: from eBay for an id not saved on the target yet, or from the
 * stored value when the id is already saved there. Nothing the client sends
 * is stored as a name.
 */

/** An eBay category by its number (the stored contract's id rule). */
export const listingSettingEbayCategoryInputSchema = z.object({
  categoryId: ebayCategoryIdSchema,
}).strict();
/** `none`: explicitly no shelf. `own`: one or two shelf ids, first then second. */
export const listingSettingStoreShelfInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({
    mode: z.literal("own"),
    shelfIds: z.array(z.string().min(1).max(MAX_EBAY_ID_INPUT_LENGTH)).min(1).max(MAX_LISTING_STORE_SHELVES)
      .refine((ids) => new Set(ids).size === ids.length, "Pick two different shelves."),
  }).strict(),
]);
/** An eBay business policy by its id. */
export const listingSettingPolicyInputSchema = z.object({
  id: z.string().min(1).max(MAX_LISTING_POLICY_ID_LENGTH),
}).strict();
/** The product's own main text; the server stamps the catalog hash it is written against (plan 6.13 #5). */
export const listingSettingMainTextInputSchema = z.object({ text: descriptionTextSchema }).strict();

/**
 * One product's change (W5): absent = leave, null = use the default, value =
 * set. Keys in the stored shape's order, so the request hash does not depend
 * on the order sent.
 */
export const productSettingsPatchInputSchema = z.object({
  price: pricingRecipeSchema.nullable(),
  ebayCategory: listingSettingEbayCategoryInputSchema.nullable(),
  storeShelf: listingSettingStoreShelfInputSchema.nullable(),
  shippingPolicy: listingSettingPolicyInputSchema.nullable(),
  returnPolicy: listingSettingPolicyInputSchema.nullable(),
  paymentPolicy: listingSettingPolicyInputSchema.nullable(),
  textAbove: listingSettingTemplateTextSchema.nullable(),
  textBelow: listingSettingTemplateTextSchema.nullable(),
  mainText: listingSettingMainTextInputSchema.nullable(),
}).partial().strict();
export type ProductSettingsPatchInput = z.infer<typeof productSettingsPatchInputSchema>;

// ---------------------------------------------------------------------------
// W8: exact prices for many sizes (PUT …/listing-settings/size-prices)
// ---------------------------------------------------------------------------

/**
 * "Give these sizes a price": a typed price for each size, each with the
 * price revision the vendor saw (null when the size had none). All or none:
 * one refused size leaves every size as it was.
 */
export const saveSizePricesInputSchema = z.object({
  idempotencyKey: listingSettingRequestKeySchema,
  rows: z.array(z.object({
    productVariantId: id,
    /** Integer cents, above zero and within the int4 price columns. */
    priceCents: listingPriceCentsSchema,
    expectedRevisionId: id.nullable(),
  }).strict()).min(1).max(MAX_SIZE_PRICES_PER_REQUEST)
    .refine((rows) => new Set(rows.map((row) => row.productVariantId)).size === rows.length, "Each size once."),
}).strict();

/**
 * `changed`: every size was saved now. `replayed`: the request key already
 * saved them, and these are the revisions it wrote.
 */
export const saveSizePricesResponseSchema = z.object({
  outcome: z.enum(["changed", "replayed"]),
  sizes: z.array(z.object({ productVariantId: id, revisionId: id, idempotentReplay: z.boolean() }).strict())
    .min(1).max(MAX_SIZE_PRICES_PER_REQUEST),
}).strict().superRefine((response, context) => {
  const ids = response.sizes.map((size) => size.productVariantId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each size once.", path: ["sizes"] });
  }
  if (response.sizes.some((size) => size.idempotentReplay !== (response.outcome === "replayed"))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every size is replayed exactly when the request is.", path: ["sizes"] });
  }
});

export type SaveSizePricesInput = z.infer<typeof saveSizePricesInputSchema>;
export type SaveSizePricesResponse = z.infer<typeof saveSizePricesResponseSchema>;

// ---------------------------------------------------------------------------
// W5: one product (PUT …/listing-settings/products/:productId)
// ---------------------------------------------------------------------------

/**
 * A size's price in the same save (plan P33): a typed price (`fixed`) or the
 * x that releases it (`inherit`), each with the price revision the vendor saw.
 */
const sizePriceInputSchema = z.discriminatedUnion("pricingMode", [
  z.object({
    productVariantId: id, pricingMode: z.literal("fixed"), priceCents: listingPriceCentsSchema, expectedRevisionId: id.nullable(),
  }).strict(),
  z.object({ productVariantId: id, pricingMode: z.literal("inherit"), expectedRevisionId: id.nullable() }).strict(),
]);
/** The New price the vendor was shown for one chosen size; null for "can't price". */
const expectedPriceInputSchema = z.object({ productVariantId: id, priceCents: listingPriceCentsSchema.nullable() }).strict();

function eachSizeOnce(rows: ReadonlyArray<{ productVariantId: number }>): boolean {
  return new Set(rows.map((row) => row.productVariantId)).size === rows.length;
}

/**
 * "Save" in one product's drawer: its settings, and the prices of the sizes
 * the vendor typed or released, in one transaction. `expectedPrices` is the
 * price check (plan P14): sent exactly when the change can move a price (a
 * price change or a size price), for every chosen size, so equal requests
 * hash equal.
 */
export const saveProductSettingsInputSchema = z.object({
  idempotencyKey: listingSettingRequestKeySchema,
  /** The product settings revision the vendor saw; null when the product had none. */
  expectedRevisionId: id.nullable(),
  patch: productSettingsPatchInputSchema.default({}),
  sizePrices: z.array(sizePriceInputSchema).max(MAX_SIZE_PRICES_PER_REQUEST).default([]),
  expectedPrices: z.array(expectedPriceInputSchema).min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS).optional(),
}).strict().superRefine((input, context) => {
  const changesSetting = Object.values(input.patch).some((value) => value !== undefined);
  if (!changesSetting && input.sizePrices.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Change at least one setting.", path: ["patch"] });
  }
  if (!eachSizeOnce(input.sizePrices)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each size once.", path: ["sizePrices"] });
  }
  if (input.expectedPrices && !eachSizeOnce(input.expectedPrices)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each size once.", path: ["expectedPrices"] });
  }
  const movesPrices = input.patch.price !== undefined || input.sizePrices.length > 0;
  if (movesPrices && input.expectedPrices === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Send the price you were shown for every size.", path: ["expectedPrices"] });
  }
  if (!movesPrices && input.expectedPrices !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Send shown prices only with a price change.", path: ["expectedPrices"] });
  }
});

/**
 * `changed`: something was written. `unchanged`: the change set what is
 * already stored, so nothing was written (plan D12). `replayed`: the request
 * key already saved it; the revisions are the ones it wrote, and nothing is
 * counted (plan P16, P36). The page re-reads its views after any save.
 */
export const saveProductSettingsResponseSchema = z.object({
  outcome: z.enum(["changed", "unchanged", "replayed"]),
  productId: id,
  /** The product's settings revision after the save (the one the key wrote on a replay); null when it has none. */
  revisionId: id.nullable(),
  sizes: z.array(z.object({ productVariantId: id, revisionId: id }).strict()).max(MAX_SIZE_PRICES_PER_REQUEST),
  /** Sizes whose own leftover policy, shelf or main text the save cleared; null on a replay. */
  clearedSizeCount: z.number().int().nonnegative().nullable(),
}).strict().superRefine((response, context) => {
  if (!eachSizeOnce(response.sizes)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each size once.", path: ["sizes"] });
  }
  if ((response.outcome === "replayed") !== (response.clearedSizeCount === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only a replay leaves the clean-up count unknown.", path: ["clearedSizeCount"] });
  }
  if (response.outcome === "unchanged" && (response.sizes.length > 0 || response.clearedSizeCount !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An unchanged save wrote nothing.", path: ["outcome"] });
  }
});

export type SaveProductSettingsInput = z.infer<typeof saveProductSettingsInputSchema>;
export type SaveProductSettingsResponse = z.infer<typeof saveProductSettingsResponseSchema>;

// ---------------------------------------------------------------------------
// W6: many products, no price (POST …/listing-settings/products/bulk)
// ---------------------------------------------------------------------------

/**
 * The ids-only patch for many products (plan 7.3): W5's, with the stored bulk
 * contract's rules and words (productListingSettingBulkPatchSchema): never a
 * price, not even null (a price for many products goes through the price
 * check, W7), the main text only as a reset (one patch cannot carry each
 * product's own catalog hash), and at least one change.
 */
const productsBulkPatchInputSchema = productSettingsPatchInputSchema.superRefine((patch, context) => {
  if (!Object.values(patch).some((value) => value !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Change at least one setting.", path: [] });
  }
  if (patch.price !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Change prices for many products with a price check.", path: ["price"] });
  }
  if (patch.mainText != null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Main text can only be reset for many products.", path: ["mainText"] });
  }
});

/**
 * "Set for selected" or "Use default" for many products at once (W6): one
 * patch, all or none, each product with the settings revision the vendor saw
 * (null when it had none; the page reads them from GET …/products/ids).
 */
export const saveProductsBulkInputSchema = z.object({
  idempotencyKey: listingSettingRequestKeySchema,
  products: z.array(z.object({ productId: id, expectedRevisionId: id.nullable() }).strict())
    .min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS)
    .refine((products) => new Set(products.map((product) => product.productId)).size === products.length, "Each product once."),
  patch: productsBulkPatchInputSchema,
}).strict();

/** Counts of rows; the request ledger's id is a bigint identity, so it is bounded by the safe integers, not int4. */
const count = z.number().int().nonnegative().max(MAX_LISTING_SETTING_BULK_PRODUCTS);
const requestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * `changed`: some product's settings or some size's leftover changed.
 * `unchanged`: the patch set what every product already has, and no size had
 * a leftover to clear (the ledger row is written either way, plan D12).
 * `replayed`: the request key already saved it, and nothing is counted (plan
 * P16, P36). The page re-reads its views after any save.
 */
export const saveProductsBulkResponseSchema = z.object({
  outcome: z.enum(["changed", "unchanged", "replayed"]),
  /** The request's ledger row. */
  requestId,
  /** Products the request named. */
  productCount: count.min(1),
  /** Products whose settings changed; null on a replay. */
  changedProductCount: count.nullable(),
  /** Sizes whose own leftover policy, shelf or main text the save cleared; null on a replay. */
  clearedSizeCount: z.number().int().nonnegative().nullable(),
}).strict().superRefine((response, context) => {
  const replayed = response.outcome === "replayed";
  if (replayed !== (response.changedProductCount === null) || replayed !== (response.clearedSizeCount === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only a replay leaves the counts unknown.", path: ["outcome"] });
  }
  if (response.changedProductCount !== null && response.changedProductCount > response.productCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "More products changed than were named.", path: ["changedProductCount"] });
  }
  if (response.outcome === "unchanged" && (response.changedProductCount !== 0 || response.clearedSizeCount !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An unchanged save wrote nothing.", path: ["outcome"] });
  }
});

export type ProductsBulkPatchInput = z.infer<typeof productsBulkPatchInputSchema>;
export type SaveProductsBulkInput = z.infer<typeof saveProductsBulkInputSchema>;
export type SaveProductsBulkResponse = z.infer<typeof saveProductsBulkResponseSchema>;

// ---------------------------------------------------------------------------
// W12: one Card Shellz category (PUT …/listing-settings/categories/:categoryId)
// ---------------------------------------------------------------------------

/**
 * The settings "Also clear theirs" can clear on the category's products, in
 * the stored shape's order: a category's own settings without the price (a
 * category price goes only through the price check, W7, plan P34) and
 * without the main text (a category has none).
 */
export const CATEGORY_CLEAR_FIELDS = [
  "ebayCategory", "storeShelf", "shippingPolicy", "returnPolicy", "paymentPolicy", "textAbove", "textBelow",
] as const;
export type CategoryClearField = (typeof CATEGORY_CLEAR_FIELDS)[number];

/**
 * One category's change (W12): W5's ids-only fields without the price (plan
 * P34: a category price goes through the price check, W7) and without the
 * main text (a category has none). At least one change: a clear-only change
 * resends the field's current value, which saves as `unchanged` (plan P20).
 */
const categorySettingsPatchInputSchema = productSettingsPatchInputSchema.omit({ price: true, mainText: true }).strict()
  .superRefine((patch, context) => {
    if (!Object.values(patch).some((value) => value !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Change at least one setting.", path: [] });
    }
  });

/**
 * "Save" in one category's editor, and with it "Also clear theirs" (plan
 * P20): the products of the category that hold their own value in a cleared
 * field lose it, so they all follow the category. `clear.products` is the set
 * the vendor was shown, each with the settings revision it saw (null when it
 * had none); the server derives the set itself and refuses another one. Every
 * cleared field must be set on the category by this change.
 */
export const saveCategorySettingsInputSchema = z.object({
  idempotencyKey: listingSettingRequestKeySchema,
  /** The category settings revision the vendor saw; null when the category had none. */
  expectedRevisionId: id.nullable(),
  patch: categorySettingsPatchInputSchema,
  clear: z.object({
    fields: z.array(z.enum(CATEGORY_CLEAR_FIELDS)).min(1).max(CATEGORY_CLEAR_FIELDS.length)
      .refine((fields) => new Set(fields).size === fields.length, "Each setting once."),
    products: z.array(z.object({ productId: id, expectedRevisionId: id.nullable() }).strict())
      .min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS)
      .refine((products) => new Set(products.map((product) => product.productId)).size === products.length, "Each product once."),
  }).strict().optional(),
}).strict().superRefine((input, context) => {
  input.clear?.fields.forEach((field, index) => {
    if (input.patch[field] == null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Set this on the category to clear it on its products.",
        path: ["clear", "fields", index] });
    }
  });
});

/**
 * `changed`: the category's settings, or some product's own value, changed.
 * `unchanged`: the change set what the category already has and cleared
 * nothing, so nothing was written (plan D12). `replayed`: the request key
 * already saved it; the answer names the revision the first answer named,
 * and nothing is counted (plan P16, P36). The page re-reads its views after
 * any save.
 */
export const saveCategorySettingsResponseSchema = z.object({
  outcome: z.enum(["changed", "unchanged", "replayed"]),
  categoryId: id,
  /**
   * The category's settings revision after the save; null when it has none. A replay answers the same one: the
   * revision the key wrote, or for a clear that left the category unchanged the revision the request expected.
   */
  revisionId: id.nullable(),
  /** Products whose own values in the cleared settings were removed; null on a replay. */
  clearedProductCount: count.nullable(),
}).strict().superRefine((response, context) => {
  if ((response.outcome === "replayed") !== (response.clearedProductCount === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only a replay leaves the clear count unknown.", path: ["clearedProductCount"] });
  }
  if (response.outcome === "unchanged" && response.clearedProductCount !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An unchanged save wrote nothing.", path: ["outcome"] });
  }
});

export type CategorySettingsPatchInput = z.infer<typeof categorySettingsPatchInputSchema>;
export type SaveCategorySettingsInput = z.infer<typeof saveCategorySettingsInputSchema>;
export type SaveCategorySettingsResponse = z.infer<typeof saveCategorySettingsResponseSchema>;
