import { z } from "zod";
import { ebayCategoryIdSchema } from "./ebay-category-rules";
import { descriptionTextSchema } from "./listing-content";
import { LISTING_RULES_CONVERSION_ERROR_CODES } from "./listing-rules-conversion";
import { listingPriceCentsSchema } from "./listing-price";
import {
  CATEGORY_LISTING_SETTING_FIELDS,
  MAX_LISTING_POLICY_ID_LENGTH,
  MAX_LISTING_SETTING_BULK_PRODUCTS,
  MAX_LISTING_STORE_SHELVES,
  categoryListingSettingValuesSchema,
  categoryMovesAcknowledgeItemsSchema,
  listingSettingRequestKeySchema,
  listingSettingTemplateTextSchema,
  type ListingSettingTemplateText,
} from "./listing-setting-values";
import {
  MAX_PRICING_REVIEW_ITEMS,
  PRICING_REVIEW_PAGE_SIZE,
  pricingImpactRowSchema,
  pricingRecipeSchema,
  type PricingReviewKind,
} from "./pricing-rules";

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
 * Size prices one request may save: W8's rows, W5's size prices and W7's
 * releases (MAX_PRICE_RELEASES_PER_APPLY). Each is one W9 price flow, measured at about
 * 28 statements on one connection (9a's PostgreSQL suite: 5,611 for 200
 * sizes, 14,008 for 500 flows), so 200 is about 11 s at a 2 ms round trip
 * against Heroku's 30 s router limit; 500 would be about 28 s. The design said
 * 500 (8.5 W8); 200 is plan P38's reversible bound, to be raised from the
 * logged timings.
 */
export const MAX_SIZE_PRICES_PER_REQUEST = 200;
/**
 * Exact prices one W7 apply may release (plan P24, P38): each release is one
 * W9 flow, so the bound is W8's, one time budget for both.
 */
export const MAX_PRICE_RELEASES_PER_APPLY = MAX_SIZE_PRICES_PER_REQUEST;

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
  /** The rules conversion's apply (PR 11, plan 3.4): 409, the plan recomputed under the store lock is not the one shown. */
  conversionChanged: LISTING_RULES_CONVERSION_ERROR_CODES.changed,
  /** 503, transient: the .ops costs could not be read, so prices from cost can't be compared (Retry-After 60). */
  conversionCheckUnavailable: LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable,
  /** 422, permanent: a size listed on eBay that can be sent today would be blocked after the move (plan D9b). */
  conversionWouldBlockListing: LISTING_RULES_CONVERSION_ERROR_CODES.wouldBlockListing,
} as const);

/**
 * The `context.reason` of a DROPSHIP_LISTING_SETTINGS_BUSY answer (503,
 * transient). Each is raised before the write's first statement that
 * writes, so nothing was written and the same request key may be sent again
 * after `Retry-After`. A lost connection or a deadlock is BUSY too, but
 * carries `failure` instead: whether its COMMIT landed is unknown.
 */
export const LISTING_SETTING_BUSY_REASONS = Object.freeze({
  /** Another heavy write holds this process's gate (plan PR 9, 3.10 (a)). */
  heavyWrite: "heavy_write_in_progress",
  /** The preflight's rows under the key are gone in the write transaction (plan PR 9, 6.13 #7). */
  requestKeyChanged: "request_key_changed",
  /** The rules conversion: Card Shellz changed a chosen size, product or category between its reads and its locks (PR 11). */
  catalogChanged: "catalog_changed",
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
 *
 * W7's price check and apply also hold their review's rows (up to 10,000,
 * parsed, beside the recomputed rows and their candidates). Plan 9.7's
 * memory stop rule measured W7's apply at this edge over 128 MiB live (PR
 * 9f), so for W7 the rows' stored size (`octet_length(rows::text)`) counts
 * toward this budget beside the stored text, at the review and at the
 * apply alike. That refusal carries `reason: "price_check_rows"`: its
 * `textBytes` is the text and the rows together.
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

// ---------------------------------------------------------------------------
// W7: the price check and its apply (POST …/price-changes/review,
// GET …/price-changes/reviews/:reviewId, POST …/price-changes/apply)
// ---------------------------------------------------------------------------

/**
 * What a W7 price check covers (plan P22, P25): many products' price and the
 * release of their sizes' exact prices, or one category's price with its
 * editor's other settings. Each is a dropship_pricing_reviews kind (0740);
 * the kind is a column, never a key of the stored input.
 */
export const PRICE_CHANGE_REVIEW_KINDS = ["product_prices", "category_price"] as const satisfies readonly PricingReviewKind[];
export type PriceChangeReviewKind = (typeof PRICE_CHANGE_REVIEW_KINDS)[number];

/**
 * A stored review's id, as the server issues it (randomUUID, lowercase). Only
 * that form is taken back, so a retried apply hashes the same review id the
 * first one did.
 */
export const priceChangeReviewIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** Every page of a review's rows (W1's page bound): 0 to 200 pages of 50. */
export const MAX_PRICE_CHANGE_REVIEW_PAGE = MAX_PRICING_REVIEW_ITEMS / PRICING_REVIEW_PAGE_SIZE;

