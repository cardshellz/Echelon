import { z } from "zod";

export const publicationIdSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);
export const publicationMoneySchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const listingPriceRuleSchema = z
  .object({
    type: z.enum(["percentage", "fixed", "override"]),
    value: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/),
  })
  .strict();
export type ListingPriceRule = z.infer<typeof listingPriceRuleSchema>;

// Provider fields are bounded JSON data. They never select HTTP paths or carry credentials.
export const listingProviderFieldsSchema = z
  .record(z.unknown())
  .superRefine((value, context) => {
    const pending: Array<{ value: unknown; depth: number }> = [
      { value, depth: 0 },
    ];
    const seen = new Set<object>();
    let nodes = 0;
    while (pending.length) {
      const next = pending.pop()!;
      if (++nodes > 5_000 || next.depth > 15) return reject();
      if (next.value === null || typeof next.value === "boolean") continue;
      if (typeof next.value === "string") {
        if (next.value.length > 30_000) return reject();
        continue;
      }
      if (typeof next.value === "number") {
        if (!Number.isFinite(next.value)) return reject();
        continue;
      }
      if (typeof next.value !== "object" || seen.has(next.value))
        return reject();
      seen.add(next.value);
      if (Array.isArray(next.value)) {
        if (next.value.length > 100) return reject();
        for (const child of next.value)
          pending.push({ value: child, depth: next.depth + 1 });
      } else {
        if (
          Object.getPrototypeOf(next.value) !== Object.prototype &&
          Object.getPrototypeOf(next.value) !== null
        )
          return reject();
        for (const [key, child] of Object.entries(next.value)) {
          if (
            ["__proto__", "prototype", "constructor"].includes(key) ||
            key.length > 200
          )
            return reject();
          pending.push({ value: child, depth: next.depth + 1 });
        }
      }
    }
    if (JSON.stringify(value).length > 100_000) reject();
    function reject() {
      context.addIssue({
        code: "custom",
        message:
          "Listing attributes must be bounded JSON data without reserved keys",
      });
    }
  });
export const listingDraftItemSchema = z
  .object({
    variantId: publicationIdSchema,
    method: z.enum(["create", "match"]).default("create"),
    productType: z.string().trim().max(200).default(""),
    identifier: z
      .object({
        type: z.enum(["GTIN", "UPC", "EAN", "ISBN"]),
        value: z.string().trim().max(32),
      })
      .strict()
      .nullable()
      .default(null),
    title: z.string().trim().max(500).nullable().default(null),
    description: z.string().max(30_000).nullable().default(null),
    brand: z.string().trim().max(200).nullable().default(null),
    images: z
      .array(z.string().url().max(2_000))
      .max(20)
      .nullable()
      .default(null),
    priceOverrideCents: publicationMoneySchema.nullable().default(null),
    attributes: listingProviderFieldsSchema.default({}),
  })
  .strict();
export type ListingDraftItem = z.infer<typeof listingDraftItemSchema>;
export const reviewListingDraftSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    // Omission preserves the existing all-draft request contract.
    variantIds: z.array(publicationIdSchema).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.variantIds &&
      new Set(value.variantIds).size !== value.variantIds.length
    )
      context.addIssue({
        code: "custom",
        path: ["variantIds"],
        message: "Select each variant once",
      });
  });
export type ReviewListingDraft = z.infer<typeof reviewListingDraftSchema>;
export const saveListingDraftSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    items: z.array(listingDraftItemSchema).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.items.map((item) => item.variantId)).size !==
      value.items.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Select each variant once",
      });
    }
  });
