import { z } from "zod";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";
import { ebayCategoryIdSchema } from "./ebay-category-rules";
import { DROPSHIP_LISTING_ACCESS_BLOCK_CODES, DROPSHIP_LISTING_ACCESS_RESOLUTIONS } from "./listing-access";
import { MAX_TEMPLATE_TEXT_LENGTH } from "./listing-content";
import { RULE_PRICE_OUTSIDE_LIMIT_ISSUE, listingAmountCentsSchema, listingPriceBasisSchema, listingPriceCentsSchema } from "./listing-price";
import { CATEGORY_LISTING_SETTING_FIELDS } from "./listing-setting-values";
import { pricingRecipeSchema } from "./pricing-rules";

/**
 * The read-only listing settings views of one store (Listing settings design 8.4):
 * a summary, every chosen size's price, one row per chosen product, and one
 * product's settings in full.
 *
 * They read the store defaults, the values left on single sizes by the
 * current step 2 panels, and the product and Card Shellz category settings;
 * each category's own settings have their own views (PR 9e), and the products
 * Card Shellz moved to another category, or whose own text needs a check,
 * have theirs ("Card Shellz updated products", PR 9g). No existing view
 * changes shape for them (plan P27). No view calls eBay, so a saved policy is
 * reported by id with `verification: "not_checked"`.
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
  /** Only the products in this Card Shellz category (catalog.product_categories.id). */
  categoryId: id.optional(),
}).strict();

/** Which sizes the Prices tab lists. `retail_fallback`: sizes whose price source is `retail_fallback`. */
export const LISTING_SETTINGS_PRICE_FILTERS = ["all", "exact_prices", "below_cost", "cannot_price", "paused", "retail_fallback"] as const;
export const listingSettingsPricesInputSchema = z.object({
  storeConnectionId: id,
  search: search.default(""),
  show: z.enum(LISTING_SETTINGS_PRICE_FILTERS).default("all"),
  page: page.default(0),
  /** Only the sizes of products in this Card Shellz category. */
  categoryId: id.optional(),
}).strict();

/**
 * Every chosen product the Products tab's filters match, unpaged, with the
 * revision of its own settings: "Select all N" sends each product's revision
 * with a bulk change, and one product's editor sends its own (`productId`).
 */
