import { z } from "zod";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";
import { ebayCategoryIdSchema } from "./ebay-category-rules";
import { DROPSHIP_LISTING_ACCESS_BLOCK_CODES, DROPSHIP_LISTING_ACCESS_RESOLUTIONS } from "./listing-access";
import { RULE_PRICE_OUTSIDE_LIMIT_ISSUE, listingAmountCentsSchema, listingPriceBasisSchema, listingPriceCentsSchema } from "./listing-price";
import { pricingRecipeSchema } from "./pricing-rules";

/**
 * The read-only listing settings views of one store (Listing settings design 8.4):
 * a summary, every chosen size's price, one row per chosen product, and one
 * product's settings in full.
 *
 * They read today's settings only: the store defaults and the values left on
 * single sizes by the current step 2 panels. Category settings, product
 * values and "moved by Card Shellz" join in later PRs. No view calls eBay, so
 * a saved policy is reported by id with `verification: "not_checked"`.
 */

export const LISTING_SETTINGS_PAGE_SIZE = 50;
/** Enough pages for every row of the largest selection (10,000 sizes at 50 a page). */
export const MAX_LISTING_SETTINGS_PAGE = Math.ceil(MAX_NAMED_CATALOG_GROUP_ITEMS / LISTING_SETTINGS_PAGE_SIZE) - 1;
export const MAX_LISTING_SETTINGS_SEARCH_LENGTH = 100;
/** The summary's "Needs your attention" list shows at most this many lines. */
export const MAX_LISTING_SETTINGS_ATTENTION_ITEMS = 3;

const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative();
const search = z.string().trim().max(MAX_LISTING_SETTINGS_SEARCH_LENGTH);
const page = z.number().int().min(0).max(MAX_LISTING_SETTINGS_PAGE);

export const listingSettingsStoreInputSchema = z.object({ storeConnectionId: id }).strict();
export const listingSettingsProductInputSchema = z.object({ storeConnectionId: id, productId: id }).strict();

/**
 * Which products the Products tab lists. `own_settings`: products with a size
 * that has its own value for a setting or an exact price.
 */
export const LISTING_SETTINGS_PRODUCT_FILTERS = [
  "all", "needs_fix", "sizes_differ", "own_settings", "exact_prices", "below_cost", "cannot_price",
] as const;
export const listingSettingsProductsInputSchema = z.object({
  storeConnectionId: id,
  search: search.default(""),
  show: z.enum(LISTING_SETTINGS_PRODUCT_FILTERS).default("all"),
  page: page.default(0),
}).strict();

/** Which sizes the Prices tab lists. `retail_fallback`: sizes whose price source is `retail_fallback`. */
export const LISTING_SETTINGS_PRICE_FILTERS = ["all", "exact_prices", "below_cost", "cannot_price", "paused", "retail_fallback"] as const;
export const listingSettingsPricesInputSchema = z.object({
  storeConnectionId: id,
  search: search.default(""),
  show: z.enum(LISTING_SETTINGS_PRICE_FILTERS).default("all"),
  page: page.default(0),
}).strict();

/**
 * Where a size's price comes from, in the vendor's terms:
 * - `exact`: a price the vendor typed for this size;
 * - `rules`: the store's pricing rules;
 * - `catalog_price`: the Card Shellz retail price;
 * - `last_published`: the price an earlier push saved on the listing;
 * - `retail_fallback`: the Card Shellz retail price, because the size follows
 *   the pricing rules (`inherit`) and they give it no usable price: the store
 *   has none (`issue` null), or they can't price it or a blocking Card Shellz
 *   limit refuses their price (`issue` says why);
 * - `none`: no price can be worked out.
 */
export const LISTING_SETTINGS_PRICE_SOURCES = ["exact", "rules", "catalog_price", "last_published", "retail_fallback", "none"] as const;
/**
 * Why a size has no price. The first three come from the rules (`resolvePricingRule`).
 * On a `retail_fallback` size, which has a price, it is why the rules can't price it;
 * only there, `pricing_rule_outside_limit` says the rules give a price that a
 * blocking Card Shellz price limit refuses (`listingPriceFollowsRules`).
 */
export const LISTING_SETTINGS_PRICE_ISSUES = [
  "pricing_rule_priority_conflict", "pricing_basis_unavailable", "pricing_result_out_of_range",
  "pricing_rules_not_configured", "price_unavailable", RULE_PRICE_OUTSIDE_LIMIT_ISSUE,
] as const;
/**
 * How Card Shellz applies a price limit: `warn` only warns, `block_listing`
 * stops the listing from being sent, `refuse_orders` refuses orders for it.
 */
