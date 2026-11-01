import type { Express, Response, RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { reorderProductAssetsSchema } from "@shared/catalog/product-assets";
import {
  productAssetScopeSchema,
  productAssetScopeResultSchema,
} from "@shared/catalog/product-asset-scope";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { createProductAssetScopeService } from "./product-asset-scope.service";
import { reorderCatalogAssets } from "./product-asset-order.repository";
import { ProductAssetError } from "./product-asset-errors";
import { downloadProductImage } from "./product-image-download.service";
import { readProductImageDownload } from "./product-image-download.repository";
import { fetchProductImage } from "./product-image-download.transport";
import {
  catalogOriginalCreationSchema,
  createCatalogImageOriginalsService,
} from "./catalog-image-originals.service";

const idSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647));

function sendAssetError(
  res: Response,
  error: unknown,
  operation: string,
  id: number,
): void {
  if (error instanceof FinancialCommandError) {
    for (const [key, value] of Object.entries(error.responseHeaders ?? {}))
      res.setHeader(key, value);
    res
      .status(error.statusCode)
      .json({ code: error.code, error: error.message });
    return;
  }
  const known = error instanceof ProductAssetError;
  console.error(
    JSON.stringify({
      event: `catalog.assets.${operation}_failed`,
      id,
      code: known ? error.code : "ASSET_OPERATION_FAILED",
    }),
  );
  res.status(known ? error.status : 500).json({
    code: known ? error.code : "ASSET_OPERATION_FAILED",
    error: known
      ? error.message
      : "The image operation failed. Refresh and try again.",
  });
}

