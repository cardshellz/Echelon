import { z } from "zod";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";
import { listingPriceCentsSchema } from "./listing-price";
import { LISTING_SETTING_KEY_PATTERN, listingSettingRequestKeySchema } from "./listing-setting-values";
import { LISTING_SETTINGS_FIX_CODES, listingSettingsPriceRuleSchema, listingSettingsSizePriceSchema } from "./listing-settings";

/**
 * Moving a store's older group rules into category and product settings
 * (PR 11, design record 8.7): the dry run's input and its strict answer
 * (plan 4.A.3). The answer is computed fresh on every read and stores
 * nothing (plan D14); ids are keys only and are never shown (owner rule). The
 * apply's input and answer (11c2) and the conversion record (plan 12) are
 * here too; the one-time notice (11e1) adds its contracts here.
 *
 * Every price is integer cents (the size price is the read model's own,
 * `listingSettingsSizePriceSchema`), and every list is closed and capped.
 */

/** Sizes per page of the dry run's changed rows (= the listing settings pages). */
export const CONVERSION_PAGE_SIZE = 50;
/** Items per report list; `total` always counts them all (plan 4.A.3). */
export const MAX_CONVERSION_REPORT_ITEMS = 100;
/** Enough pages for every row of the largest selection the dry run checks (10,000 sizes at 50 a page): 199. */
export const MAX_CONVERSION_PAGE = Math.ceil(MAX_NAMED_CATALOG_GROUP_ITEMS / CONVERSION_PAGE_SIZE) - 1;

/** What the dry run says of a store (plan 4.A.8): nothing to move, a move that changes nothing, or one that does. */
export const CONVERSION_STATES = ["no_older_rules", "clean", "not_clean"] as const;
/**
 * The keys the dry run compares per chosen size (plan 3.2, D3), in the order
 * a changed row names them. `pricingRule` is the rule a size follows whether or
 * not it can price the size today; `listable` is the size's blockers.
 */
export const CONVERSION_CHANGED_FIELDS = [
  "price", "priceSource", "pricingRule", "ebayCategory", "storeShelf", "shippingPolicy", "returnPolicy", "paymentPolicy",
  "description", "listable",
] as const;
/**
 * The description issues no fix code of the read model covers (plan 3.2), as
 * the content resolver names them. The preview blocks on every description
 * issue; the other two (a group tie, own text to check) are already the fix
 * codes `description_group_conflict` and `own_text_needs_check`.
 */
export const CONVERSION_CONTENT_BLOCKER_CODES = [
  "listing_content_catalog_too_large", "listing_content_description_required", "listing_content_description_too_large",
] as const;
/**
 * Why a size can't be listed, as the dry run compares it (plan 3.2): the four
 * fix codes of the read model (in their order), a price outside a blocking
 * Card Shellz limit, and the three description issues no fix code covers.
 * Closed: the client words each one (plan 11.4).
 */
export const CONVERSION_BLOCKER_CODES = [
  ...LISTING_SETTINGS_FIX_CODES,
  "price_outside_limit",
  ...CONVERSION_CONTENT_BLOCKER_CODES,
] as const;
/** The settings a conversion writes (rules decide only price, description and eBay category; plan D6). */
export const CONVERSION_SETTINGS = ["price", "ebayCategory", "textAbove", "textBelow"] as const;
/** The three kinds of older group rules (plan D4): a pricing group, a description group, an eBay category rule. */
export const CONVERSION_RULE_KINDS = ["price", "description", "ebayCategory"] as const;
/** What two tied rules leave without a value: a tie is a price tie or a description tie (eBay rules cannot tie). */
export const CONVERSION_TIE_SETTINGS = ["price", "description"] as const;

/**
 * The refusals the conversion adds (plan 3.4): the check (11a2) answers
 * `checkUnavailable`, the apply (11c2) all three. The shared write code list
 * (LISTING_SETTING_WRITE_ERROR_CODES) names the same three.
 */
