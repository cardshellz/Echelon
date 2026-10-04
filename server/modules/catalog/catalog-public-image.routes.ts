import type { Express } from "express";
import { z } from "zod";
import { CATALOG_IMAGE_HASH_PATTERN, CATALOG_PUBLIC_IMAGE_ROUTE } from "./catalog-public-image";
import { PRODUCT_IMAGE_EXTENSIONS, type DownloadableProductImage } from "./product-image-download.service";

const paramsSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)),
  hash: z.string().regex(CATALOG_IMAGE_HASH_PATTERN),
});

export function registerCatalogPublicImageRoutes(
  app: Express,
  read: (assetId: number, contentHash: string) => Promise<DownloadableProductImage | null>,
): void {
  // Intentionally anonymous: only the exact raster file is public, never asset metadata or admin APIs.
  app.get(CATALOG_PUBLIC_IMAGE_ROUTE, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return res.sendStatus(404);
    try {
      const image = await read(params.data.id, params.data.hash);
      if (!image) return res.sendStatus(404);
      res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
      res.setHeader("ETag", `"${params.data.hash}"`);
      res.setHeader("Content-Disposition", `inline; filename="catalog-image-${params.data.id}.${PRODUCT_IMAGE_EXTENSIONS[image.mimeType]}"`);
      return res.type(image.mimeType).send(image.data);
    } catch {
      console.error(JSON.stringify({ event: "catalog.public_image.read_failed", assetId: params.data.id, code: "CATALOG_IMAGE_READ_FAILED" }));
      return res.status(503).json({ code: "CATALOG_IMAGE_READ_FAILED", error: "Image temporarily unavailable." });
    }
  });
}
