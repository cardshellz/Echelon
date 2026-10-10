import { z } from "zod";
import { pricingRecipeSchema } from "./pricing-rules";
import { ebayCategorySchema } from "./ebay-category-rules";
import { descriptionTemplateSchema, descriptionTextSchema } from "./listing-content";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";

/**
 * Product and category listing settings (design record
 * DROPSHIP-LISTING-SETTINGS-REDESIGN.md, sections 4 and 8.2, migrations 0736
 * and 0737): the values a vendor sets once for a product, or for a Card Shellz
 * category, and every size follows. Precedence is size (exact price only),
 * then product, then category, then the store default.
 *
 * Each setting is one nullable value, so "all or none" holds by construction:
 * `null` follows the default. The SQL CHECKs refuse the same partial shapes.
 */

const id = z.number().int().positive().max(2_147_483_647);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** Every new listing-settings key column has this CHECK; client keys are `<prefix>:<uuid>`, always at least 8 characters. */
export const LISTING_SETTING_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,200}$/;
export const listingSettingRequestKeySchema = z.string().regex(LISTING_SETTING_KEY_PATTERN);
/** A bulk change covers at most as many products as a named catalog group (10,000). */
export const MAX_LISTING_SETTING_BULK_PRODUCTS = MAX_NAMED_CATALOG_GROUP_ITEMS;
/** eBay takes a first and a second store shelf. Mirrors MAX_EBAY_STORE_SHELVES (server domain/ebay-listing-setup-config.ts); a test pins them equal. */
export const MAX_LISTING_STORE_SHELVES = 2;
/** = the varchar(100) policy id columns and today's store-default policy id bound. */
export const MAX_LISTING_POLICY_ID_LENGTH = 100;
/** = the varchar(200) policy name columns. */
export const MAX_LISTING_POLICY_NAME_LENGTH = 200;
/** Today's shelf id bound (dropship-ebay-store-category-dtos.ts). */
export const MAX_LISTING_SHELF_ID_LENGTH = 40;
/** Writer bound on a shelf's path name. HYPOTHESIS that it covers eBay's longest path; eBay's limit was not checked. */
export const MAX_LISTING_SHELF_NAME_LENGTH = 500;
/** The request ledger's operations (= its CHECK). W7's price apply is PR 9. */
export const LISTING_SETTING_REQUEST_OPERATIONS = [
  "product_settings_bulk", "category_settings_clear", "category_moves_acknowledge",
] as const;
export type ListingSettingRequestOperation = (typeof LISTING_SETTING_REQUEST_OPERATIONS)[number];
/** Who wrote a revision or ledger row (= the actor CHECKs). */
export const LISTING_SETTING_ACTOR_TYPES = ["vendor", "admin", "system"] as const;
export type ListingSettingActorType = (typeof LISTING_SETTING_ACTOR_TYPES)[number];
/** A shelf or a template part is explicitly nothing (`none`) or the vendor's own (`own`) (= the mode CHECKs). */
export const LISTING_SETTING_VALUE_MODES = ["none", "own"] as const;

/*
 * STORED CONTRACT (plan D27). Readers parse stored rows with these schemas, so
 * their bounds are the DB CHECK bounds plus the writer's own bounds at save.
 * They may be widened, never tightened: a stored row that no longer parses
 * stops every read for its store. A tighter business limit belongs on a PR 9+
 * route input schema.
 */

/** A policy as eBay listed it at save. The name is display-only and never hashed; null when not known (PR 11 converts per-size rows that store none). */
export const listingSettingPolicySchema = z.object({
  id: z.string().trim().min(1).max(MAX_LISTING_POLICY_ID_LENGTH),
  name: z.string().trim().min(1).max(MAX_LISTING_POLICY_NAME_LENGTH).nullable(),
}).strict();

/** `none`: explicitly no shelf. `own`: one or two shelves, first then second, each with the path name eBay is sent. */
export const listingSettingStoreShelfSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({
    mode: z.literal("own"),
    shelves: z.array(z.object({
      id: z.string().trim().min(1).max(MAX_LISTING_SHELF_ID_LENGTH),
      name: z.string().trim().min(1).max(MAX_LISTING_SHELF_NAME_LENGTH),
    }).strict()).min(1).max(MAX_LISTING_STORE_SHELVES)
      .refine((shelves) => new Set(shelves.map((shelf) => shelf.id)).size === shelves.length, "Pick two different shelves."),
  }).strict(),
]);

/** Same normalization and 4,000 limit as the store template's parts, but own text may not be empty: empty is `none`. */
const ownTemplateText = descriptionTemplateSchema.shape.introduction
  .refine((value) => value.length > 0, "Enter the text, or choose None.");
/** Text above or below the main text. Each part is its own setting (plan D8). */
export const listingSettingTemplateTextSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("own"), text: ownTemplateText }).strict(),
]);

/** The product's own main text, with the product-level catalog hash it was written against (PR 8b, plan D17). */
export const listingSettingMainTextSchema = z.object({
  text: descriptionTextSchema,
  catalogHash: sha256Hex,
}).strict();