export const LISTING_RULES_CONVERSION_ERROR_CODES = Object.freeze({
  /** 409, permanent: the plan recomputed under the store lock differs from the one the vendor was shown. */
  changed: "DROPSHIP_LISTING_CONVERSION_CHANGED",
  /** 503, transient: the .ops costs could not be read, so prices from cost can't be compared. */
  checkUnavailable: "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE",
  /** 422, permanent: a size listed on eBay that can be sent today would be blocked after the move (plan D9b). */
  wouldBlockListing: "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING",
} as const);
/** `context.reason` of `changed` (plan 3.3): the writes moved, or only the listed changes did (a cost, say). */
export const CONVERSION_CHANGED_REASONS = ["settings_changed", "listed_changes_moved"] as const;

const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const ruleName = z.string().min(1);
const ruleKind = z.enum(CONVERSION_RULE_KINDS);
const setting = z.enum(CONVERSION_SETTINGS);
const blockerCode = z.enum(CONVERSION_BLOCKER_CODES);

/** A closed list, each value once, in the list's own order: the form every set-valued field takes, so equal sets read equal. */
function orderedSet<T extends readonly [string, ...string[]]>(values: T) {
  return z.array(z.enum(values)).refine((items) => items.every((item, index) =>
    index === 0 || values.indexOf(items[index - 1]) < values.indexOf(item)), "Each value once, in the list's order.");
}

/** `{ total, items }`: at most MAX_CONVERSION_REPORT_ITEMS items, and as many as there are up to that cap. */
function conversionListOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ total: count, items: z.array(item).max(MAX_CONVERSION_REPORT_ITEMS) }).strict()
    .refine((list) => list.items.length === Math.min(list.total, MAX_CONVERSION_REPORT_ITEMS),
      "A list carries every item up to its cap, and counts them all.");
}

export const listingRulesConversionCheckInputSchema = z.object({
  storeConnectionId: id,
  page: z.number().int().min(0).max(MAX_CONVERSION_PAGE).default(0),
}).strict();

/** One chosen size, with today's price (null when it has none). */
export const sizeRefSchema = z.object({
  productId: id,
  productVariantId: id,
  productName: z.string(),
  sizeName: z.string(),
  priceCents: listingPriceCentsSchema.nullable(),
}).strict();

/**
 * The pricing rule a size follows (plan 3.2): the store default, an older
 * group, the product's own price or its category's, each with its recipe and
 * the name the Prices tab gives it; or two rules that tie (no name, no
 * recipe). Null (outside this schema) for a size that owns its price, or that
 * no rule covers.
 */
export const pricingRuleRefSchema = z.union([
  listingSettingsPriceRuleSchema,
  z.object({ kind: z.literal("tie") }).strict(),
]);

/** One side of a changed size (plan 4.A.3): what the compared keys read, as the page reads them. */
export const conversionSizeViewSchema = z.object({
  /** The read model's size price, as the Prices tab reads it. */
  price: listingSettingsSizePriceSchema,
  pricingRule: pricingRuleRefSchema.nullable(),
  /** eBay lists by the id; the name is a label and may be missing for a Card Shellz base category. */
  ebayCategory: z.object({ id: z.string().min(1), name: z.string().min(1).nullable() }).strict().nullable(),
  /** The first shelf, then the second; empty means none. */
  shelfNames: z.array(z.string().min(1)).max(2),
  /** Policy ids, keys only (no policy name is stored). */
  policies: z.object({
    shipping: z.string().min(1).nullable(),
    return: z.string().min(1).nullable(),
    payment: z.string().min(1).nullable(),
  }).strict(),
  /** sha256 of the description HTML the listing is sent. */
  descriptionHash: sha256Hex,
  blockers: orderedSet(CONVERSION_BLOCKER_CODES),
}).strict();

export const conversionChangeRowSchema = z.object({
  productVariantId: id,
  productId: id,
  productName: z.string(),
  sizeName: z.string(),
  changed: orderedSet(CONVERSION_CHANGED_FIELDS).refine((fields) => fields.length > 0, "A changed row names what changes."),
  before: conversionSizeViewSchema,
  after: conversionSizeViewSchema,
}).strict().superRefine((row, context) => {
  for (const side of ["before", "after"] as const) {
    const price = row[side].price;
    if (price.productVariantId !== row.productVariantId || price.productId !== row.productId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Both sides are the row's size.", path: [side, "price"] });
    }
  }
});

