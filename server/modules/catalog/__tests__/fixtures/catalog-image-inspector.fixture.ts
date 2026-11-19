import { vi } from "vitest";
import type { CatalogImageInspector } from "../../catalog-image-inspection";

/** Source-selection tests isolate network inspection. Resolution regressions
 * use actual PNG files through createCatalogImageInspector instead. */
export function fixedImageInspector(width = 640, height = 640): CatalogImageInspector {
  return { inspect: vi.fn(async (urls: readonly string[]) => new Map(urls.map(url => [url,
    { width, height, contentHash: "a".repeat(64), bytes: 1000, mimeType: "image/png" }]))), };
}
