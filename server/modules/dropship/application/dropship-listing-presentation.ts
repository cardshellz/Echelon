import {
  dropshipListingEconomicsSchema,
  dropshipListingPresentationSchema,
  isSafeDropshipExternalImageUrl,
  type DropshipListingEconomics,
  type DropshipListingPresentation,
} from "../../../../shared/dropship/listing-presentation";
import type { CatalogVariantImage, CatalogVariantMediaReader } from "../../catalog/catalog-media.reader";
import type { CatalogPublicationPhoto, CatalogVariantPublicationPhotos } from "../../catalog/catalog-publication-images.reader";
import { DropshipError } from "../domain/errors";
import { listingPhotoLeftOutReason } from "../domain/listing-photo-reasons";
import type { DropshipProductCost, DropshipProductCostReader } from "./dropship-product-cost";
import type { DropshipListingCatalogCandidate, DropshipListingPreviewRow } from "./dropship-listing-preview-service";
import type { DropshipMarketplaceListingIntent } from "./dropship-marketplace-listing-provider";
import type { DropshipLogger } from "./dropship-ports";

export interface DropshipPublicationPreview {
  title: string;
  description: string | null;
  imageUrls: string[];
  condition: string | null;
  itemSpecifics: Record<string, string[]>;
}

export interface DropshipListingPresentationDependencies {
  media: CatalogVariantMediaReader;
  productCosts: DropshipProductCostReader;
  resolvePublication(intent: DropshipMarketplaceListingIntent): DropshipPublicationPreview | null;
  logger: DropshipLogger;
}

/** Enrichment is advisory. It never changes intent, eligibility, quantity, prices, or preview hashes. */
export async function enrichDropshipListingRows(input: {
  rows: readonly DropshipListingPreviewRow[];
  candidates: readonly DropshipListingCatalogCandidate[];
  /** Each size's publishable photos, when the preview resolved them. */
  listingPhotos?: ReadonlyMap<number, CatalogVariantPublicationPhotos> | null;
  vendorId: number;
  storeConnectionId: number;
  deps: DropshipListingPresentationDependencies;
}): Promise<DropshipListingPreviewRow[]> {
  const visibleRows = input.rows.filter((row) => row.adminExposureDecision.exposed);
  const [media, productCosts] = await Promise.all([
    input.deps.media.listImages(visibleRows.map((row) => row.productVariantId))
      .catch((error: unknown) => { logFailure(input.deps.logger, "catalog_media_unavailable", error); return null; }),
    input.deps.productCosts.loadProductCosts({
      vendorId: input.vendorId, productVariantIds: visibleRows.map((row) => row.productVariantId),
    }).catch((error: unknown) => { logFailure(input.deps.logger, "product_cost_source_unavailable", error); return null; }),
  ]);
  const candidates = new Map(input.candidates.map((candidate) => [candidate.productVariantId, candidate]));
  return input.rows.map((row) => {
    const candidate = candidates.get(row.productVariantId);
    if (!candidate || !row.adminExposureDecision.exposed) return row;
    let publication: DropshipPublicationPreview | null = null;
    if (row.listingIntent) {
      try { publication = input.deps.resolvePublication(row.listingIntent); }
      catch (error) { logFailure(input.deps.logger, "publication_preview_unavailable", error, row.productVariantId); }
    }
    return {
      ...row,
      presentation: buildDropshipListingPresentation({
        candidate, publication, storeConnectionId: input.storeConnectionId,
        images: media?.get(row.productVariantId) ?? [],
        mediaUnavailable: media === null,
        photos: input.listingPhotos?.get(row.productVariantId) ?? null,
      }),
      economics: buildDropshipListingEconomics(candidate, row.priceCents, productCosts?.get(row.productVariantId) ?? null),
    };
  });
}

export function buildDropshipListingEconomics(
  candidate: Pick<DropshipListingCatalogCandidate, "defaultRetailPriceCents" | "unitsPerVariant" | "catalogUnitsPerVariant">,
  listingPriceCents: number | null,
  productCost: DropshipProductCost | null,
): DropshipListingEconomics {
  const issues: string[] = [];
  const retail = safeCents(candidate.defaultRetailPriceCents);
  const units = presentationUnits(candidate);
  const resolvedCost = productCost?.status === "available" ? safeCents(productCost.unitCostCents) : null;
  if (resolvedCost === null) issues.push(productCost?.issue ?? "product_cost_source_unavailable");
  if (units === null) issues.push("sellable_pack_size_invalid");
  // Fixed plan prices do not require a retail price, and never derive from the vendor's selling price.
  const cost = issues.length === 0 ? resolvedCost : null;
  return dropshipListingEconomicsSchema.parse({
    currency: "USD", basis: "one_sellable_variant", unitsPerVariant: units,
    referenceRetailPriceCents: retail, listingPriceCents: safeCents(listingPriceCents),
    vendorProductCostCents: cost, channelDiscountPercent: null,
    productCostSource: cost === null ? null : productCost?.source ?? null,
    productCostStatus: cost === null ? "unavailable" : "available", issues,
  });
}