const categoryBecomes = z.object({ categoryId: id, categoryName: z.string().min(1), settings: orderedSet(CONVERSION_SETTINGS)
  .refine((settings) => settings.length > 0, "A category in the list gets at least one setting.") }).strict();
const productBecomes = z.object({ productId: id, productName: z.string(), settings: orderedSet(CONVERSION_SETTINGS)
  .refine((settings) => settings.length > 0, "A product in the list gets at least one setting.") }).strict();

export const conversionReportSchema = z.object({
  /** Category rules whose category name no Card Shellz category has (never also in `neverApplies`). */
  unmatched: conversionListOf(z.object({ ruleName, categoryName: z.string().min(1), kind: ruleKind }).strict()),
  /**
   * Category rules whose name two or more Card Shellz categories share, with
   * how many share it (plan D8): each of them is a target, and one that
   * already sets the field itself keeps its own value (plan 4.A.4).
   */
  shared: conversionListOf(z.object({ ruleName, categoryName: z.string().min(1), categoryCount: z.number().int().min(2), kind: ruleKind }).strict()),
  /** Chosen products whose copy of the category name differs from their category's (or one of the two is missing). */
  nameMismatches: conversionListOf(z.object({
    productId: id, productName: z.string(), listedAs: z.string().nullable(), categoryName: z.string().nullable(),
  }).strict().refine((item) => item.listedAs !== null || item.categoryName !== null, "A mismatch has a copy or a category.")),
  /** Rules the move writes nothing for and that decide no chosen size today. */
  neverApplies: conversionListOf(z.object({ ruleName, kind: ruleKind }).strict()),
  ties: conversionListOf(z.object({ productId: id, productName: z.string(), setting: z.enum(CONVERSION_TIE_SETTINGS) }).strict()),
  /** A named-size rule that decides the setting for only some of the product's chosen sizes. */
  someSizesOnly: conversionListOf(z.object({ ruleName, productId: id, productName: z.string(), setting }).strict()),
  /** Different rules decide the setting for the product's chosen sizes. */
  mixed: conversionListOf(z.object({ productId: id, productName: z.string(), setting }).strict()),
}).strict();

/** Per-size rows the move keeps as they are (plan D6), counted over the chosen sizes. */
export const conversionKeptSchema = z.object({
  exactPrices: count, catalogPrices: count, sizePolicies: count, sizeShelves: count, sizeTexts: count,
}).strict();

export const listingRulesConversionCheckSchema = z.object({
  storeConnectionId: id,
  generatedAt: z.string().datetime(),
  state: z.enum(CONVERSION_STATES),
  /** Null only for `no_older_rules` (plan 3.3): the apply sends both hashes back. */
  planHash: sha256Hex.nullable(),
  writesHash: sha256Hex.nullable(),
  olderRules: z.object({ pricingGroups: count, contentGroups: count, ebayCategoryRules: count }).strict(),
  blocked: z.object({
    wouldLosePrice: conversionListOf(sizeRefSchema),
    wouldBlockListing: conversionListOf(sizeRefSchema.extend({
      reasons: orderedSet(CONVERSION_BLOCKER_CODES).refine((reasons) => reasons.length > 0, "A blocked size says why."),
    }).strict()),
    tooMuchText: z.boolean(),
  }).strict(),
  becomes: z.object({ categories: conversionListOf(categoryBecomes), products: conversionListOf(productBecomes) }).strict(),
  report: conversionReportSchema,
  kept: conversionKeptSchema,
  changes: z.object({
    page: z.number().int().min(0).max(MAX_CONVERSION_PAGE),
    pageSize: z.literal(CONVERSION_PAGE_SIZE),
    total: count.max(MAX_NAMED_CATALOG_GROUP_ITEMS),
    rows: z.array(conversionChangeRowSchema).max(CONVERSION_PAGE_SIZE),
  }).strict().refine((changes) => changes.rows.length <= changes.total, "A page holds no more rows than there are."),
}).strict().superRefine((check, context) => {
  const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const noRules = check.state === "no_older_rules";
  const counts = check.olderRules;
  if (noRules !== (counts.pricingGroups + counts.contentGroups + counts.ebayCategoryRules === 0)) {
    issue("A store has no older rules exactly when it holds none.", ["state"]);
  }
  if (noRules !== (check.planHash === null)) issue("Only a store with no older rules has no plan hash.", ["planHash"]);
  if (noRules !== (check.writesHash === null)) issue("Only a store with no older rules has no writes hash.", ["writesHash"]);
  const blocked = check.blocked.wouldLosePrice.total > 0 || check.blocked.wouldBlockListing.total > 0 || check.blocked.tooMuchText;
  if (check.state !== "not_clean" && (check.changes.total > 0 || blocked)) {
    issue("A store with changed or blocked sizes is not clean.", ["state"]);
  }
  if (check.state === "not_clean" && check.changes.total === 0 && !blocked) {
    issue("A store that is not clean has a changed or a blocked size.", ["state"]);
  }
});

