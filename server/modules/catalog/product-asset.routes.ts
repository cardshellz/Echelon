import type { Express, Response } from "express";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { reorderProductAssetsSchema } from "@shared/catalog/product-assets";
import { reorderCatalogAssets } from "./product-asset-order.repository";
import { ProductAssetError } from "./product-asset-errors";
import { downloadProductImage } from "./product-image-download.service";
import { readProductImageDownload } from "./product-image-download.repository";
import { fetchProductImage } from "./product-image-download.transport";

const idSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));

function sendAssetError(res: Response, error: unknown, operation: string, id: number): void {
  const known = error instanceof ProductAssetError;
  console.error(JSON.stringify({ event: `catalog.assets.${operation}_failed`, id,
    code: known ? error.code : "ASSET_OPERATION_FAILED" }));
  res.status(known ? error.status : 500).json({
    code: known ? error.code : "ASSET_OPERATION_FAILED",
    error: known ? error.message : "The image operation failed. Refresh and try again.",
  });
}

export function registerProductAssetRoutes(app: Express): void {
  app.put("/api/products/:id/assets/reorder", requirePermission("inventory", "edit"), async (req, res) => {
    const productId = idSchema.safeParse(req.params.id);
    const command = reorderProductAssetsSchema.safeParse(req.body);
    if (!productId.success || !command.success) {
      return res.status(400).json({ code: "ASSET_ORDER_INVALID", error: "Provide a valid, complete image order with unique image IDs." });
    }
    try {
      await reorderCatalogAssets(db, productId.data, command.data);
      console.info(JSON.stringify({ event: "catalog.assets.reordered", actor: req.session.user?.id,
        productId: productId.data, orderedIds: command.data.orderedIds }));
      return res.json({ success: true });
    } catch (error) { sendAssetError(res, error, "reorder", productId.data); }
  });

  app.get("/api/product-assets/:id/download", requirePermission("inventory", "view"), async (req, res) => {
    const assetId = idSchema.safeParse(req.params.id);
    if (!assetId.success) return res.status(400).json({ code: "ASSET_ID_INVALID", error: "Invalid image ID." });
    try {
      const image = await downloadProductImage(assetId.data, {
        read: id => readProductImageDownload(db, id), fetchImage: fetchProductImage,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", `attachment; filename="${image.filename}"`);
      return res.type(image.mimeType).send(image.data);
    } catch (error) { sendAssetError(res, error, "download", assetId.data); }
  });
}