export function buildDropshipListingPresentation(input: {
  candidate: DropshipListingCatalogCandidate;
  publication: DropshipPublicationPreview | null;
  storeConnectionId: number;
  images: readonly CatalogVariantImage[];
  mediaUnavailable?: boolean;
  /**
   * The size's publishable photos. They name the asset behind each published
   * URL, which an uploaded photo's public address cannot be matched by.
   */
  photos?: CatalogVariantPublicationPhotos | null;
}): DropshipListingPresentation {
  const { candidate, publication } = input;
  const issues: string[] = [];
  if (!publication) issues.push("publication_preview_unavailable");
  if (input.mediaUnavailable) issues.push("catalog_media_unavailable");
  const images: DropshipListingPresentation["images"] = [];
  const publishedUrls = publication?.imageUrls ?? [];
  // The first photo with a URL owns it, as the catalog media lookup below does.
  const photoByUrl = new Map<string, CatalogPublicationPhoto>();
  for (const photo of input.photos?.photos ?? []) if (!photoByUrl.has(photo.url)) photoByUrl.set(photo.url, photo);
  // Preserve publish order and duplicates. Do not claim un-published catalog media is included.
  for (const url of publishedUrls) {
    const photo = photoByUrl.get(url);
    const asset = photo
      ? input.images.find((image) => image.assetId === photo.assetId)
      : input.images.find((image) => image.url === url);
    const safe = isSafeDropshipExternalImageUrl(url);
    images.push({
      assetId: photo?.assetId ?? asset?.assetId ?? null, url: safe ? url : null, altText: asset?.altText ?? null,
      source: photo?.uploaded ? "catalog_file" : "external_url", publicationStatus: safe ? "included" : "unavailable",
      reason: safe ? null : "unsafe_image_url",
    });
  }
  const includedAssetIds = new Set(images.flatMap((image) =>
    image.publicationStatus === "included" && image.assetId !== null ? [image.assetId] : []));
  const leftOutCodes = new Map((input.photos?.issues ?? []).map((issue) => [issue.assetId, issue.code]));
  for (const asset of input.images) {
    if (includedAssetIds.has(asset.assetId)) continue;
    if (asset.url && publishedUrls.includes(asset.url) && isSafeDropshipExternalImageUrl(asset.url)) continue;
    if (asset.url && isSafeDropshipExternalImageUrl(asset.url)) {
      images.push({ assetId: asset.assetId, url: asset.url, altText: asset.altText,
        source: "external_url", publicationStatus: "not_included", reason: "not_in_publication_payload" });
    } else if (asset.hasFile && (asset.storageType === "file" || asset.storageType === "both")) {
      images.push({
        assetId: asset.assetId,
        url: `/api/dropship/listings/stores/${input.storeConnectionId}/variants/${candidate.productVariantId}/assets/${asset.assetId}/file`,
        altText: asset.altText, source: "catalog_file", publicationStatus: "not_included",
        reason: uploadedPhotoLeftOutReason(input.photos ?? null, leftOutCodes.get(asset.assetId)),
      });
    } else {
      images.push({ assetId: asset.assetId, url: null, altText: asset.altText,
        source: "external_url", publicationStatus: "unavailable", reason: "image_unavailable_or_unsafe" });
    }
  }
  if (images.length === 0) issues.push("images_unavailable");
  const description = publication?.description ?? candidate.description;
  return dropshipListingPresentationSchema.parse({
    source: publication ? "resolved_listing" : "catalog_fallback",
    title: publication?.title ?? (candidate.title?.trim() || candidate.productName),
    descriptionText: description === null ? null : descriptionAsPlainText(description),
    productName: candidate.productName, variantName: candidate.variantName,
    unitsPerVariant: presentationUnits(candidate), brand: candidate.brand,
    condition: publication?.condition ?? candidate.condition,
    itemSpecifics: Object.entries(publication?.itemSpecifics ?? {}).map(([name, values]) => ({ name, values })),
    images, issues,
  });
}

/**
 * Why an uploaded photo is not in the listing: the catalog could not publish
 * it, or it comes after the photos the listing carries. Without resolved
 * photos the preview publishes URL photos only, so the file stays a catalog image.
 */
function uploadedPhotoLeftOutReason(photos: CatalogVariantPublicationPhotos | null, catalogIssueCode: string | undefined): string {
  if (!photos) return "authenticated_catalog_image_only";
  return catalogIssueCode === undefined ? "not_in_publication_payload" : listingPhotoLeftOutReason(catalogIssueCode);
}

/** Plain-text extraction, not an HTML sanitizer. The DTO deliberately has no renderable HTML field. */
export function descriptionAsPlainText(value: string): string {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, name: string) => ({
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    }[name.toLowerCase()] ?? ""))
    .replace(/\n{3,}/g, "\n\n").trim();
}

function safeCents(value: number | null): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function presentationUnits(candidate: Pick<DropshipListingCatalogCandidate, "unitsPerVariant" | "catalogUnitsPerVariant">): number | null {
  const value = candidate.catalogUnitsPerVariant === undefined ? candidate.unitsPerVariant : candidate.catalogUnitsPerVariant;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function logFailure(logger: DropshipLogger, reason: string, error: unknown, productVariantId?: number): void {
  logger.warn({ code: "DROPSHIP_LISTING_PRESENTATION_UNAVAILABLE",
    message: "Advisory listing presentation data could not be resolved.",
    context: { reason, productVariantId, errorCode: error instanceof DropshipError ? error.code : "UNEXPECTED_ERROR" } });
}
