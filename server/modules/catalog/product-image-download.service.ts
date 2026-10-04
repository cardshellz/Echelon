import { ProductAssetError } from "./product-asset-errors";

export const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
export const PRODUCT_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
};
export interface DownloadableProductImage { data: Buffer; mimeType: string }
export interface ProductImageDownloadSource {
  sku: string | null;
  url: string | null;
  data: Buffer | null;
  mimeType: string | null;
  fileBytes: number | null;
}
export interface ProductImageDownloadDependencies {
  read: (assetId: number) => Promise<ProductImageDownloadSource | null>;
  fetchImage: (url: string) => Promise<DownloadableProductImage>;
}

/** Reject mislabeled remote documents; only the upload formats may be downloaded here. */
export function validateProductImage(image: DownloadableProductImage): DownloadableProductImage {
  const { data, mimeType } = image;
  if (data.length > MAX_PRODUCT_IMAGE_BYTES) throw new ProductAssetError("IMAGE_TOO_LARGE", "The image exceeds the 10 MB download limit.", 413);
  const isImage = (mimeType === "image/jpeg" && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    || (mimeType === "image/png" && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (mimeType === "image/gif" && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii")))
    || (mimeType === "image/webp" && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP");
  if (!isImage) throw new ProductAssetError("IMAGE_FORMAT_UNSUPPORTED", "The source did not return a JPEG, PNG, WebP or GIF image.", 422);
  return image;
}

export async function downloadProductImage(assetId: number, dependencies: ProductImageDownloadDependencies): Promise<DownloadableProductImage & { filename: string }> {
  const source = await dependencies.read(assetId);
  if (!source) throw new ProductAssetError("IMAGE_NOT_FOUND", "Image not found.", 404);
  if ((source.fileBytes ?? 0) > MAX_PRODUCT_IMAGE_BYTES) throw new ProductAssetError("IMAGE_TOO_LARGE", "The image exceeds the 10 MB download limit.", 413);
  let image: DownloadableProductImage;
  if (source.data) image = { data: source.data, mimeType: source.mimeType ?? "" };
  else if (source.url) image = await dependencies.fetchImage(source.url);
  else throw new ProductAssetError("IMAGE_NOT_FOUND", "This image has no downloadable file or URL.", 404);
  validateProductImage(image);
  const safeSku = (source.sku ?? "product").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "product";
  return { ...image, filename: `${safeSku}-image-${assetId}.${PRODUCT_IMAGE_EXTENSIONS[image.mimeType]}` };
}