export const LISTING_SETTINGS_LIMIT_MODES = ["warn", "block_listing", "refuse_orders"] as const;

export const listingSettingsPriceRuleSchema = z.object({
  /** `store_default` is the store's default recipe; `group` is an older group rule. */
  kind: z.enum(["store_default", "group"]),
  name: z.string().min(1),
  recipe: pricingRecipeSchema,
}).strict();

export const listingSettingsPriceLimitSchema = z.object({
  policyId: id,
  floorCents: listingPriceCentsSchema.nullable(),
  ceilingCents: listingPriceCentsSchema.nullable(),
  mode: z.enum(LISTING_SETTINGS_LIMIT_MODES),
  breached: z.enum(["below_floor", "above_ceiling"]).nullable(),
}).strict();

export const listingSettingsSizePriceSchema = z.object({
  productVariantId: id,
  productId: id,
  productName: z.string(),
  sizeName: z.string(),
  sku: z.string().nullable(),
  priceCents: listingPriceCentsSchema.nullable(),
  source: z.enum(LISTING_SETTINGS_PRICE_SOURCES),
  /** The rule that prices this size; null unless the rules own its price and one rule wins. */
  rule: listingSettingsPriceRuleSchema.nullable(),
  /** What the rule starts from, and that amount; null when the rules don't own the price. */
  basis: listingPriceBasisSchema.nullable(),
  basisAmountCents: listingAmountCentsSchema.nullable(),
  /** Null when the size has a price, except on a `retail_fallback` size whose rules give it no usable price. */
  issue: z.enum(LISTING_SETTINGS_PRICE_ISSUES).nullable(),
  /** The vendor's live .ops cost for one sellable pack; null when it is not known. */
  costCents: listingAmountCentsSchema.nullable(),
  /** How much each sale loses; null unless the price is below the known cost. Never a block. */
  belowCostByCents: z.number().int().positive().max(2_147_483_647).nullable(),
  limits: z.array(listingSettingsPriceLimitSchema),
  /** Set while a cost change keeps this size paused on eBay because its price is under the cost. */
  pausedSince: z.string().datetime().nullable(),
  /** The size's saved price revision; null when nothing was saved for it. */
  settingRevisionId: id.nullable(),
}).strict();

/** Settings a product's sizes can carry today. Price is never "sizes differ": prices differ by size. */
export const LISTING_SETTINGS_FIELDS = [
  "shipping_policy", "return_policy", "payment_policy", "ebay_category", "store_shelf", "description",
] as const;
/** Problems the vendor can fix on this step (design 3.5). Card Shellz-owned problems stay on step 3. */
export const LISTING_SETTINGS_FIX_CODES = [
  "no_ebay_category", "size_cannot_be_priced", "own_text_needs_check", "description_group_conflict",
] as const;

export const listingSettingsProductRowSchema = z.object({
  productId: id,
  productName: z.string(),
  category: z.string().nullable(),
  sizesChosen: count,
  /** Every size of the product the vendor could choose (sellable and offered by Card Shellz now), chosen or not. */
  sizesTotal: count,
  priceRange: z.object({ minCents: listingPriceCentsSchema, maxCents: listingPriceCentsSchema }).strict().nullable(),
  exactPriceCount: count,
  /** Settings at least one chosen size has its own value for. */
  ownSettings: z.array(z.enum(LISTING_SETTINGS_FIELDS)),
  /** Settings whose value is not the same on every chosen size. */
  sizesDiffer: z.array(z.enum(LISTING_SETTINGS_FIELDS)),
  fixes: z.array(z.enum(LISTING_SETTINGS_FIX_CODES)),
  /** The size a search matched on, when the product name itself did not match. */
  matchedSize: z.object({ productVariantId: id, sizeName: z.string(), sku: z.string().nullable() }).strict().nullable(),
}).strict();

const pageOf = <T extends z.ZodTypeAny>(row: T) => z.object({
  storeConnectionId: id,
  page,
  pageSize: z.literal(LISTING_SETTINGS_PAGE_SIZE),
  total: count,
  rows: z.array(row).max(LISTING_SETTINGS_PAGE_SIZE),
  generatedAt: z.string().datetime(),
}).strict();
export const listingSettingsPricesResponseSchema = pageOf(listingSettingsSizePriceSchema);
export const listingSettingsProductsResponseSchema = pageOf(listingSettingsProductRowSchema);