/** One product's stored values. null = follow the default (the category's setting, else the store default). */
export const productListingSettingValuesSchema = z.object({
  price: pricingRecipeSchema.nullable(),
  /** The final (leaf) category is checked against eBay at save (PR 9), not by this schema. */
  ebayCategory: ebayCategorySchema.nullable(),
  storeShelf: listingSettingStoreShelfSchema.nullable(),
  /** eBay's fulfillment policy. */
  shippingPolicy: listingSettingPolicySchema.nullable(),
  returnPolicy: listingSettingPolicySchema.nullable(),
  paymentPolicy: listingSettingPolicySchema.nullable(),
  textAbove: listingSettingTemplateTextSchema.nullable(),
  textBelow: listingSettingTemplateTextSchema.nullable(),
  /** Product only. null = the Card Shellz text. */
  mainText: listingSettingMainTextSchema.nullable(),
}).strict();
/** A category sets everything a product can except the main text (R:§5.1); exact prices stay per size. */
export const categoryListingSettingValuesSchema = productListingSettingValuesSchema.omit({ mainText: true }).strict();

export type ProductListingSettingValues = z.infer<typeof productListingSettingValuesSchema>;
export type CategoryListingSettingValues = z.infer<typeof categoryListingSettingValuesSchema>;
export type ProductListingSettingField = keyof ProductListingSettingValues;
export type CategoryListingSettingField = keyof CategoryListingSettingValues;

/** The settings in shape order; audit rows and changed-field lists use this order. A test pins it to the shape. */
export const PRODUCT_LISTING_SETTING_FIELDS = [
  "price", "ebayCategory", "storeShelf", "shippingPolicy", "returnPolicy", "paymentPolicy", "textAbove", "textBelow", "mainText",
] as const satisfies readonly ProductListingSettingField[];
export const CATEGORY_LISTING_SETTING_FIELDS = [
  "price", "ebayCategory", "storeShelf", "shippingPolicy", "returnPolicy", "paymentPolicy", "textAbove", "textBelow",
] as const satisfies readonly CategoryListingSettingField[];

/** A key present with the value undefined cannot come from JSON; it counts as absent here, in the bulk check and in applyListingSettingPatch. */
const changesSomething = (patch: Record<string, unknown>) => Object.values(patch).some((value) => value !== undefined);
/** Absent = leave, null = use the default, value = set (W6's Leave / Use default / Set, R:§8.5). At least one change. */
export const productListingSettingPatchSchema = productListingSettingValuesSchema.partial().strict()
  .refine(changesSomething, "Change at least one setting.");
export const categoryListingSettingPatchSchema = categoryListingSettingValuesSchema.partial().strict()
  .refine(changesSomething, "Change at least one setting.");
/**
 * Many products at once (W6, and W12's "Also clear theirs", plan D28): never a
 * price, not even null (a price change for many products goes through the
 * price check, W7, PR 9), and the main text only as a reset (null): one patch
 * cannot carry each product's own catalog hash.
 */
export const productListingSettingBulkPatchSchema = productListingSettingPatchSchema.superRefine((patch, ctx) => {
  if (patch.price !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["price"], message: "Change prices for many products with a price check." });
  }
  if (patch.mainText != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mainText"], message: "Main text can only be reset for many products." });
  }
});
export type ProductListingSettingPatch = z.infer<typeof productListingSettingPatchSchema>;
export type CategoryListingSettingPatch = z.infer<typeof categoryListingSettingPatchSchema>;
export type ProductListingSettingBulkPatch = z.infer<typeof productListingSettingBulkPatchSchema>;

/**
 * "Got it" for products Card Shellz moved to another category (W13): each
 * product once with the category the vendor was shown (null = none), 1 to
 * 10,000 items. Duplicates would make the acknowledge upsert touch one row
 * twice, which PostgreSQL refuses (21000).
 */
export const categoryMovesAcknowledgeItemsSchema = z.array(z.object({
  productId: id,
  shownCategoryId: id.nullable(),
}).strict()).min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS)
  .refine((items) => new Set(items.map((item) => item.productId)).size === items.length, "Each product once.");
export type CategoryMovesAcknowledgeItems = z.infer<typeof categoryMovesAcknowledgeItemsSchema>;

/** A product's current settings, as the repository returns them. `updatedAt` is the revision's time; the vendor id stays in the repository. */
export const productListingSettingRowSchema = z.object({
  storeConnectionId: id, productId: id, revisionId: id, updatedAt: z.string().datetime(),
  values: productListingSettingValuesSchema,
}).strict();
/** A category's current settings, keyed by catalog.product_categories.id. The name shown is always the live one (plan D19). */
export const categoryListingSettingRowSchema = z.object({
  storeConnectionId: id, categoryId: id, revisionId: id, updatedAt: z.string().datetime(),
  values: categoryListingSettingValuesSchema,
}).strict();
/** The Card Shellz category a chosen product was in when the vendor last confirmed it (null = none). */
export const productCategoryMarkSchema = z.object({
  storeConnectionId: id, productId: id, categoryId: id.nullable(), seenAt: z.string().datetime(),
}).strict();
export type ProductListingSettingRow = z.infer<typeof productListingSettingRowSchema>;
export type CategoryListingSettingRow = z.infer<typeof categoryListingSettingRowSchema>;
export type ProductCategoryMark = z.infer<typeof productCategoryMarkSchema>;
export type ListingSettingPolicy = z.infer<typeof listingSettingPolicySchema>;
export type ListingSettingStoreShelf = z.infer<typeof listingSettingStoreShelfSchema>;
export type ListingSettingTemplateText = z.infer<typeof listingSettingTemplateTextSchema>;
export type ListingSettingMainText = z.infer<typeof listingSettingMainTextSchema>;