export const listingSettingsProductIdsInputSchema = z.object({
  storeConnectionId: id,
  search: search.default(""),
  show: z.enum(LISTING_SETTINGS_PRODUCT_FILTERS).default("all"),
  categoryId: id.optional(),
  productId: id.optional(),
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
  /**
   * `store_default` is the store's default recipe; `group` is an older group
   * rule; `product` is the product's own price (`name` is the product's);
   * `category` is its Card Shellz category's price (`name` is the category's
   * current name).
   */
  kind: z.enum(["store_default", "group", "product", "category"]),
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
  /** Settings the product, or at least one chosen size, has its own value for. */
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
/** `revisionId` is the product's own settings revision; null when the product has none yet. */
export const listingSettingsProductIdsResponseSchema = z.object({
  total: count,
  rows: z.array(z.object({ productId: id, revisionId: id.nullable() }).strict()).max(MAX_NAMED_CATALOG_GROUP_ITEMS),
}).strict().superRefine((response, context) => {
  if (response.total !== response.rows.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every matching product is listed.", path: ["total"] });
  }
  if (new Set(response.rows.map((row) => row.productId)).size !== response.rows.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each product once.", path: ["rows"] });
  }
});

// ---------------------------------------------------------------------------
// One product's settings (GET …/products/:productId)
// ---------------------------------------------------------------------------

/**
 * Where a size gets a setting's value, closest first (the order the
 * precedence reads, design 5.1):
 * - `size`: a value left on this size by today's per-size settings;
 * - `product`: the product's own setting;
 * - `group_rule`: an older group rule, named in `ruleName`;
 * - `category`: the setting of the product's Card Shellz category, named in `ruleName`;
 * - `store_default`: the store default;
 * - `catalog`: Card Shellz (the eBay category it chose for the product, or its main text);
 * - `none`: nothing is set.
 * The facts engine lists a value's sources in this order. Today's five keep
 * their relative order, so a value that comes only from them reads as before.
 */
export const LISTING_SETTINGS_VALUE_SOURCES = ["size", "product", "group_rule", "category", "store_default", "catalog", "none"] as const;
/** The sources that carry a name: the older group rule's, or the category's current name. */
const NAMED_VALUE_SOURCES: ReadonlySet<ListingSettingsValueSource> = new Set<ListingSettingsValueSource>(["group_rule", "category"]);
/** The sources that are the product's own value: a size's (today's per-size settings) or the product's. */
const OWN_VALUE_SOURCES: ReadonlySet<ListingSettingsValueSource> = new Set<ListingSettingsValueSource>(["size", "product"]);

const valueSourceSchema = z.object({
  source: z.enum(LISTING_SETTINGS_VALUE_SOURCES),
  /** The older group rule's name, or the Card Shellz category's current name; null for every other source. */
  ruleName: z.string().min(1).nullable(),
  /** The chosen sizes that get the value from here, in the order `sizes` lists them. */
  productVariantIds: z.array(id).min(1),
}).strict().refine((entry) => NAMED_VALUE_SOURCES.has(entry.source) === (entry.ruleName !== null),
  "A group rule and a category are named, and no other source is.");

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
    const own = settings.some((values) => values.some((value) => value.sources.some((entry) => OWN_VALUE_SOURCES.has(entry.source))));
    if (differ !== detail.product.sizesDiffer.includes(field)) issue(`Sizes differ for ${field} only when it has more than one value.`, ["product", "sizesDiffer"]);
    if (own !== detail.product.ownSettings.includes(field)) issue(`${field} is an own setting only when a size or the product has its own value.`, ["product", "ownSettings"]);
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

// ---------------------------------------------------------------------------
// Card Shellz categories (GET …/categories, GET …/categories/:categoryId)
// ---------------------------------------------------------------------------

/** One Card Shellz category of the store's chosen products (catalog.product_categories.id). */
export const listingSettingsCategoryInputSchema = z.object({ storeConnectionId: id, categoryId: id }).strict();
/** A category's detail names at most this many of its sizes' prices, as examples. */
export const MAX_LISTING_SETTINGS_CATEGORY_EXAMPLES = 3;

/** A category's own settings, each once, in the stored shape's order (CATEGORY_LISTING_SETTING_FIELDS). */
const categoryFields = z.array(z.enum(CATEGORY_LISTING_SETTING_FIELDS))
  .refine((fields) => new Set(fields).size === fields.length, "Each setting once.");

/**
 * Every Card Shellz category that holds at least one of the store's chosen
 * products, sorted by its current name, then id. `setFields`: the settings
 * the category has its own value for, in the stored shape's order.
 * `revisionId` is the category's settings revision (null when it has none),
 * which a category save sends back.
 */
export const listingSettingsCategoriesResponseSchema = z.object({
  storeConnectionId: id,
  categories: z.array(z.object({
    categoryId: id,
    /** The category's current Card Shellz name. */
    name: z.string().min(1),
    /** The store's chosen products in this category. */
    productCount: z.number().int().positive(),
    revisionId: id.nullable(),
    setFields: categoryFields,
  }).strict()).max(MAX_NAMED_CATALOG_GROUP_ITEMS),
  /** Chosen products with no Card Shellz category: they follow the store defaults. */
  uncategorizedProductCount: count,
  generatedAt: z.string().datetime(),
}).strict().superRefine((response, context) => {
  if (new Set(response.categories.map((category) => category.categoryId)).size !== response.categories.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each category once.", path: ["categories"] });
  }
  response.categories.forEach((category, index) => {
    if (category.revisionId === null && category.setFields.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A category with no settings row sets nothing.", path: ["categories", index] });
    }
  });
});

/**
 * Where a category's setting comes from: `category` its own value, else
 * `store_default` the store's, else `none`. A value is given exactly when one
 * applies. Older group rules are not named: while a store holds any, its
 * category saves are refused until they are converted (plan P21).
 */
export const LISTING_SETTINGS_CATEGORY_SETTING_SOURCES = ["category", "store_default", "none"] as const;
const sourced = <T extends z.ZodTypeAny>(value: T) => z.object({
  source: z.enum(LISTING_SETTINGS_CATEGORY_SETTING_SOURCES),
  value: value.nullable(),
}).strict().refine((setting) => (setting.source === "none") === (setting.value === null), "A value is given exactly when one applies.");

/** An eBay category by its number, with the name eBay gave it. */
const categoryEbayCategorySchema = z.object({ categoryId: ebayCategoryIdSchema, categoryName: z.string().min(1) }).strict();
/** `none`: explicitly no shelf. `own`: the first shelf, then the second, each by id with its path (the store default's included). */
const categoryStoreShelfSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("own"), shelves: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()).min(1).max(2) }).strict(),
]);
/**
 * A policy by id, with the name the category's row stores. A store default
 * comes with its id only (name null), as the summary's storeDefaults name it:
 * these views do not read the listing config's stored policy names.
 */