/**
 * The settings a category price check's "Also clear theirs" may clear on the
 * category's products: every setting a category has, the price included
 * (plan P25), in the stored shape's order.
 */
export const PRICE_CHANGE_CLEAR_FIELDS = CATEGORY_LISTING_SETTING_FIELDS;
export type PriceChangeClearField = (typeof PRICE_CHANGE_CLEAR_FIELDS)[number];

function eachIdOnce(ids: readonly number[]): boolean {
  return new Set(ids).size === ids.length;
}
function eachProductOnce(products: ReadonlyArray<{ productId: number }>): boolean {
  return eachIdOnce(products.map((product) => product.productId));
}
function strictlyAscending(ids: readonly number[]): boolean {
  return ids.every((value, index) => index === 0 || ids[index - 1] < value);
}

/**
 * A category price check's change (W7, plan P25, 9.12 #3): W5's ids-only
 * fields without the main text (a category has none), with the price
 * required (a recipe, or null for "Use default"); without a price the change
 * is a W12 save.
 */
const priceChangeCategoryPatchInputSchema = productSettingsPatchInputSchema.omit({ mainText: true })
  .required({ price: true }).strict();

const productPricesReviewInputSchema = z.object({
  kind: z.literal("product_prices"),
  /** 1 to 10,000 products, each once. */
  productIds: z.array(id).min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS),
  /** Absent = leave the products' prices, null = Use default, a recipe = Set. */
  price: pricingRecipeSchema.nullable().optional(),
  /** Release the sizes' typed prices, so they follow the products' price again. */
  releaseExactPrices: z.literal(true).optional(),
}).strict();

const categoryPriceReviewInputSchema = z.object({
  kind: z.literal("category_price"),
  categoryId: id,
  /** The category settings revision the vendor saw; null when the category had none. */
  expectedRevisionId: id.nullable(),
  patch: priceChangeCategoryPatchInputSchema,
  /** "Also clear theirs" (plan P20): the category's products the vendor was shown, each with the revision it saw. */
  clear: z.object({
    fields: z.array(z.enum(PRICE_CHANGE_CLEAR_FIELDS)).min(1).max(PRICE_CHANGE_CLEAR_FIELDS.length),
    products: z.array(z.object({ productId: id, expectedRevisionId: id.nullable() }).strict())
      .min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS),
  }).strict().optional(),
}).strict();

/**
 * "Check prices" (W7 review, plan 9.4): a strict union on `kind`. The
 * products kind carries the price and the releases only, at least one of
 * them (P25; the other "Set for selected" settings go through W6). The
 * category kind carries the category editor's change and its clear list;
 * every cleared field is set on the category by this change (P20).
 */
export const reviewPriceChangesInputSchema = z.discriminatedUnion("kind", [
  productPricesReviewInputSchema, categoryPriceReviewInputSchema,
]).superRefine((input, context) => {
  if (input.kind === "product_prices") {
    if (!eachIdOnce(input.productIds)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Each product once.", path: ["productIds"] });
    }
    if (input.price === undefined && input.releaseExactPrices === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Change the price, release exact prices, or both.", path: [] });
    }
    return;
  }
  if (!input.clear) return;
  if (new Set(input.clear.fields).size !== input.clear.fields.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each setting once.", path: ["clear", "fields"] });
  }
  if (!eachProductOnce(input.clear.products)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each product once.", path: ["clear", "products"] });
  }
  input.clear.fields.forEach((field, index) => {
    if (input.patch[field] == null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Set this on the category to clear it on its products.",
        path: ["clear", "fields", index] });
    }
  });
});

/*
 * STORED INPUTS (plan P22, C-money-10). A review stores its input without the
 * kind, eBay values resolved (names and paths, P13) and every list in one
 * order: ids ascending, clear fields in the stored shape's order. The review
 * hash is pricingHash({ kind, input: storedInputSchemaFor(kind).parse(input),
 * rows }) at review and again at apply; jsonb keeps no key order and Zod
 * rebuilds objects in shape order, so a stored input hashes the same after a
 * round trip. Parsed again on every load: a stored input that breaks its
 * contract is a fault, never a guess. Bounds may be widened, never tightened.
 */

