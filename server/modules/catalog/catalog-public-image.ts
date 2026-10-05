import { isIP } from "node:net";
import { ProductAssetError } from "./product-asset-errors";
import { PRODUCT_IMAGE_EXTENSIONS } from "./product-image-download.service";

export const CATALOG_PUBLIC_IMAGE_ROUTE = "/api/catalog/images/:id/:hash";
export const CATALOG_IMAGE_HASH_PATTERN = /^[a-f0-9]{64}$/;
export type CatalogPublicImageUrl = (assetId: number, contentHash: string, mimeType: string) => string;

/** Resolve configuration once at composition, never from a request's Host header. */
export function createCatalogPublicImageUrl(
  env: Readonly<Record<string, string | undefined>>,
): CatalogPublicImageUrl {
  const configured = [env.CATALOG_PUBLIC_BASE_URL, env.PUBLIC_APP_URL, env.APP_BASE_URL]
    .find(value => value?.trim())?.trim()
    ?? (env.HEROKU_APP_DEFAULT_DOMAIN?.trim() ? `https://${env.HEROKU_APP_DEFAULT_DOMAIN.trim()}` : undefined);
  let origin: string | null = null;
  try {
    const url = new URL(configured ?? "");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol === "https:" && !url.username && !url.password && !url.port
      && url.pathname === "/" && !url.search && !url.hash
      && hostname.includes(".") && !isIP(hostname)
      && !/(?:^|\.)(?:localhost|local|internal|test|invalid)\.?$/i.test(hostname)) {
      origin = url.origin;
    }
  } catch { /* An actionable error is returned only when an uploaded image needs this URL. */ }

  return (assetId, contentHash, mimeType) => {
    const extension = Object.hasOwn(PRODUCT_IMAGE_EXTENSIONS, mimeType) ? PRODUCT_IMAGE_EXTENSIONS[mimeType] : undefined;
    if (!Number.isSafeInteger(assetId) || assetId <= 0 || assetId > 2_147_483_647
      || !CATALOG_IMAGE_HASH_PATTERN.test(contentHash) || !extension) {
      throw new ProductAssetError("CATALOG_IMAGE_INVALID", "The uploaded catalog image has an invalid identity.", 422);
    }
    if (!origin) {
      throw new ProductAssetError(
        "CATALOG_PUBLIC_URL_REQUIRED",
        "An uploaded catalog photo is not available to the marketplace yet. The public image address needs to be configured.",
        503,
      );
    }
    return `${origin}/api/catalog/images/${assetId}/${contentHash}.${extension}`;
  };
}
