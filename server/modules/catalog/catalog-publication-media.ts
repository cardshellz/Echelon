import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  catalogPublicationMediaPlanSchema,
  type CatalogPublicationMediaGallery,
  type CatalogPublicationMediaPhoto,
  type CatalogPublicationMediaPlan,
} from "@shared/types/catalog-publication-media";
import type { CatalogPublicImageUrl } from "./catalog-public-image";
import { ProductAssetError } from "./product-asset-errors";
import {
  resolveCatalogPublicationImage,
  type CatalogPublicationImage,
  type CatalogPublicationPhotoSelection,
} from "./catalog-publication-image";

/** Catalog's sole selection algorithm. Provider capabilities supply limits, never a second selector. */
export function resolveCatalogPublicationMediaPlan(
  byVariant: ReadonlyMap<number, readonly CatalogPublicationImage[]>,
  selection: CatalogPublicationPhotoSelection,
  publicUrl: CatalogPublicImageUrl,
): CatalogPublicationMediaPlan {
  const unique = new Map<number, CatalogPublicationImage>();
  for (const images of byVariant.values())
    for (const image of images) unique.set(image.id, image);
  const ordered = (images: readonly CatalogPublicationImage[]) =>
    [...images].sort(
      (a, b) =>
        (a.publicationPosition ?? a.position) -
          (b.publicationPosition ?? b.position) || a.id - b.id,
    );
  const variants = [...byVariant]
    .sort(([a], [b]) => a - b)
    .map(([variantId, images]) => ({
      variantId,
      gallery: selectGallery(
        ordered(images),
        selection.maxPhotosPerVariant,
        publicUrl,
      ),
    }));
  const group = selectGallery(
    ordered([...unique.values()]),
    selection.maxGroupPhotos ?? selection.maxPhotosPerVariant,
    publicUrl,
  );
  const source = {
    schemaVersion: 1,
    productId: selection.productId ?? null,
    variantIds: [...byVariant.keys()].sort((a, b) => a - b),
    limits: {
      perVariant: selection.maxPhotosPerVariant,
      group: selection.maxGroupPhotos ?? selection.maxPhotosPerVariant,
    },
    assets: ordered([...unique.values()]).map(({ fileHeader, ...image }) => ({
      ...image,
      fileHeader: fileHeader?.toString("hex") ?? null,
    })),
    variants,
    group,
  };
  return catalogPublicationMediaPlanSchema.parse({
    schemaVersion: 1,
    sourceRevision: createHash("sha256")
      .update(canonicalJson(source))
      .digest("hex"),
    variants,
    group,
  });
}

function selectGallery(
  images: readonly CatalogPublicationImage[],
  limit: number,
  publicUrl: CatalogPublicImageUrl,
): CatalogPublicationMediaGallery {
  return selectCandidates(
    images.map((image) => ({
      assetId: image.id,
      included: image.included !== false,
      resolve: () => {
        const url = resolveCatalogPublicationImage(image, publicUrl);
        return url === null
          ? null
          : {
              assetId: image.id,
              productVariantId: image.productVariantId,
              url,
              position: image.publicationPosition ?? image.position,
              isPrimary: image.isPrimary === true,
              uploaded: image.url === null,
              versionHash: image.url === null ? image.fileHash : null,
            };
      },
    })),
    limit,
  );
}

interface MediaCandidate {
  assetId: number | null;
  sourceIndex?: number;
  included: boolean;
  resolve(): CatalogPublicationMediaPhoto | null;
}

/** Explicit reviewed URLs use the same selector without fabricating Catalog asset identities. */
export function resolveExplicitPublicationMediaPlan(input: {
  variantIds: readonly number[];
  urls: readonly string[];
  maxPhotosPerVariant: number;
  maxGroupPhotos?: number;
}): CatalogPublicationMediaPlan {
  const selection = z
    .object({
      variantIds: z
        .array(z.number().int().positive().max(2_147_483_647))
        .max(500),
      urls: z.array(z.string().max(2000)).max(1000),
      maxPhotosPerVariant: z.number().int().positive(),
      maxGroupPhotos: z.number().int().positive().optional(),
    })
    .parse(input);
  const candidates: MediaCandidate[] = selection.urls.map(
    (url, sourceIndex) => ({
      assetId: null,
      sourceIndex,
      included: true,
      resolve: () => ({
        assetId: null,
        sourceIndex,
        productVariantId: null,
        url,
        position: sourceIndex,
        isPrimary: sourceIndex === 0,
        uploaded: false,
        versionHash: null,
      }),
    }),
  );
  const variants = [...new Set(selection.variantIds)]
    .sort((a, b) => a - b)
    .map((variantId) => ({
      variantId,
      gallery: selectCandidates(candidates, selection.maxPhotosPerVariant),
    }));
  const group = selectCandidates(
    candidates,
    selection.maxGroupPhotos ?? selection.maxPhotosPerVariant,
  );
  return catalogPublicationMediaPlanSchema.parse({
    schemaVersion: 1,
    variants,
    group,
    sourceRevision: createHash("sha256")
      .update(
        canonicalJson({
          schemaVersion: 1,
          source: "reviewed_urls",
          selection: {
            ...selection,
            variantIds: variants.map((variant) => variant.variantId),
          },
          variants,
          group,
        }),
      )
      .digest("hex"),
  });
}