export const storedProductPricesInputSchema = z.object({
  productIds: z.array(id).min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS)
    .refine(strictlyAscending, "Products in ascending order, each once."),
  price: pricingRecipeSchema.nullable().optional(),
  releaseExactPrices: z.literal(true).optional(),
}).strict().refine((input) => input.price !== undefined || input.releaseExactPrices !== undefined,
  "Change the price, release exact prices, or both.");

/** The category's change with its eBay values resolved, as saveCategory stores them (the stored contract's shapes). */
const storedCategoryPricePatchSchema = categoryListingSettingValuesSchema.partial().required({ price: true }).strict();

export const storedCategoryPriceInputSchema = z.object({
  categoryId: id,
  expectedRevisionId: id.nullable(),
  patch: storedCategoryPricePatchSchema,
  clear: z.object({
    fields: z.array(z.enum(PRICE_CHANGE_CLEAR_FIELDS)).min(1).max(PRICE_CHANGE_CLEAR_FIELDS.length)
      .refine((fields) => strictlyAscending(fields.map((field) => PRICE_CHANGE_CLEAR_FIELDS.indexOf(field))),
        "Settings in the stored order, each once."),
    products: z.array(z.object({ productId: id, expectedRevisionId: id.nullable() }).strict())
      .min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS)
      .refine((products) => strictlyAscending(products.map((product) => product.productId)), "Products in ascending order, each once."),
  }).strict().optional(),
}).strict().superRefine((input, context) => {
  input.clear?.fields.forEach((field, index) => {
    if (input.patch[field] == null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A cleared setting is set on the category.", path: ["clear", "fields", index] });
    }
  });
});

const STORED_INPUT_SCHEMAS = Object.freeze({
  product_prices: storedProductPricesInputSchema,
  category_price: storedCategoryPriceInputSchema,
} as const satisfies Record<PriceChangeReviewKind, z.ZodTypeAny>);

export type StoredProductPricesInput = z.infer<typeof storedProductPricesInputSchema>;
export type StoredCategoryPriceInput = z.infer<typeof storedCategoryPriceInputSchema>;

/** The stored input's schema for a kind (plan P22): what a review stores and hashes, and what a load parses. */
export function storedInputSchemaFor<K extends PriceChangeReviewKind>(kind: K): (typeof STORED_INPUT_SCHEMAS)[K] {
  return STORED_INPUT_SCHEMAS[kind];
}

/**
 * One size of a price check (plan 9.4): W1's review row, plus the size's
 * product, whether the apply releases its exact price, and the refusal a
 * size that would lose its price gets (stored at review, refused at apply,
 * 9.12 #5). W7 types no price, so no other refusal can apply (P14).
 */
export const priceChangeRowSchema = pricingImpactRowSchema.extend({
  productId: id,
  released: z.boolean(),
  refusal: z.literal("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST").nullable(),
}).strict();
/** A review's rows: at most 10,000 (the reviews table's rows CHECK, 0659), by size ascending, each once. */
export const priceChangeRowsSchema = z.array(priceChangeRowSchema).max(MAX_PRICING_REVIEW_ITEMS)
  .refine((rows) => strictlyAscending(rows.map((row) => row.productVariantId)), "Sizes in ascending order, each once.");

export type PriceChangeRow = z.infer<typeof priceChangeRowSchema>;

const rowCount = z.number().int().nonnegative().max(MAX_PRICING_REVIEW_ITEMS);

/**
 * A price check's answer, and each page of it (W1's review shape, plan 9.4):
 * page 0 comes with the POST, later pages from the GET. `changed` sizes get
 * another price, `released` ones lose their exact price, `refused` ones would
 * lose their price, so the apply refuses until the vendor changes the check.
 */
export const priceChangeReviewResponseSchema = z.object({
  reviewId: priceChangeReviewIdSchema,
  reviewHash: sha256Hex,
  createdAt: z.string().datetime(),
  kind: z.enum(PRICE_CHANGE_REVIEW_KINDS),
  summary: z.object({ total: rowCount, changed: rowCount, released: rowCount, refused: rowCount }).strict(),
  rows: z.array(priceChangeRowSchema).max(PRICING_REVIEW_PAGE_SIZE),
  page: z.number().int().min(0).max(MAX_PRICE_CHANGE_REVIEW_PAGE),
}).strict().superRefine((response, context) => {
  const { total, changed, released, refused } = response.summary;
  if (changed > total || released > total || refused > total) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A count is above the review's sizes.", path: ["summary"] });
  }
  if (response.rows.length > 0 && response.page * PRICING_REVIEW_PAGE_SIZE + response.rows.length > total) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A page lists sizes past the review's last.", path: ["rows"] });
  }
});

/** One page of a stored review (the GET's path and query, parsed). */
export const priceChangeReviewPageInputSchema = z.object({
  reviewId: priceChangeReviewIdSchema,
  page: z.number().int().min(0).max(MAX_PRICE_CHANGE_REVIEW_PAGE),
}).strict();