// ---------------------------------------------------------------------------
// One product's settings (GET …/products/:productId)
// ---------------------------------------------------------------------------

/**
 * Where a size gets a setting's value today, before product and category
 * settings exist (design PRs 8 to 11):
 * - `size`: a value left on this size by today's per-size settings;
 * - `group_rule`: an older group rule, named in `ruleName`;
 * - `store_default`: the store default;
 * - `catalog`: Card Shellz (the eBay category it chose for the product, or its main text);
 * - `none`: nothing is set.
 */
export const LISTING_SETTINGS_VALUE_SOURCES = ["size", "group_rule", "store_default", "catalog", "none"] as const;

const valueSourceSchema = z.object({
  source: z.enum(LISTING_SETTINGS_VALUE_SOURCES),
  /** The older group rule's name; null for every other source. */
  ruleName: z.string().min(1).nullable(),
  /** The chosen sizes that get the value from here, in the order `sizes` lists them. */
  productVariantIds: z.array(id).min(1),
}).strict().refine((entry) => (entry.source === "group_rule") === (entry.ruleName !== null),
  "A group rule is named, and no other source is.");

/**
 * Every distinct value of one setting among the product's chosen sizes, most
 * used first. More than one means the sizes differ. Values are told apart by
 * what is sent, which this view does not carry for the description, so two
 * entries can read the same here: two sizes' own main texts, or two
 * templates that each have text above and below.
 */
const settingOf = <T extends z.ZodTypeAny>(value: T) => z.array(z.object({
  value,
  sources: z.array(valueSourceSchema).min(1),
}).strict()).min(1);

/** A null id means no policy is set. Names are not stored yet, so a policy is shown by id and not checked on eBay. */
export const listingSettingsPolicyValueSchema = z.object({ policyId: z.string().min(1).nullable() }).strict();
export const listingSettingsEbayCategoryValueSchema = z.object({
  categoryId: z.string().min(1).nullable(),
  /** The name the first of these sizes resolves to; eBay lists by the id. */
  categoryName: z.string().min(1).nullable(),
}).strict();
/** The first shelf, then the second; an empty list means none. */
export const listingSettingsStoreShelfValueSchema = z.object({ names: z.array(z.string().min(1)).max(2) }).strict();
/** The text above and below the main text, as it is sent. */
export const listingSettingsDescriptionTemplateValueSchema = z.object({
  hasIntroduction: z.boolean(),
  hasFooter: z.boolean(),
  /** Two older group rules tie for these sizes, so neither's text is used: a fix on this step. */
  groupConflict: z.boolean(),
}).strict();
/** `own`: the size's own main text; otherwise the Card Shellz text. */
export const listingSettingsMainTextValueSchema = z.object({ own: z.boolean() }).strict();

export const LISTING_SETTINGS_SETTING_KEYS = [
  "shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "descriptionTemplate", "mainText",
] as const;
export const listingSettingsProductSettingsSchema = z.object({
  shippingPolicy: settingOf(listingSettingsPolicyValueSchema),
  returnPolicy: settingOf(listingSettingsPolicyValueSchema),
  paymentPolicy: settingOf(listingSettingsPolicyValueSchema),
  ebayCategory: settingOf(listingSettingsEbayCategoryValueSchema),
  storeShelf: settingOf(listingSettingsStoreShelfValueSchema),
  descriptionTemplate: settingOf(listingSettingsDescriptionTemplateValueSchema),
  mainText: settingOf(listingSettingsMainTextValueSchema),
}).strict();

/** The settings behind each field of a product row. The description has two parts. */
export const LISTING_SETTINGS_FIELD_SETTINGS = {
  shipping_policy: ["shippingPolicy"],
  return_policy: ["returnPolicy"],
  payment_policy: ["paymentPolicy"],
  ebay_category: ["ebayCategory"],
  store_shelf: ["storeShelf"],
  description: ["descriptionTemplate", "mainText"],
} as const satisfies Record<ListingSettingsField, readonly ListingSettingsSettingKey[]>;

export const listingSettingsProductSizeSchema = z.object({
  price: listingSettingsSizePriceSchema,
  fixes: z.array(z.enum(LISTING_SETTINGS_FIX_CODES)),
  /**
   * What Card Shellz would list for this size on this store now: the quantity
   * step 3 previews before its listing tier check. Null when stock could not be read.
   */
  stockUnits: count.nullable(),
}).strict();

const stockSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), checkedAt: z.string().datetime() }).strict(),
  /** `retryable`: trying again may work; otherwise Card Shellz has something to fix first. */
  z.object({ state: z.literal("unavailable"), retryable: z.boolean(), checkedAt: z.string().datetime() }).strict(),
]);

export const listingSettingsProductDetailSchema = z.object({
  storeConnectionId: id,
  product: listingSettingsProductRowSchema.omit({ matchedSize: true }),
  settings: listingSettingsProductSettingsSchema,
  /** The product's chosen sizes, by size name. */
  sizes: z.array(listingSettingsProductSizeSchema).min(1).max(MAX_NAMED_CATALOG_GROUP_ITEMS),
  /** Stock is read live for this product; the settings are as of `generatedAt`. */
  stock: stockSchema,
  generatedAt: z.string().datetime(),
}).strict().superRefine((detail, context) => {
  const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const ids = detail.sizes.map((size) => size.price.productVariantId);
  const chosen = new Set(ids);
  if (chosen.size !== ids.length || ids.length !== detail.product.sizesChosen) issue("Every chosen size is listed once.", ["sizes"]);
  detail.sizes.forEach((size, index) => {
    if (size.price.productId !== detail.product.productId) issue("The size belongs to another product.", ["sizes", index]);
    if ((size.stockUnits === null) !== (detail.stock.state === "unavailable")) {
      issue("Stock is given for every size exactly when it was read.", ["sizes", index, "stockUnits"]);
    }
  });
  for (const key of LISTING_SETTINGS_SETTING_KEYS) {
    const covered = detail.settings[key].flatMap((value) => value.sources.flatMap((entry) => entry.productVariantIds));
    if (covered.length !== ids.length || new Set(covered).size !== covered.length || covered.some((sizeId) => !chosen.has(sizeId))) {
      issue("Each chosen size has exactly one value.", ["settings", key]);
    }
  }
  // The row's flags say the same as the settings in full.
  for (const field of LISTING_SETTINGS_FIELDS) {
    const settings = LISTING_SETTINGS_FIELD_SETTINGS[field].map((key) => detail.settings[key]);
    const differ = settings.some((values) => values.length > 1);
    const own = settings.some((values) => values.some((value) => value.sources.some((entry) => entry.source === "size")));
    if (differ !== detail.product.sizesDiffer.includes(field)) issue(`Sizes differ for ${field} only when it has more than one value.`, ["product", "sizesDiffer"]);
    if (own !== detail.product.ownSettings.includes(field)) issue(`${field} is an own setting only when a size has its own value.`, ["product", "ownSettings"]);
  }
});

const policyDefaultSchema = z.object({
  policyId: z.string().min(1).nullable(),
  /** Names are not stored yet, and no view calls eBay, so a saved policy is not checked here. */
  verification: z.literal("not_checked"),
}).strict();

export const LISTING_SETTINGS_ATTENTION_CODES = [
  "reconnect_store", "choose_store_policies", "own_text_needs_check",
  "no_ebay_category", "size_cannot_be_priced", "description_group_conflict",
] as const;
export const LISTING_SETTINGS_POLICY_KINDS = ["shipping", "return", "payment"] as const;
/**
 * The rail line under Listing settings. The page adds "Checking…", "Couldn't
 * check" and "No eBay store" itself, since those are about this read.
 */
export const LISTING_SETTINGS_RAIL_STATES = [
  "all_set", "products_need_fix", "choose_policy", "reconnect_store", "too_many_sizes",
] as const;

/** The shared listing access decision (`decideDropshipListingAccess`), action "preview". */
const accessSchema = z.union([
  z.object({ allowed: z.literal(true) }).strict(),
  z.object({
    allowed: z.literal(false),
    code: z.enum(DROPSHIP_LISTING_ACCESS_BLOCK_CODES),
    resolution: z.enum(DROPSHIP_LISTING_ACCESS_RESOLUTIONS),
    message: z.string().min(1),
  }).strict(),
]);