const categoryPolicySchema = z.object({ id: z.string().min(1), name: z.string().min(1).nullable() }).strict();
/** Text above or below the main text: `none`, or the text itself. */
const categoryTemplateTextSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("own"), text: z.string().min(1).max(MAX_TEMPLATE_TEXT_LENGTH) }).strict(),
]);

export const listingSettingsCategorySettingsSchema = z.object({
  price: sourced(pricingRecipeSchema),
  ebayCategory: sourced(categoryEbayCategorySchema),
  storeShelf: sourced(categoryStoreShelfSchema),
  shippingPolicy: sourced(categoryPolicySchema),
  returnPolicy: sourced(categoryPolicySchema),
  paymentPolicy: sourced(categoryPolicySchema),
  textAbove: sourced(categoryTemplateTextSchema),
  textBelow: sourced(categoryTemplateTextSchema),
}).strict();

/**
 * One category's settings in full, for its editor: each setting with where it
 * comes from, the chosen products that hold their own value for one (each
 * with its settings revision, which "Also clear theirs" sends back), and up to
 * three of its sizes' prices as examples.
 */
export const listingSettingsCategoryDetailSchema = z.object({
  storeConnectionId: id,
  categoryId: id,
  name: z.string().min(1),
  productCount: z.number().int().positive(),
  revisionId: id.nullable(),
  settings: listingSettingsCategorySettingsSchema,
  /**
   * Chosen products in this category with their own value for a category setting (a size's leftover counts for policies
   * and the shelf). "Also clear theirs" sends exactly the entries whose `fields` include a cleared setting: the server
   * derives that set and answers 409 for any other (an entry whose only own value is the price is never in it, since a
   * clear cannot name the price, plan P34).
   */
  ownValues: z.array(z.object({
    productId: id,
    /** The product's own settings revision; null when it has none (its own value is a size's leftover). */
    revisionId: id.nullable(),
    fields: categoryFields.refine((fields) => fields.length > 0, "At least one setting."),
  }).strict()).max(MAX_NAMED_CATALOG_GROUP_ITEMS),
  examples: z.array(listingSettingsSizePriceSchema).max(MAX_LISTING_SETTINGS_CATEGORY_EXAMPLES),
  generatedAt: z.string().datetime(),
}).strict().superRefine((detail, context) => {
  if (detail.revisionId === null && Object.values(detail.settings).some((setting) => setting.source === "category")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A category with no settings row has no value of its own.", path: ["settings"] });
  }
  if (new Set(detail.ownValues.map((entry) => entry.productId)).size !== detail.ownValues.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each product once.", path: ["ownValues"] });
  }
  if (detail.ownValues.length > detail.productCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "More products hold own values than the category has.", path: ["ownValues"] });
  }
});

// ---------------------------------------------------------------------------
// Card Shellz updated products (GET …/updated-products, PR 9g)
// ---------------------------------------------------------------------------

/** One page of the products Card Shellz updated. */
export const listingSettingsUpdatedProductsInputSchema = z.object({ storeConnectionId: id, page: page.default(0) }).strict();

/** A Card Shellz category by id with its current name; no category is `{ categoryId: null, name: null }`. */
const updatedProductCategorySchema = z.object({
  categoryId: id.nullable(),
  /** Null for no category, and for a category Card Shellz has since deleted (a mark keeps its id, plan D13). */
  name: z.string().min(1).nullable(),
}).strict().refine((category) => category.categoryId !== null || category.name === null, "Only a category has a name.");

/**
 * One product to "Got it" for (W13's item shape, `categoryMovesAcknowledgeItemsSchema`): the category the vendor is shown now,
 * which the page sends back unchanged.
 */