/**
 * "Apply" (W7 apply, plan 9.4): the review the vendor saw and its hash. The
 * key is a listing-settings request key (P6), not W1's.
 */
export const applyPriceChangesInputSchema = z.object({
  reviewId: priceChangeReviewIdSchema,
  reviewHash: sha256Hex,
  idempotencyKey: listingSettingRequestKeySchema,
}).strict();

/**
 * `changed`: some product, the category or a size price changed.
 * `unchanged`: the review's change sets what is already stored and releases
 * nothing (the ledger row is written either way). `replayed`: the request key
 * already applied it, answered from what the key wrote (plan P16), so the
 * changed products are not counted (the replay probe reads no product
 * count). The page re-reads its views after any save (P36).
 */
export const applyPriceChangesResponseSchema = z.object({
  outcome: z.enum(["changed", "unchanged", "replayed"]),
  reviewId: priceChangeReviewIdSchema,
  /** The request's ledger row. */
  requestId,
  /** Products whose price or cleared settings changed; null on a replay. */
  changedProductCount: count.nullable(),
  /** Sizes whose exact price was released. */
  releasedSizeCount: z.number().int().nonnegative().max(MAX_PRICE_RELEASES_PER_APPLY),
  /** The category's settings revision after a category apply; null for a products apply. */
  categoryRevisionId: id.nullable(),
}).strict().superRefine((response, context) => {
  if ((response.outcome === "replayed") !== (response.changedProductCount === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only a replay leaves the product count unknown.", path: ["changedProductCount"] });
  }
  if (response.outcome === "unchanged" && (response.changedProductCount !== 0 || response.releasedSizeCount !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An unchanged apply wrote nothing.", path: ["outcome"] });
  }
});

export type ReviewPriceChangesInput = z.infer<typeof reviewPriceChangesInputSchema>;
export type PriceChangeReviewResponse = z.infer<typeof priceChangeReviewResponseSchema>;
export type PriceChangeReviewPageInput = z.infer<typeof priceChangeReviewPageInputSchema>;
export type ApplyPriceChangesInput = z.infer<typeof applyPriceChangesInputSchema>;
export type ApplyPriceChangesResponse = z.infer<typeof applyPriceChangesResponseSchema>;

// ---------------------------------------------------------------------------
// W13: "Got it" for products Card Shellz moved (POST …/category-moves/acknowledge)
// ---------------------------------------------------------------------------

/**
 * "Got it" (or "Got it for all N"): each moved product once, with the Card
 * Shellz category the vendor was shown (null = none), 1 to 10,000 items (the
 * 8a writer's own item contract, reused as it is).
 */
export const acknowledgeCategoryMovesInputSchema = z.object({
  idempotencyKey: listingSettingRequestKeySchema,
  items: categoryMovesAcknowledgeItemsSchema,
}).strict();

/** One list of product ids in a W13 answer; the two lists together are capped too (below). */
const categoryMovesProductIds = z.array(id).max(MAX_LISTING_SETTING_BULK_PRODUCTS);

/**
 * - `acknowledgedProductIds`: each product still in the category shown now
 *   follows it (its mark holds that category).
 * - `movedAgainProductIds`: products Card Shellz moved again since the vendor
 *   was shown them; their marks are kept, so they stay listed.
 * - A product no longer in the catalog is in neither list.
 * - Outcome `acknowledged`: this request did it. Outcome `replayed`: the
 *   request key already did this; both lists are empty, as the 8a writer
 *   answers a replay (PR 7 D9), and the page re-reads its views after any
 *   save (plan P36).
 */
export const acknowledgeCategoryMovesResponseSchema = z.object({
  outcome: z.enum(["acknowledged", "replayed"]),
  acknowledgedProductIds: categoryMovesProductIds,
  movedAgainProductIds: categoryMovesProductIds,
}).strict().superRefine((response, context) => {
  if (response.outcome === "replayed" && (response.acknowledgedProductIds.length > 0 || response.movedAgainProductIds.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A replay names no product.", path: ["outcome"] });
  }
  const named = [...response.acknowledgedProductIds, ...response.movedAgainProductIds];
  if (new Set(named).size !== named.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each product once, in one list.", path: ["movedAgainProductIds"] });
  }
  if (named.length > MAX_LISTING_SETTING_BULK_PRODUCTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "More products than one request may name.", path: ["movedAgainProductIds"] });
  }
});

export type AcknowledgeCategoryMovesInput = z.infer<typeof acknowledgeCategoryMovesInputSchema>;
export type AcknowledgeCategoryMovesResponse = z.infer<typeof acknowledgeCategoryMovesResponseSchema>;