export const listingSettingsSummarySchema = z.object({
  storeConnectionId: id,
  storeStatus: z.string().min(1),
  /** Whether the vendor may change listings now; reads work either way. */
  access: accessSchema,
  catalog: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), products: count, sizes: count }).strict(),
    z.object({ state: z.literal("too_large"), limit: z.literal(MAX_NAMED_CATALOG_GROUP_ITEMS) }).strict(),
  ]),
  storeDefaults: z.object({
    price: z.object({ recipe: pricingRecipeSchema.nullable(), groupRules: count }).strict(),
    shippingPolicy: policyDefaultSchema,
    returnPolicy: policyDefaultSchema,
    paymentPolicy: policyDefaultSchema,
    ebayCategory: z.object({
      /** Null means Card Shellz picks each product's category. */
      category: z.object({ categoryId: ebayCategoryIdSchema, categoryName: z.string().min(1) }).strict().nullable(),
      groupRules: count,
    }).strict(),
    description: z.object({ hasIntroduction: z.boolean(), hasFooter: z.boolean(), groupRules: count }).strict(),
  }).strict(),
  /** Null when the selection is too large to check. */
  counts: z.object({
    productsNeedingFix: count,
    productsWithSizesDiffer: count,
    /** Products the `own_settings` filter lists: a size with its own value for a setting or an exact price. */
    productsWithOwnSettings: count,
    exactPrices: count,
    belowCost: count,
    cannotPrice: count,
    paused: count,
  }).strict().nullable(),
  attention: z.object({
    items: z.array(z.object({
      code: z.enum(LISTING_SETTINGS_ATTENTION_CODES),
      count: z.number().int().positive(),
      /** The product to open, for a line about one product. */
      productId: id.nullable(),
      productName: z.string().nullable(),
    }).strict()).max(MAX_LISTING_SETTINGS_ATTENTION_ITEMS),
    total: count,
  }).strict(),
  rail: z.object({
    state: z.enum(LISTING_SETTINGS_RAIL_STATES),
    productsNeedingFix: count,
    /** The first missing store policy, in the order shipping, return, payment. */
    missingPolicy: z.enum(LISTING_SETTINGS_POLICY_KINDS).nullable(),
  }).strict(),
  generatedAt: z.string().datetime(),
}).strict();

export type ListingSettingsProductsInput = z.infer<typeof listingSettingsProductsInputSchema>;
export type ListingSettingsPricesInput = z.infer<typeof listingSettingsPricesInputSchema>;
export type ListingSettingsPriceSource = (typeof LISTING_SETTINGS_PRICE_SOURCES)[number];
export type ListingSettingsPriceIssue = (typeof LISTING_SETTINGS_PRICE_ISSUES)[number];
export type ListingSettingsPriceLimit = z.infer<typeof listingSettingsPriceLimitSchema>;
export type ListingSettingsPriceRule = z.infer<typeof listingSettingsPriceRuleSchema>;
export type ListingSettingsSizePrice = z.infer<typeof listingSettingsSizePriceSchema>;
export type ListingSettingsField = (typeof LISTING_SETTINGS_FIELDS)[number];
export type ListingSettingsFixCode = (typeof LISTING_SETTINGS_FIX_CODES)[number];
export type ListingSettingsProductRow = z.infer<typeof listingSettingsProductRowSchema>;
export type ListingSettingsPricesResponse = z.infer<typeof listingSettingsPricesResponseSchema>;
export type ListingSettingsProductsResponse = z.infer<typeof listingSettingsProductsResponseSchema>;
export type ListingSettingsAttentionCode = (typeof LISTING_SETTINGS_ATTENTION_CODES)[number];
export type ListingSettingsPolicyKind = (typeof LISTING_SETTINGS_POLICY_KINDS)[number];
export type ListingSettingsRailState = (typeof LISTING_SETTINGS_RAIL_STATES)[number];
export type ListingSettingsSummary = z.infer<typeof listingSettingsSummarySchema>;
export type ListingSettingsProductInput = z.infer<typeof listingSettingsProductInputSchema>;
export type ListingSettingsValueSource = (typeof LISTING_SETTINGS_VALUE_SOURCES)[number];
export type ListingSettingsPolicyValue = z.infer<typeof listingSettingsPolicyValueSchema>;
export type ListingSettingsEbayCategoryValue = z.infer<typeof listingSettingsEbayCategoryValueSchema>;
export type ListingSettingsStoreShelfValue = z.infer<typeof listingSettingsStoreShelfValueSchema>;
export type ListingSettingsDescriptionTemplateValue = z.infer<typeof listingSettingsDescriptionTemplateValueSchema>;
export type ListingSettingsMainTextValue = z.infer<typeof listingSettingsMainTextValueSchema>;
export type ListingSettingsProductSettings = z.infer<typeof listingSettingsProductSettingsSchema>;
export type ListingSettingsSettingKey = keyof ListingSettingsProductSettings;
export type ListingSettingsProductSize = z.infer<typeof listingSettingsProductSizeSchema>;
export type ListingSettingsProductDetail = z.infer<typeof listingSettingsProductDetailSchema>;