export function registerProductAssetRoutes(app: Express): void {
  const originals = createCatalogImageOriginalsService(db, () => new Date());
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });
  const receiveImage: RequestHandler = (req, res, next) => {
    upload.single("file")(req, res, (error) => {
      if (!error) return next();
      const tooLarge =
        error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
      console.warn(
        JSON.stringify({
          event: "catalog.assets.upload_refused",
          code: tooLarge ? "IMAGE_TOO_LARGE" : "ASSET_UPLOAD_INVALID",
        }),
      );
      return res
        .status(tooLarge ? 413 : 400)
        .json({
          code: tooLarge ? "IMAGE_TOO_LARGE" : "ASSET_UPLOAD_INVALID",
          error: tooLarge
            ? "The image exceeds the 10 MB upload limit."
            : "Upload one image using the file field.",
        });
    });
  };
  const uploadFields = z
    .object({
      productId: idSchema,
      productVariantId: idSchema.optional(),
      altText: z.string().max(500).optional(),
      position: z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().nonnegative().max(2_147_483_647))
        .optional(),
      isPrimary: z
        .enum(["true", "false", "1", "0"])
        .transform((value) => value === "true" || value === "1")
        .optional(),
    })
    .strict();
  app.post(
    "/api/product-assets/upload",
    requirePermission("inventory", "edit"),
    receiveImage,
    async (req, res) => {
      const fields = uploadFields.safeParse(req.body);
      if (!fields.success || !req.file)
        return res.status(400).json({
          code: "ASSET_UPLOAD_INVALID",
          error: "Choose an image and a valid product assignment.",
        });
      try {
        const asset = await originals.create(
          {
            ...fields.data,
            sourceUrl: null,
            actor: `user:${req.session.user!.id}`,
          },
          { data: req.file.buffer, mimeType: req.file.mimetype },
        );
        return res.json({
          ...asset,
          fileUrl: `/api/product-assets/${asset.id}/file`,
        });
      } catch (error) {
        sendAssetError(res, error, "upload", fields.data.productId);
      }
    },
  );
  const urlFields = z
    .object({
      productId: z.number().int().positive().max(2_147_483_647),
      productVariantId: z
        .number()
        .int()
        .positive()
        .max(2_147_483_647)
        .nullable()
        .optional(),
      url: z.string().url().max(4096),
      altText: z.string().max(500).nullable().optional(),
      isPrimary: z.boolean().optional(),
      position: z.number().int().nonnegative().max(2_147_483_647).optional(),
      cacheLocally: z.boolean().optional(),
    })
    .strict();
  app.post(
    "/api/product-assets/store-url",
    requirePermission("inventory", "edit"),
    async (req, res) => {
      const fields = urlFields.safeParse(req.body);
      if (!fields.success)
        return res.status(400).json({
          code: "ASSET_SOURCE_INVALID",
          error: "Provide a valid image URL and product assignment.",
        });
      try {
        const {
          url,
          cacheLocally: _legacyCachePreference,
          ...metadata
        } = fields.data;
        // Publication needs a retained original regardless of the old cache hint.
        const asset = await originals.create(
          {
            ...metadata,
            sourceUrl: url,
            actor: `user:${req.session.user!.id}`,
          },
          await fetchProductImage(url),
        );
        return res.json({
          ...asset,
          fileUrl: `/api/product-assets/${asset.id}/file`,
        });
      } catch (error) {
        sendAssetError(res, error, "source", fields.data.productId);
      }
    },
  );
  app.post(
    "/api/products/:id/assets",
    requirePermission("inventory", "create"),
    async (req, res, next) => {
      if (req.body.assetType && req.body.assetType !== "image") return next();
      const productId = idSchema.safeParse(req.params.id);
      const {
        assetType: _assetType,
        storageType: _legacyStorage,
        ...body
      } = req.body;
      // The compatibility endpoint calls its URL 'url'; it cannot accept invented
      // dimensions, cached-byte metadata or cross-product source edits.
      if (!productId.success || typeof body.url !== "string")
        return res.status(400).json({
          code: "ASSET_SOURCE_INVALID",
          error: "Provide an image URL and valid product.",
        });
      const { url, ...metadata } = body;
      if (
        typeof metadata.isPrimary === "number" &&
        ![0, 1].includes(metadata.isPrimary)
      )
        return res.status(400).json({
          code: "ASSET_SOURCE_INVALID",
          error: "Choose a valid primary-image setting.",
        });
      const source = catalogOriginalCreationSchema.safeParse({
        ...metadata,
        productId: productId.data,
        sourceUrl: url,
        actor: `user:${req.session.user!.id}`,
        ...(typeof metadata.isPrimary === "number"
          ? { isPrimary: metadata.isPrimary === 1 }
          : {}),
      });
      if (!source.success)
        return res.status(400).json({
          code: "ASSET_SOURCE_INVALID",
          error: "Image metadata must come from its original file.",
        });
      try {
        return res
          .status(201)
          .json(
            await originals.create(source.data, await fetchProductImage(url)),
          );
      } catch (error) {
        sendAssetError(res, error, "source", productId.data);
      }
    },
  );
  const scopeService = createProductAssetScopeService(db, () => new Date());
  const scopePath = "/api/products/:id/assets/:assetId/scope";
  app.put(
    scopePath,
    requirePermission("inventory", "edit"),
    async (req, res) => {
      const productId = idSchema.safeParse(req.params.id);
      const assetId = idSchema.safeParse(req.params.assetId);
      const command = productAssetScopeSchema.safeParse(req.body);
      if (!productId.success || !assetId.success || !command.success) {
        return res.status(400).json({
          code: "ASSET_SCOPE_INVALID",
          error:
            "Provide a valid photo assignment and its previous assignment.",
        });
      }
      try {
        const descriptor = financialCommandFromRequest(req, {
          routeTemplate: scopePath,
          resourceKey: `product:${productId.data}:asset:${assetId.data}`,
          commandName: "catalog.asset.scope",
        });
        const result = await scopeService.apply(
          productId.data,
          assetId.data,
          command.data,
          descriptor,
        );
        if (
          result.terminalState === "succeeded" &&
          !productAssetScopeResultSchema.safeParse(result.body).success
        ) {
          throw new Error("Invalid photo assignment response");
        }
        res.setHeader("Idempotency-Replayed", String(result.replayed));
        res.setHeader("Cache-Control", "no-store");
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        sendAssetError(res, error, "scope", assetId.data);
      }
    },
  );

  app.put(
    "/api/products/:id/assets/reorder",
    requirePermission("inventory", "edit"),
    async (req, res) => {
      const productId = idSchema.safeParse(req.params.id);
      const command = reorderProductAssetsSchema.safeParse(req.body);
      if (!productId.success || !command.success) {
        return res.status(400).json({
          code: "ASSET_ORDER_INVALID",
          error: "Provide a valid, complete image order with unique image IDs.",
        });
      }
      try {
        await reorderCatalogAssets(db, productId.data, command.data);
        console.info(
          JSON.stringify({
            event: "catalog.assets.reordered",
            actor: req.session.user?.id,
            productId: productId.data,
            orderedIds: command.data.orderedIds,
          }),
        );
        return res.json({ success: true });
      } catch (error) {
        sendAssetError(res, error, "reorder", productId.data);
      }
    },
  );

  app.get(
    "/api/product-assets/:id/download",
    requirePermission("inventory", "view"),
    async (req, res) => {
      const assetId = idSchema.safeParse(req.params.id);
      if (!assetId.success)
        return res
          .status(400)
          .json({ code: "ASSET_ID_INVALID", error: "Invalid image ID." });
      try {
        const image = await downloadProductImage(assetId.data, {
          read: (id) => readProductImageDownload(db, id),
          fetchImage: fetchProductImage,
        });
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${image.filename}"`,
        );
        return res.type(image.mimeType).send(image.data);
      } catch (error) {
        sendAssetError(res, error, "download", assetId.data);
      }
    },
  );
}