const updatedProductMoveItemSchema = z.object({ productId: id, shownCategoryId: id.nullable() }).strict();

/**
 * The chosen products Card Shellz updated, in the Products tab's order (name,
 * then id), 50 a page:
 * - `move`: Card Shellz moved the product to another category since the
 *   vendor last confirmed it (its mark), with the category it came from, the
 *   one it is in now (current names), and the category settings that differ
 *   between the two and that the product's own values or its sizes' do not
 *   cover (`changedFields`, in the stored shape's order; may be empty). It
 *   compares category settings only: in a store with older group rules
 *   scoped to a category (matched by its name), a move can also change the
 *   listing through those rules, which `changedFields` does not show;
 * - `ownTextNeedsCheck`: own text written against Card Shellz facts that
 *   have since changed.
 * `moves` lists every moved product, on every page ("Got it for all N" sends
 * it to W13 as it is, plan 10.8 #1).
 */
export const listingSettingsUpdatedProductsResponseSchema = z.object({
  storeConnectionId: id,
  page,
  pageSize: z.literal(LISTING_SETTINGS_PAGE_SIZE),
  total: count,
  rows: z.array(z.object({
    productId: id,
    productName: z.string(),
    ownTextNeedsCheck: z.boolean(),
    move: z.object({
      from: updatedProductCategorySchema,
      to: updatedProductCategorySchema,
      changedFields: categoryFields,
    }).strict().nullable(),
  }).strict()).max(LISTING_SETTINGS_PAGE_SIZE),
  moves: z.object({
    total: count,
    items: z.array(updatedProductMoveItemSchema).max(MAX_NAMED_CATALOG_GROUP_ITEMS),
  }).strict(),
  generatedAt: z.string().datetime(),
}).strict().superRefine((response, context) => {
  const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (response.moves.total !== response.moves.items.length) issue("Every moved product is listed.", ["moves", "total"]);
  if (new Set(response.moves.items.map((item) => item.productId)).size !== response.moves.items.length) {
    issue("Each moved product once.", ["moves", "items"]);
  }
  if (new Set(response.rows.map((row) => row.productId)).size !== response.rows.length) issue("Each product once.", ["rows"]);
  const shown = new Map(response.moves.items.map((item) => [item.productId, item.shownCategoryId]));
  response.rows.forEach((row, index) => {
    if (row.move === null && !row.ownTextNeedsCheck) issue("A product is listed only when Card Shellz updated it.", ["rows", index]);
    if (row.move === null) {
      if (shown.has(row.productId)) issue("A product with a Got it item is listed with its move.", ["rows", index, "move"]);
      return;
    }
    if (row.move.from.categoryId === row.move.to.categoryId) issue("A moved product is in another category now.", ["rows", index, "move"]);
    // The category a product is in now exists in the same snapshot (a delete sets its products' category to null).
    if (row.move.to.categoryId !== null && row.move.to.name === null) issue("The current category is named.", ["rows", index, "move", "to"]);
    if (!shown.has(row.productId) || shown.get(row.productId) !== row.move.to.categoryId) {
      issue("A moved product's Got it item shows its current category.", ["rows", index, "move"]);
    }
  });
});

export type ListingSettingsProductsInput = z.infer<typeof listingSettingsProductsInputSchema>;
export type ListingSettingsProductIdsInput = z.infer<typeof listingSettingsProductIdsInputSchema>;
export type ListingSettingsProductIdsResponse = z.infer<typeof listingSettingsProductIdsResponseSchema>;
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
export type ListingSettingsCategoryInput = z.infer<typeof listingSettingsCategoryInputSchema>;
export type ListingSettingsCategoriesResponse = z.infer<typeof listingSettingsCategoriesResponseSchema>;
export type ListingSettingsCategorySettingSource = (typeof LISTING_SETTINGS_CATEGORY_SETTING_SOURCES)[number];
export type ListingSettingsCategorySettings = z.infer<typeof listingSettingsCategorySettingsSchema>;
export type ListingSettingsCategoryDetail = z.infer<typeof listingSettingsCategoryDetailSchema>;
export type ListingSettingsUpdatedProductsInput = z.infer<typeof listingSettingsUpdatedProductsInputSchema>;
export type ListingSettingsUpdatedProductsResponse = z.infer<typeof listingSettingsUpdatedProductsResponseSchema>;