export const listingCatalogQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  variantIds: z
    .string()
    .regex(/^\d+(,\d+){0,99}$/)
    .optional(),
});
export const listingIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().nullable().default(null),
});
export type ListingIssue = z.infer<typeof listingIssueSchema>;
export const listingCatalogItemSchema = z.object({
  variantId: publicationIdSchema,
  productId: publicationIdSchema,
  sku: z.string().max(100),
  name: z.string(),
  variantName: z.string(),
  unitLabel: z.string(),
  productType: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  brand: z.string().nullable(),
  images: z.array(z.string()),
  // Optional for persisted reviews and older clients. Issues block inherited-image publication, not catalog reads.
  imageIssues: z.array(listingIssueSchema).optional(),
  identifier: listingDraftItemSchema.shape.identifier,
  priceCents: z.number().int().nonnegative().nullable(),
  basePriceCents: z.number().int().nonnegative().nullable(),
  priceSource: z.string().nullable(),
  appliedRule: listingPriceRuleSchema.nullable(),
  appliedRuleScope: z
    .enum(["channel", "category", "product", "variant"])
    .nullable(),
  eligible: z.boolean(),
  alreadyLinked: z.boolean(),
  sourceHash: z.string().length(64),
});
export type ListingCatalogItem = z.infer<typeof listingCatalogItemSchema>;
export const listingAccountSchema = z.object({
  channelId: publicationIdSchema,
  connectionId: publicationIdSchema,
  provider: z.string().min(1),
  market: z.string().min(1),
  environment: z.enum(["production", "sandbox"]),
  accountId: z.string().min(1),
  scopeId: z.string().min(1),
  revision: z.number().int().positive(),
});
export type ListingAccount = z.infer<typeof listingAccountSchema>;
export const LISTING_TAXONOMY_LIMITS = {
  productTypes: 20_000,
  entries: 20_000,
  pathDepth: 8,
  nameLength: 200,
  descriptionLength: 10_000,
} as const;
const listingTaxonomyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LISTING_TAXONOMY_LIMITS.nameLength);
export const listingTaxonomyEntrySchema = z.object({
  productType: listingTaxonomyNameSchema,
  // Provider ancestors only; the selected product type is the separate leaf.
  path: z
    .array(listingTaxonomyNameSchema)
    .max(LISTING_TAXONOMY_LIMITS.pathDepth),
  description: z
    .string()
    .trim()
    .max(LISTING_TAXONOMY_LIMITS.descriptionLength)
    .nullable()
    .optional()
    .transform((value) => value || null),
});
export type ListingTaxonomyEntry = z.infer<typeof listingTaxonomyEntrySchema>;
export const listingTaxonomySchema = z
  .object({
    // Retained for older clients; a response without entries remains a valid flat taxonomy.
    productTypes: z
      .array(listingTaxonomyNameSchema)
      .max(LISTING_TAXONOMY_LIMITS.productTypes),
    entries: z
      .array(listingTaxonomyEntrySchema)
      .max(LISTING_TAXONOMY_LIMITS.entries)
      .default([]),
  })
  .superRefine((value, context) => {
    const types = new Set(value.productTypes);
    if (types.size !== value.productTypes.length)
      context.addIssue({
        code: "custom",
        path: ["productTypes"],
        message: "Taxonomy product types must be unique",
      });
    const paths = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      if (!types.has(entry.productType))
        context.addIssue({
          code: "custom",
          path: ["entries", index, "productType"],
          message: "Taxonomy paths must refer to a listed product type",
        });
      const key = JSON.stringify([entry.path, entry.productType]);
      if (paths.has(key))
        context.addIssue({
          code: "custom",
          path: ["entries", index],
          message: "Taxonomy paths must be unique",
        });
      paths.add(key);
    }
  });
export type ListingTaxonomy = z.infer<typeof listingTaxonomySchema>;
export const listingDraftSchema = z.object({
  channelId: publicationIdSchema,
  revision: z.number().int().nonnegative(),
  items: z.array(listingDraftItemSchema),
  updatedAt: z.string().nullable(),
});
export type ListingDraft = z.infer<typeof listingDraftSchema>;
export const listingRequirementsSchema = z.object({
  productType: z.string(),
  method: z.enum(["create", "match"]),
  version: z.string(),
  schemaHash: z.string().length(64),
  schema: z
    .record(z.unknown())
    .refine(
      (value) => JSON.stringify(value).length <= 5_000_000,
      "Provider schema exceeds the size limit",
    ),
});
export type ListingRequirements = z.infer<typeof listingRequirementsSchema>;
export const listingReviewItemSchema = z.object({
  variantId: publicationIdSchema,
  productId: publicationIdSchema,
  sku: z.string(),
  title: z.string(),
  unitLabel: z.string(),
  method: z.enum(["create", "match"]),
  productType: z.string(),
  priceCents: z.number().int().nonnegative().nullable(),
  priceSource: z.string().nullable(),
  issues: z.array(listingIssueSchema),
  schemaVersion: z.string().nullable(),
});
export const listingReviewSchema = z.object({
  id: z.string().uuid(),
  draftRevision: z.number().int().nonnegative(),
  reviewHash: z.string().length(64),
  account: listingAccountSchema,
  items: z.array(listingReviewItemSchema),
  issues: z.array(listingIssueSchema),
  canSubmit: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  inventory: z.object({
    ready: z.boolean(),
    message: z.string(),
    targetId: z.string().nullable(),
    targetRevision: z.string().nullable().default(null),
  }),
});
export type ListingReview = z.infer<typeof listingReviewSchema>;
export const submitListingReviewSchema = z
  .object({
    reviewId: z.string().uuid(),
    reviewHash: z.string().length(64),
    commandKey: z.string().uuid(),
  })
  .strict();
export const listingOperationItemSchema = z.object({
  variantId: publicationIdSchema,
  sku: z.string(),
  priceCents: publicationMoneySchema,
  state: z.enum([
    "queued",
    "processing",
    "accepted",
    "verified",
    "needs_attention",
    "needs_reconciliation",
  ]),
  externalProductId: z.string().nullable(),
  error: z.string().nullable(),
  stockState: z.enum(["waiting_for_item", "setup_required", "ready"]),
  canRetry: z.boolean().default(false),
});
export type ListingOperationItem = z.infer<typeof listingOperationItemSchema>;
export const listingOperationSchema = z.object({
  id: z.string().uuid(),
  channelId: publicationIdSchema,
  state: z.enum([
    "queued",
    "submitting",
    "processing",
    "completed",
    "partially_completed",
    "needs_attention",
    "needs_reconciliation",
  ]),
  submissionId: z.string().nullable(),
  items: z.array(listingOperationItemSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
});
export type ListingOperation = z.infer<typeof listingOperationSchema>;
export const listingWorkspaceSchema = z.object({
  draft: listingDraftSchema,
  operations: z.array(listingOperationSchema),
  pricingRule: listingPriceRuleSchema.nullable(),
});
export const listingCatalogPageSchema = z.object({
  items: z.array(listingCatalogItemSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int(),
  limit: z.number().int(),
});
