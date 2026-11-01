import sharp from "sharp";
import { inspectCatalogImage } from "./catalog-image-inspection";
import { ProductAssetError } from "./product-asset-errors";
import type { DownloadableProductImage } from "./product-image-download.service";

/** Version the recipe: a saved rendition is content-addressed and never regenerated in place. */
export const MINIMUM_500_RENDITION = "minimum-500-v1" as const;
const MINIMUM_LONGEST_SIDE = 500;
const MAX_RENDITION_PIXELS = 4_000_000;
const MAX_ACTIVE_RENDITIONS = 2;
const MAX_WAITING_RENDITIONS = 8;
let activeRenditions = 0;
const waitingRenditions: Array<() => void> = [];

async function acquireRenditionSlot(): Promise<() => void> {
  if (activeRenditions >= MAX_ACTIVE_RENDITIONS) {
    if (waitingRenditions.length >= MAX_WAITING_RENDITIONS)
      throw new ProductAssetError(
        "CATALOG_IMAGE_RENDITION_BUSY",
        "Photo processing is busy. Retry this image shortly.",
        503,
      );
    await new Promise<void>((resolve) => waitingRenditions.push(resolve));
  } else activeRenditions++;
  return () => {
    const next = waitingRenditions.shift();
    if (next) next();
    else activeRenditions--;
  };
}

export function catalogRenditionProfile(
  minimumLongestSide: number | undefined,
): typeof MINIMUM_500_RENDITION | null {
  if (minimumLongestSide === undefined) return null;
  if (!Number.isSafeInteger(minimumLongestSide) || minimumLongestSide <= 0)
    throw new ProductAssetError(
      "CATALOG_IMAGE_READ_INVALID",
      "The requested photo size is invalid.",
      500,
    );
  return minimumLongestSide <= MINIMUM_LONGEST_SIDE
    ? MINIMUM_500_RENDITION
    : null;
}

export interface CatalogPublicationRendition {
  sourceHash: string;
  sourceLongestSide: number;
  profile: typeof MINIMUM_500_RENDITION;
  image: DownloadableProductImage;
  contentHash: string;
}
export interface CatalogRenditionWarning {
  code: string;
  message: string;
}

/** A channel-specific derivative must never prevent Catalog from saving a valid original. */
export async function prepareOptionalCatalogRendition(
  image: DownloadableProductImage,
): Promise<{
  rendition: CatalogPublicationRendition | null;
  warning?: CatalogRenditionWarning;
}> {
  try {
    return { rendition: await prepareCatalogPublicationRendition(image) };
  } catch (error) {
    if (!(error instanceof ProductAssetError)
      || !["CATALOG_IMAGE_RENDITION_FAILED", "CATALOG_IMAGE_RENDITION_BUSY"].includes(error.code)) throw error;
    return {
      rendition: null,
      warning: { code: error.code, message: error.message },
    };
  }
}

/** Only enlarge a copy when needed. Original bytes and aspect ratio are retained.
 * The output bytes, not the recipe, are the identity persisted and published. */
export async function prepareCatalogPublicationRendition(
  image: DownloadableProductImage,
): Promise<CatalogPublicationRendition | null> {
  const source = inspectCatalogImage(image);
  if (Math.max(source.width, source.height) >= MINIMUM_LONGEST_SIDE) return null;
  const release = await acquireRenditionSlot();
  try {
    const input = sharp(image.data, {
      animated: true,
      failOn: "warning",
      limitInputPixels: MAX_RENDITION_PIXELS,
      limitInputChannels: 5,
    });
    const before = await input.metadata();
    if ((before.pages ?? 1) * MINIMUM_LONGEST_SIDE * MINIMUM_LONGEST_SIDE > MAX_RENDITION_PIXELS)
      throw new Error("Animation exceeds the bounded publication rendition size");
    const data = await input
      .resize({
        width: MINIMUM_LONGEST_SIDE,
        height: MINIMUM_LONGEST_SIDE,
        fit: "inside",
        kernel: "lanczos3",
      })
      .keepMetadata()
      .toBuffer();
    const copy = { data, mimeType: image.mimeType };
    const measured = inspectCatalogImage(copy);
    const after = await sharp(data, {
      animated: true,
      limitInputPixels: MAX_RENDITION_PIXELS,
    }).metadata();
    if (Math.max(measured.width, measured.height) < MINIMUM_LONGEST_SIDE
      || (before.pages ?? 1) !== (after.pages ?? 1)
      || (before.loop ?? 0) !== (after.loop ?? 0)
      || JSON.stringify(before.delay ?? []) !== JSON.stringify(after.delay ?? [])) {
      throw new Error("Rendition did not retain image dimensions or animation");
    }
    return {
      sourceHash: source.contentHash,
      sourceLongestSide: Math.max(source.width, source.height),
      profile: MINIMUM_500_RENDITION,
      image: copy,
      contentHash: measured.contentHash,
    };
  } catch (cause) {
    throw new ProductAssetError(
      "CATALOG_IMAGE_RENDITION_FAILED",
      "A larger copy could not be prepared safely. Some sales channels may require a larger photo.",
      422,
      { cause },
    );
  } finally {
    release();
  }
}