/** Who applies a conversion (plan D10): the vendor from the sheet (11c2), or the system job (11e2). */
export const LISTING_RULE_CONVERSION_ACTOR_TYPES = ["vendor", "system"] as const;
/**
 * The most rules of one kind a store holds, so the most one conversion removes:
 * 100 pricing groups and 100 description groups (their profile schemas) and
 * MAX_EBAY_CATEGORY_RULES eBay category rules. The record's CHECK repeats it.
 */
export const MAX_CONVERSION_REMOVED_RULES = 100;
/** = the record's varchar(255) actor and notice reader columns, as the listing-settings writers bound their actors. */
export const MAX_CONVERSION_ACTOR_ID_LENGTH = 255;
const removedCount = count.max(MAX_CONVERSION_REMOVED_RULES);
const sizeCount = count.max(MAX_NAMED_CATALOG_GROUP_ITEMS);
const actorId = z.string().max(MAX_CONVERSION_ACTOR_ID_LENGTH).refine((value) => value.trim() !== "", "An actor is named.");

/** What a conversion records when it is applied (plan 12): its key, the request, plan and writes hashes, and integer counts. */
const conversionRecordValues = {
  vendorId: id,
  storeConnectionId: id,
  idempotencyKey: z.string().regex(LISTING_SETTING_KEY_PATTERN),
  requestHash: sha256Hex,
  planHash: sha256Hex,
  writesHash: sha256Hex,
  clean: z.boolean(),
  changedSizeCount: sizeCount,
  categoryCount: sizeCount,
  productCount: sizeCount,
  pricingGroupsRemoved: removedCount,
  contentGroupsRemoved: removedCount,
  ebayRulesRemoved: removedCount,
  actorType: z.enum(LISTING_RULE_CONVERSION_ACTOR_TYPES),
  actorId,
};

/** The record's rules on clean conversions, as its CHECKs hold them (plan D1). */
function refineConversionRecord(record: { clean: boolean; changedSizeCount: number; actorType: string }, context: z.RefinementCtx): void {
  if (record.clean && record.changedSizeCount !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A clean conversion changes no size.", path: ["changedSizeCount"] });
  }
  if (record.actorType === "system" && !record.clean) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The system applies only a clean store.", path: ["clean"] });
  }
}

/** A conversion about to be recorded, before the database gives it an id and the clock stamps it. */
export const listingRuleConversionValuesSchema = z.object(conversionRecordValues).strict().superRefine(refineConversionRecord);

/**
 * A recorded conversion (plan 12): the row as the database holds it. Only a
 * system conversion has a notice, seen once by someone (plan D19).
 */