/** A protocol may accept fewer photos than its catalog preview; keep the excluded evidence explicit. */
export function limitPublicationMediaPlan(
  input: CatalogPublicationMediaPlan,
  limits: {
    maxPhotosPerVariant: number;
    maxGroupPhotos: number;
  },
): CatalogPublicationMediaPlan {
  const plan = catalogPublicationMediaPlanSchema.parse(input);
  const bound = z
    .object({
      maxPhotosPerVariant: z.number().int().positive(),
      maxGroupPhotos: z.number().int().positive(),
    })
    .parse(limits);
  const restrict = (
    gallery: CatalogPublicationMediaGallery,
    limit: number,
  ): CatalogPublicationMediaGallery => {
    const projected = selectCandidates(
      gallery.selected.map((photo) => ({
        assetId: photo.assetId,
        sourceIndex: photo.sourceIndex,
        included: true,
        resolve: () => photo,
      })),
      limit,
    );
    return {
      expected: gallery.expected,
      selected: projected.selected,
      omissions: [...gallery.omissions, ...projected.omissions],
    };
  };
  const variants = plan.variants.map((variant) => ({
    variantId: variant.variantId,
    gallery: restrict(variant.gallery, bound.maxPhotosPerVariant),
  }));
  const group = restrict(plan.group, bound.maxGroupPhotos);
  return catalogPublicationMediaPlanSchema.parse({
    schemaVersion: 1,
    variants,
    group,
    sourceRevision: createHash("sha256")
      .update(
        canonicalJson({
          sourceRevision: plan.sourceRevision,
          limits: bound,
          variants,
          group,
        }),
      )
      .digest("hex"),
  });
}

function selectCandidates(
  candidates: readonly MediaCandidate[],
  limit: number,
): CatalogPublicationMediaGallery {
  const selected: CatalogPublicationMediaPhoto[] = [];
  const omissions: CatalogPublicationMediaGallery["omissions"] = [];
  const seen = new Map<string, MediaCandidate>();
  for (const candidate of candidates) {
    const identity = {
      assetId: candidate.assetId,
      ...(candidate.sourceIndex === undefined
        ? {}
        : { sourceIndex: candidate.sourceIndex }),
    };
    if (!candidate.included) {
      omissions.push({ ...identity, reason: "excluded", blocking: false });
      continue;
    }
    try {
      const photo = candidate.resolve();
      if (photo === null) {
        omissions.push({
          ...identity,
          reason: "unavailable",
          blocking: false,
          code: "CATALOG_IMAGE_UNAVAILABLE",
          message: `Catalog photo ${candidate.assetId} has no image URL or uploaded file.`,
        });
        continue;
      }
      assertPublicPublicationImageUrl(photo.url);
      const duplicate = seen.get(photo.url);
      if (duplicate !== undefined) {
        omissions.push({
          ...identity,
          reason: "duplicate",
          blocking: false,
          ...(duplicate.assetId === null
            ? { duplicateOfSourceIndex: duplicate.sourceIndex }
            : { duplicateOfAssetId: duplicate.assetId }),
        });
        continue;
      }
      seen.set(photo.url, candidate);
      if (selected.length >= limit) {
        omissions.push({ ...identity, reason: "capacity", blocking: false });
        continue;
      }
      selected.push(photo);
    } catch (error) {
      if (!(error instanceof ProductAssetError)) throw error;
      // A file outside the chosen gallery cannot block the listing, but its omission remains visible.
      if (selected.length >= limit)
        omissions.push({ ...identity, reason: "capacity", blocking: false });
      else
        omissions.push({
          ...identity,
          reason:
            error.code === "CATALOG_IMAGE_UNAVAILABLE" ||
            error.code === "CATALOG_PUBLIC_URL_REQUIRED"
              ? "unavailable"
              : "invalid",
          code: error.code,
          message: error.message,
          blocking: true,
        });
    }
  }
  return { expected: candidates.length, selected, omissions };
}

/** A provider can impose stricter rules, but every outbound photo must be publicly addressable. */
export function assertPublicPublicationImageUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProductAssetError(
      "CATALOG_IMAGE_URL_INVALID",
      "A catalog photo has an invalid public address.",
      422,
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    value.trim() !== value ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hostname.includes(".") ||
    isIP(hostname) ||
    /(?:^|\.)(?:localhost|local|internal)\.?$/i.test(hostname)
  ) {
    throw new ProductAssetError(
      "CATALOG_IMAGE_URL_INVALID",
      "Publication photos require a public HTTPS address.",
      422,
    );
  }
}
