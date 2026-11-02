import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import { ProductAssetError } from "./product-asset-errors";
import { fetchProductImage } from "./product-image-download.transport";
import {
  validateProductImage,
  type DownloadableProductImage,
} from "./product-image-download.service";

export interface CatalogImageInspection {
  readonly width: number;
  readonly height: number;
  readonly contentHash: string;
  readonly bytes: number;
  readonly mimeType: string;
}

/** Catalog measures source bytes. Channel adapters supply publication requirements. */
export function inspectCatalogImage(
  image: DownloadableProductImage,
): CatalogImageInspection {
  validateProductImage(image);
  try {
    const dimensions = imageSize(image.data);
    if (
      !Number.isSafeInteger(dimensions.width) ||
      !Number.isSafeInteger(dimensions.height) ||
      dimensions.width <= 0 ||
      dimensions.height <= 0
    )
      throw new Error("Invalid raster dimensions");
    return {
      width: dimensions.width,
      height: dimensions.height,
      contentHash: createHash("sha256").update(image.data).digest("hex"),
      bytes: image.data.byteLength,
      mimeType: image.mimeType,
    };
  } catch {
    throw new ProductAssetError(
      "CATALOG_IMAGE_DIMENSIONS_INVALID",
      "The photo's pixel dimensions could not be read. Replace it with a valid original image.",
      422,
    );
  }
}

export interface CatalogImageInspector {
  inspect(
    urls: readonly string[],
  ): Promise<ReadonlyMap<string, CatalogImageInspection>>;
}

/** The same rule evaluation serves every channel; each adapter declares its
 * actual minimum rather than applying one marketplace's restrictions globally. */
export async function assertCatalogPublicationPhotoRequirements(
  inspector: CatalogImageInspector,
  urls: readonly string[],
  requirements: { readonly minimumLongestSide: number },
): Promise<void> {
  if (
    !Number.isSafeInteger(requirements.minimumLongestSide) ||
    requirements.minimumLongestSide <= 0
  )
    throw new Error("Invalid channel photo requirement");
  const sources = [...new Set(urls)];
  const measured = await inspector.inspect(sources);
  for (const [index, url] of sources.entries()) {
    const photo = measured.get(url);
    if (!photo)
      throw new ProductAssetError(
        "CATALOG_IMAGE_INSPECTION_MISSING",
        "A selected photo could not be inspected. Retry the source check.",
        502,
      );
    if (Math.max(photo.width, photo.height) < requirements.minimumLongestSide)
      throw new ProductAssetError(
        "CATALOG_IMAGE_RESOLUTION_TOO_SMALL",
        `Photo ${index + 1} is ${photo.width} × ${photo.height} pixels. This channel requires at least ${requirements.minimumLongestSide} pixels on the longest side. Replace it with the original image.`,
        422,
      );
  }
}

/** No database connection is held during downloads. A call deduplicates the
 * complete gallery and limits in-flight files to two Catalog-sized downloads. */
export function createCatalogImageInspector(
  read: (url: string) => Promise<DownloadableProductImage> = fetchProductImage,
): CatalogImageInspector {
  return {
    async inspect(urls) {
      const pending = [...new Set(urls)];
      const result = new Map<string, CatalogImageInspection>();
      let next = 0;
      let failed = false;
      const worker = async (): Promise<void> => {
        while (!failed && next < pending.length) {
          const url = pending[next++];
          try {
            result.set(url, inspectCatalogImage(await read(url)));
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      };
      // Await both workers even after a source fails; no orphaned network work
      // survives the command's error or keeps an unbounded set of buffers alive.
      const outcomes = await Promise.allSettled([worker(), worker()]);
      for (const outcome of outcomes)
        if (outcome.status === "rejected") throw outcome.reason;
      return result;
    },
  };
}
