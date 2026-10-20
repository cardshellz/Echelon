import { z } from "zod";

const catalogId = z.number().int().positive().max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const catalogPublicationMediaPhotoSchema = z
  .object({
    assetId: catalogId.nullable(),
    /** Exact position of a reviewed URL override that has no Catalog asset identity. */
    sourceIndex: z.number().int().nonnegative().optional(),
    productVariantId: catalogId.nullable(),
    url: z.string().url(),
    position: z.number().int().nonnegative(),
    isPrimary: z.boolean(),
    uploaded: z.boolean(),
    versionHash: digest.nullable(),
  })
  .strict()
  .refine(
    (photo) =>
      photo.uploaded === (photo.versionHash !== null) &&
      (photo.assetId !== null ||
        (!photo.uploaded && photo.sourceIndex !== undefined)),
    {
      message:
        "Uploaded publication photos require an exact immutable content version.",
    },
  );
export type CatalogPublicationMediaPhoto = z.infer<
  typeof catalogPublicationMediaPhotoSchema
>;

export const catalogPublicationMediaOmissionSchema = z
  .object({
    assetId: catalogId.nullable(),
    sourceIndex: z.number().int().nonnegative().optional(),
    reason: z.enum([
      "excluded",
      "duplicate",
      "invalid",
      "unavailable",
      "capacity",
    ]),
    duplicateOfAssetId: catalogId.optional(),
    duplicateOfSourceIndex: z.number().int().nonnegative().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    /** A selected but unusable image must be repaired, never silently replaced with provider media. */
    blocking: z.boolean(),
  })
  .strict();
export type CatalogPublicationMediaOmission = z.infer<
  typeof catalogPublicationMediaOmissionSchema
>;

export const catalogPublicationMediaGallerySchema = z
  .object({
    /** In-scope image assets before exclusions, duplicate removal, validation and capacity. */
    expected: z.number().int().nonnegative(),
    selected: z.array(catalogPublicationMediaPhotoSchema),
    omissions: z.array(catalogPublicationMediaOmissionSchema),
  })
  .strict()
  .refine(
    (gallery) =>
      gallery.expected === gallery.selected.length + gallery.omissions.length,
    {
      message:
        "Every candidate photo must have one explicit selection or omission disposition.",
    },
  );
export type CatalogPublicationMediaGallery = z.infer<
  typeof catalogPublicationMediaGallerySchema
>;

export const catalogPublicationMediaPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Fingerprint of the complete scoped source, overlays and selection limits, including omissions. */
    sourceRevision: digest,
    variants: z.array(
      z
        .object({
          variantId: catalogId,
          gallery: catalogPublicationMediaGallerySchema,
        })
        .strict(),
    ),
    group: catalogPublicationMediaGallerySchema,
  })
  .strict()
  .refine(
    (plan) =>
      new Set(plan.variants.map((variant) => variant.variantId)).size ===
      plan.variants.length,
    {
      message:
        "Each catalog variant must occur once in a publication media plan.",
    },
  );
export type CatalogPublicationMediaPlan = z.infer<
  typeof catalogPublicationMediaPlanSchema
>;
