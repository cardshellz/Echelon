import { z } from "zod";
import {
  listingIssueSchema,
  listingProviderFieldsSchema,
  publicationMoneySchema,
} from "./channel-listing-publication";

export const listingUpdateSkuSchema = z.string().trim().min(1).max(50);
export const listingUpdateChangesSchema = z
  .object({
    priceCents: publicationMoneySchema.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().min(1).max(30_000).optional(),
    brand: z.string().trim().min(1).max(200).optional(),
    images: z
      .array(
        z
          .string()
          .url()
          .max(2_000)
          .refine(
            (value) => /^https:\/\//i.test(value),
            "Use a public HTTPS image URL",
          ),
      )
      .min(1)
      .max(20)
      .optional(),
    attributes: z
      .object({
        Orderable: listingProviderFieldsSchema.optional(),
        Visible: listingProviderFieldsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ListingUpdateChanges = z.infer<typeof listingUpdateChangesSchema>;

export const listingUpdateObservationSchema = z
  .object({
    sku: listingUpdateSkuSchema,
    externalProductId: z.string().min(1).max(100),
    identifier: z
      .object({
        type: z.enum(["GTIN", "UPC", "EAN", "ISBN"]),
        value: z.string().min(1).max(32),
      })
      .strict(),
    title: z.string().max(1_000),
    productType: z.string().max(200),
    priceCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    lifecycleStatus: z.string().min(1).max(100),
    publishedStatus: z.string().min(1).max(100),
  })
  .strict();
export type ListingUpdateObservation = z.infer<
  typeof listingUpdateObservationSchema
>;
export const reviewListingUpdateSchema = z
  .object({
    sku: listingUpdateSkuSchema,
    sourceHash: z.string().length(64),
    productType: z.string().trim().min(1).max(200),
    changes: listingUpdateChangesSchema,
  })
  .strict();
export type ReviewListingUpdate = z.infer<typeof reviewListingUpdateSchema>;
export const submitListingUpdateSchema = z
  .object({
    reviewHash: z.string().length(64),
    commandKey: z.string().uuid(),
  })
  .strict();
export const listingUpdateStateSchema = z.enum([
  "reviewed",
  "queued",
  "sending",
  "processing",
  "accepted",
  "needs_attention",
  "uncertain",
]);
export type ListingUpdateState = z.infer<typeof listingUpdateStateSchema>;
export const listingUpdateViewSchema = z.object({
  id: z.string().uuid(),
  sku: listingUpdateSkuSchema,
  title: z.string(),
  state: listingUpdateStateSchema,
  reviewHash: z.string().length(64),
  productType: z.string(),
  changes: listingUpdateChangesSchema,
  issues: z.array(listingIssueSchema),
  submissionId: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
});
export type ListingUpdateView = z.infer<typeof listingUpdateViewSchema>;
export const listingUpdateContextSchema = z.object({
  current: listingUpdateObservationSchema,
  sourceHash: z.string().length(64),
  suggestedProductType: z.string(),
  // Provider readback supplies current title/price/type. Other values are explicitly
  // labeled last submitted, never represented as a current storefront readback.
  lastSubmitted: listingUpdateChangesSchema.nullable(),
  updates: z.array(listingUpdateViewSchema).max(50),
});
export type ListingUpdateContext = z.infer<typeof listingUpdateContextSchema>;