export const listingRuleConversionRecordSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ...conversionRecordValues,
  createdAt: z.string().datetime(),
  noticeSeenAt: z.string().datetime().nullable(),
  noticeSeenBy: actorId.nullable(),
}).strict().superRefine((record, context) => {
  refineConversionRecord(record, context);
  if ((record.noticeSeenAt === null) !== (record.noticeSeenBy === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A notice is seen at a time, by someone.", path: ["noticeSeenBy"] });
  }
  if (record.actorType !== "system" && record.noticeSeenAt !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only a system conversion has a notice.", path: ["noticeSeenAt"] });
  }
});

/**
 * The vendor's apply (plan 7.B.1, 7.B.2): the request key, and the two hashes
 * of the dry run he was shown. The server keeps no copy of that plan, so it
 * recomputes both under the store lock and writes only when they are these
 * (plan D1, 3.3). The key is reused while the plan hash is the same (plan D12);
 * a reserved key (RESERVED_CONVERSION_KEY_PREFIXES, listing-rules-conversion-keys.ts)
 * is refused (400) by the request key schema itself.
 */
export const listingRulesConversionApplyInputSchema = z.object({
  idempotencyKey: listingSettingRequestKeySchema,
  planHash: sha256Hex,
  writesHash: sha256Hex,
}).strict();

/**
 * What an apply answers (plan 7.B.2): `converted` (this request moved the
 * rules), `replayed` (this key already did; answered from its record) or
 * `nothing_to_convert` (the store holds no older group rules now: nothing is
 * written and nothing recorded).
 */
export const LISTING_RULES_CONVERSION_APPLY_OUTCOMES = ["converted", "replayed", "nothing_to_convert"] as const;

/**
 * The apply's strict answer: the record's id and the categories and products
 * it wrote. Only `nothing_to_convert` has no record, and then it wrote
 * nothing (both counts 0).
 */
export const listingRulesConversionApplyResponseSchema = z.object({
  outcome: z.enum(LISTING_RULES_CONVERSION_APPLY_OUTCOMES),
  conversionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  categoryCount: sizeCount,
  productCount: sizeCount,
}).strict().superRefine((answer, context) => {
  const nothing = answer.outcome === "nothing_to_convert";
  if (nothing !== (answer.conversionId === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only a store with nothing to convert has no record.", path: ["conversionId"] });
  }
  if (nothing && (answer.categoryCount !== 0 || answer.productCount !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Nothing to convert writes nothing.", path: ["categoryCount"] });
  }
});

export type ListingRulesConversionCheckInput = z.infer<typeof listingRulesConversionCheckInputSchema>;
export type ListingRulesConversionApplyInput = z.infer<typeof listingRulesConversionApplyInputSchema>;
export type ListingRulesConversionApplyResponse = z.infer<typeof listingRulesConversionApplyResponseSchema>;
export type ListingRulesConversionApplyOutcome = (typeof LISTING_RULES_CONVERSION_APPLY_OUTCOMES)[number];
export type ListingRulesConversionCheck = z.infer<typeof listingRulesConversionCheckSchema>;
export type ConversionState = (typeof CONVERSION_STATES)[number];
export type ConversionChangedField = (typeof CONVERSION_CHANGED_FIELDS)[number];
export type ConversionBlockerCode = (typeof CONVERSION_BLOCKER_CODES)[number];
export type ConversionContentBlockerCode = (typeof CONVERSION_CONTENT_BLOCKER_CODES)[number];
export type ConversionSetting = (typeof CONVERSION_SETTINGS)[number];
export type ConversionRuleKind = (typeof CONVERSION_RULE_KINDS)[number];
export type ConversionTieSetting = (typeof CONVERSION_TIE_SETTINGS)[number];
export type ConversionChangedReason = (typeof CONVERSION_CHANGED_REASONS)[number];
export type ListingRuleConversionActorType = (typeof LISTING_RULE_CONVERSION_ACTOR_TYPES)[number];
export type ListingRuleConversionValues = z.infer<typeof listingRuleConversionValuesSchema>;
export type ListingRuleConversionRecord = z.infer<typeof listingRuleConversionRecordSchema>;
export type PricingRuleRef = z.infer<typeof pricingRuleRefSchema>;
export type SizeRef = z.infer<typeof sizeRefSchema>;
export type ConversionSizeView = z.infer<typeof conversionSizeViewSchema>;
export type ConversionChangeRow = z.infer<typeof conversionChangeRowSchema>;
export type ConversionReport = z.infer<typeof conversionReportSchema>;
export type ConversionKept = z.infer<typeof conversionKeptSchema>;
/** One report list's items (uncapped while the planner builds it; the view caps it). */
export type ConversionReportItem<K extends keyof ConversionReport> = ConversionReport[K]["items"][number];
