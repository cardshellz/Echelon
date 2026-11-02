import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../../db";
import { products, productAssets, productVariants } from "@shared/schema";
import { persistAuditEvent } from "../../infrastructure/transactional-audit";
import { inspectCatalogImage } from "./catalog-image-inspection";
import { prepareCatalogPublicationRendition, prepareOptionalCatalogRendition, type CatalogPublicationRendition } from "./catalog-publication-rendition";
import type { DownloadableProductImage } from "./product-image-download.service";
import { ProductAssetError } from "./product-asset-errors";

const id = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const recoverySource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("catalog_asset"),
      assetId: id,
      contentHash: hash,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_url"),
      url: z
        .string()
        .url()
        .max(4096)
        .refine((value) => {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password;
        }),
    })
    .strict(),
]);
export const catalogOriginalReplacementSchema = z
  .object({
    productId: id,
    assetId: id,
    expected: z
      .object({
        url: z.string().nullable(),
        productVariantId: id.nullable(),
        position: z.number().int().nonnegative(),
        isPrimary: z.union([z.literal(0), z.literal(1)]),
        storedHash: hash.nullable(),
        storageType: z.enum(["url", "file", "both"]),
        mimeType: z.string().nullable(),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
        fileSize: z.number().int().nullable(),
      })
      .strict(),
    source: recoverySource,
    expectedOriginalHash: hash,
    /** Snapshot of the previous URL-only photo, retained before replacement. */
    expectedPriorHash: hash.optional(),
    actor: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(2000),
    evidenceReference: z.string().trim().min(1).max(1000),
  })
  .strict();
export type CatalogOriginalReplacement = z.infer<
  typeof catalogOriginalReplacementSchema
>;
export const catalogOriginalCreationSchema = z
  .object({
    productId: id,
    productVariantId: id.nullable().default(null),
    sourceUrl: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      })
      .nullable()
      .default(null),
    altText: z.string().max(500).nullable().default(null),
    position: z.number().int().nonnegative().max(2_147_483_647).optional(),
    isPrimary: z.boolean().optional(),
    actor: z.string().trim().min(1).max(200),
  })
  .strict();
export type CatalogOriginalCreation = z.input<
  typeof catalogOriginalCreationSchema
>;
type CatalogImageTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
export const MAX_RECOVERY_PHOTOS_PER_PRODUCT = 100;
export const MAX_RECOVERY_BATCH_BYTES = 100 * 1024 * 1024;

async function storeCatalogRendition(transaction: CatalogImageTransaction, assetId: number,
  rendition: CatalogPublicationRendition, now: Date): Promise<boolean> {
  const existing = await transaction.execute(sql`SELECT 1 FROM catalog.product_asset_renditions
    WHERE asset_id=${assetId} AND source_hash=${rendition.sourceHash} AND profile=${rendition.profile}`);
  if (existing.rows.length) return false;
  await transaction.execute(sql`INSERT INTO catalog.product_asset_versions(asset_id,content_hash,file_data,mime_type,created_at)
    VALUES (${assetId},${rendition.contentHash},${rendition.image.data},${rendition.image.mimeType},${now})
    ON CONFLICT (asset_id,content_hash) DO NOTHING`);
  const result = await transaction.execute(sql`INSERT INTO catalog.product_asset_renditions(asset_id,product_id,product_variant_id,source_hash,source_longest_side,profile,rendition_hash,created_at)
    SELECT id,product_id,product_variant_id,${rendition.sourceHash},${rendition.sourceLongestSide},${rendition.profile},${rendition.contentHash},${now}
    FROM catalog.product_assets WHERE id=${assetId}
    ON CONFLICT (asset_id,source_hash,profile) DO NOTHING`);
  return result.rowCount === 1;
}

/** The sole stored-original writer, shared by imports and reviewed recovery.
 * The version-retention trigger preserves immutable public URLs in the same transaction. */
export async function storeCatalogOriginal(
  transaction: CatalogImageTransaction,
  assetId: number,
  image: DownloadableProductImage,
  storageType: "file" | "both",
  now: Date,
  rendition: CatalogPublicationRendition | null,
): Promise<void> {
  const data = Buffer.from(image.data);
  const measured = inspectCatalogImage({ data, mimeType: image.mimeType });
  const result =
    await transaction.execute(sql`UPDATE catalog.product_assets SET file_data=${data}, mime_type=${measured.mimeType},
    width=${measured.width}, height=${measured.height}, file_size=${measured.bytes}, storage_type=${storageType}, updated_at=${now}
    WHERE id=${assetId}`);
  if (result.rowCount !== 1)
    throw new ProductAssetError(
      "CATALOG_IMAGE_SOURCE_CHANGED",
      "The photo no longer exists. Refresh and try again.",
      409,
    );
  if (rendition) {
    if (rendition.sourceHash !== measured.contentHash)
      throw new ProductAssetError("CATALOG_IMAGE_RENDITION_SOURCE_CHANGED", "The enlarged photo does not match its original.", 409);
    await storeCatalogRendition(transaction,assetId,rendition,now);
  }
}

/** Catalog owns an original's bytes. Every consumer keeps the same asset ID,
 * ownership, order, channel overlays and original import URL. Replays compare
 * the actual content hash; concurrent edits cannot be silently overwritten. */
export function createCatalogImageOriginalsService(
  database: Pick<typeof db, "transaction">,
  clock: () => Date,
) {
  async function prepareRecovery(
    input: CatalogOriginalReplacement,
    image: DownloadableProductImage,
    priorImage?: DownloadableProductImage,
  ) {
    const command = catalogOriginalReplacementSchema.parse(input);
    // Copy caller-owned bytes before crossing an asynchronous transaction boundary.
    const data = Buffer.from(image.data),
      measured = inspectCatalogImage({ data, mimeType: image.mimeType });
    if (measured.contentHash !== command.expectedOriginalHash)
      throw new ProductAssetError(
        "CATALOG_ORIGINAL_CHANGED",
        "The recovered image differs from its reviewed file. Review the original again.",
        409,
      );
    const rendition = await prepareCatalogPublicationRendition({ data, mimeType: measured.mimeType });
    const prior = priorImage ? { data: Buffer.from(priorImage.data), mimeType: priorImage.mimeType } : undefined;
    const priorMeasured = prior ? inspectCatalogImage(prior) : undefined;
    if (Boolean(command.expectedPriorHash) !== Boolean(priorMeasured)
      || (priorMeasured && priorMeasured.contentHash !== command.expectedPriorHash))
      throw new ProductAssetError("CATALOG_PRIOR_IMAGE_CHANGED", "The previous photo differs from the reviewed source snapshot.", 409);
    if (
      command.source.kind === "catalog_asset" &&
      command.source.contentHash !== measured.contentHash
    )
      throw new ProductAssetError(
        "CATALOG_ORIGINAL_CHANGED",
        "The referenced Catalog source does not match the reviewed file.",
        409,
      );
    return {command,data,measured,rendition,prior,priorMeasured};
  }
  async function recoverPrepared(prepared: Awaited<ReturnType<typeof prepareRecovery>>,
    apply: boolean, tx: CatalogImageTransaction, now: Date) {
      const {command,data,measured,rendition,prior,priorMeasured} = prepared;
      if (!apply) await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const productQuery = tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, command.productId));
      const [product] = await (apply
        ? productQuery.for("update")
        : productQuery);
      if (!product)
        throw new ProductAssetError(
          "PRODUCT_NOT_FOUND",
          "Product not found.",
          404,
        );
      const assetQuery = tx
        .select({
          id: productAssets.id,
          url: productAssets.url,
          productVariantId: productAssets.productVariantId,
          position: productAssets.position,
          isPrimary: productAssets.isPrimary,
          assetType: productAssets.assetType,
          width: productAssets.width,
          height: productAssets.height,
          fileSize: productAssets.fileSize,
          mimeType: productAssets.mimeType,
          storageType: productAssets.storageType,
          storedHash: sql<string | null>`encode(sha256(file_data), 'hex')`,
        })
        .from(productAssets)
        .where(
          and(
            eq(productAssets.productId, command.productId),
            eq(productAssets.id, command.assetId),
          ),
        );
      const [asset] = await (apply ? assetQuery.for("update") : assetQuery);
      if (command.source.kind === "catalog_asset") {
        const source =
          await tx.execute(sql`SELECT 1 FROM catalog.product_asset_versions
          WHERE asset_id=${command.source.assetId} AND content_hash=${command.source.contentHash}`);
        if (source.rows.length !== 1)
          throw new ProductAssetError(
            "CATALOG_ORIGINAL_SOURCE_MISSING",
            "The referenced Catalog original is no longer available. Review the recovery source again.",
            409,
          );
      }
      const expected = command.expected;
      if (
        !asset ||
        asset.assetType !== "image" ||
        asset.url !== expected.url ||
        asset.productVariantId !== expected.productVariantId ||
        asset.position !== expected.position ||
        asset.isPrimary !== expected.isPrimary
      )
        throw new ProductAssetError(
          "CATALOG_ORIGINAL_SOURCE_CHANGED",
          "The photo's source, assignment or order changed. Review the repair again.",
          409,
        );
      if (
        asset.storedHash === measured.contentHash &&
        asset.width === measured.width &&
        asset.height === measured.height &&
        asset.fileSize === measured.bytes &&
        asset.mimeType === measured.mimeType &&
        asset.storageType === (asset.url === null ? "file" : "both")
      ) {
        const renditionExists = !rendition || (await tx.execute(sql`SELECT 1 FROM catalog.product_asset_renditions
          WHERE asset_id=${command.assetId} AND source_hash=${rendition.sourceHash} AND profile=${rendition.profile}`)).rows.length > 0;
        const priorExists = !priorMeasured || (await tx.execute(sql`SELECT 1 FROM catalog.product_asset_versions
          WHERE asset_id=${command.assetId} AND content_hash=${priorMeasured.contentHash}`)).rows.length > 0;
        if (renditionExists && priorExists) return { changed: false, contentHash: measured.contentHash };
        if (apply) {
          if (!priorExists && prior && priorMeasured)
            await tx.execute(sql`INSERT INTO catalog.product_asset_versions(asset_id,content_hash,file_data,mime_type,created_at)
              VALUES (${command.assetId},${priorMeasured.contentHash},${prior.data},${priorMeasured.mimeType},${now})
              ON CONFLICT (asset_id,content_hash) DO NOTHING`);
          if (!renditionExists && rendition) await storeCatalogRendition(tx,command.assetId,rendition,now);
          await persistAuditEvent(tx, {
            actor: command.actor, action: "catalog.image_recovery.completed", target: `catalog.product_assets:${command.assetId}`,
            changes: { before: { sourceHash: measured.contentHash, priorRetained: priorExists, renditionRetained: renditionExists },
              after: { sourceHash: measured.contentHash, priorHash: priorMeasured?.contentHash ?? null,
                renditionHash: rendition?.contentHash ?? null } },
            context: { productId: command.productId, reason: command.reason, evidenceReference: command.evidenceReference },
          }, { timestamp: now, emitStructuredLog: false });
        }
        return { changed: true, contentHash: measured.contentHash };
      }
      if (
        asset.storedHash !== expected.storedHash ||
        asset.storageType !== expected.storageType ||
        asset.mimeType !== expected.mimeType ||
        asset.width !== expected.width ||
        asset.height !== expected.height ||
        asset.fileSize !== expected.fileSize
      )
        throw new ProductAssetError(
          "CATALOG_ORIGINAL_SOURCE_CHANGED",
          "The photo's stored original changed. Review the repair again.",
          409,
        );
      if (!asset.storedHash && asset.url && !prior
        && !(command.source.kind === "external_url" && command.source.url === asset.url))
        throw new ProductAssetError("CATALOG_PRIOR_IMAGE_REQUIRED", "Save the current URL-only photo before replacing it with a different original.", 409);
      if (asset.storedHash && priorMeasured && asset.storedHash !== priorMeasured.contentHash)
        throw new ProductAssetError("CATALOG_PRIOR_IMAGE_CHANGED", "The previous photo no longer matches the stored original.", 409);
      if (apply) {
        if (prior && priorMeasured && !asset.storedHash)
          await tx.execute(sql`INSERT INTO catalog.product_asset_versions(asset_id,content_hash,file_data,mime_type,created_at)
            VALUES (${command.assetId},${priorMeasured.contentHash},${prior.data},${priorMeasured.mimeType},${now})
            ON CONFLICT (asset_id,content_hash) DO NOTHING`);
        await storeCatalogOriginal(
          tx,
          command.assetId,
          { data, mimeType: measured.mimeType },
          asset.url === null ? "file" : "both",
          now,
          rendition,
        );
        await persistAuditEvent(
          tx,
          {
            actor: command.actor,
            action: "catalog.image_original.replaced",
            target: `catalog.product_assets:${command.assetId}`,
            changes: {
              before: asset,
              after: {
                ...asset,
                storedHash: measured.contentHash,
                width: measured.width,
                height: measured.height,
                fileSize: measured.bytes,
                mimeType: measured.mimeType,
                storageType: asset.url === null ? "file" : "both",
              },
            },
            context: {
              productId: command.productId,
              source: command.source,
              reason: command.reason,
              evidenceReference: command.evidenceReference,
              priorSourceHash: priorMeasured?.contentHash ?? asset.storedHash ?? measured.contentHash,
            },
          },
          { timestamp: now, emitStructuredLog: false },
        );
      }
      return { changed: true, contentHash: measured.contentHash };
  }
  async function recoverOriginal(input: CatalogOriginalReplacement, image: DownloadableProductImage,
    apply: boolean, priorImage?: DownloadableProductImage) {
    const prepared = await prepareRecovery(input,image,priorImage);
    const now = clock();
    return database.transaction(tx => recoverPrepared(prepared,apply,tx,now));
  }
  return {
    async create(
      input: CatalogOriginalCreation,
      image: DownloadableProductImage,
    ) {
      const command = catalogOriginalCreationSchema.parse(input);
      const data = Buffer.from(image.data),
        measured = inspectCatalogImage({ data, mimeType: image.mimeType });
      const { rendition, warning } = await prepareOptionalCatalogRendition({ data, mimeType: measured.mimeType });
      if (warning) console.warn(JSON.stringify({event:"catalog.image_rendition.unavailable",productId:command.productId,code:warning.code}));
      const now = clock();
      return database.transaction(async (tx) => {
        const [product] = await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.id, command.productId))
          .for("update");
        if (!product)
          throw new ProductAssetError(
            "PRODUCT_NOT_FOUND",
            "Product not found.",
            404,
          );
        if (command.productVariantId !== null) {
          const [variant] = await tx
            .select({ id: productVariants.id })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.id, command.productVariantId),
                eq(productVariants.productId, command.productId),
              ),
            )
            .for("update");
          if (!variant)
            throw new ProductAssetError(
              "ASSET_VARIANT_MISMATCH",
              "Choose a variant that belongs to this product.",
              422,
            );
        }
        const scoped =
          command.productVariantId === null
            ? isNull(productAssets.productVariantId)
            : eq(productAssets.productVariantId, command.productVariantId);
        const gallery = and(
          eq(productAssets.productId, command.productId),
          eq(productAssets.assetType, "image"),
          scoped,
        );
        const existing = await tx
          .select({
            id: productAssets.id,
            position: productAssets.position,
            isPrimary: productAssets.isPrimary,
            url: productAssets.url,
            altText: productAssets.altText,
            storageType: productAssets.storageType,
            mimeType: productAssets.mimeType,
            width: productAssets.width,
            height: productAssets.height,
            fileSize: productAssets.fileSize,
            hash: sql<string | null>`encode(sha256(file_data), 'hex')`,
          })
          .from(productAssets)
          .where(gallery)
          .for("update");
        // A retried upload of the same bytes/source/scope returns its asset;
        // metadata edits are separate explicit operations, never upload effects.
        const replay = existing.find(
          (asset) =>
            asset.hash === measured.contentHash &&
            asset.url === command.sourceUrl,
        );
        if (replay) {
          if (
            (input.altText !== undefined && input.altText !== replay.altText) ||
            (input.position !== undefined &&
              input.position !== replay.position) ||
            (input.isPrimary !== undefined &&
              input.isPrimary !== (replay.isPrimary === 1))
          )
            throw new ProductAssetError(
              "CATALOG_IMAGE_ALREADY_EXISTS",
              "This photo already exists. Use the existing photo to change its caption, order or primary setting.",
              409,
            );
          const storageType = command.sourceUrl === null ? "file" : "both";
          if (
            replay.storageType !== storageType ||
            replay.mimeType !== measured.mimeType ||
            replay.width !== measured.width ||
            replay.height !== measured.height ||
            replay.fileSize !== measured.bytes
          ) {
            await storeCatalogOriginal(
              tx,
              replay.id,
              { data, mimeType: measured.mimeType },
              storageType,
              now,
              rendition,
            );
            await persistAuditEvent(
              tx,
              {
                actor: command.actor,
                action: "catalog.image_original.metadata_corrected",
                target: `catalog.product_assets:${replay.id}`,
                changes: {
                  before: replay,
                  after: {
                    ...replay,
                    storageType,
                    mimeType: measured.mimeType,
                    width: measured.width,
                    height: measured.height,
                    fileSize: measured.bytes,
                  },
                },
                context: {
                  productId: command.productId,
                  sourceUrl: command.sourceUrl,
                },
              },
              { timestamp: now, emitStructuredLog: false },
            );
          }
          if (rendition && await storeCatalogRendition(tx,replay.id,rendition,now)) {
            await persistAuditEvent(tx, {
              actor: command.actor, action: "catalog.image_rendition.created", target: `catalog.product_assets:${replay.id}`,
              changes: { before: { sourceHash: rendition.sourceHash }, after: { sourceHash: rendition.sourceHash,
                profile: rendition.profile, renditionHash: rendition.contentHash } },
              context: { productId: command.productId, sourceUrl: command.sourceUrl },
            }, { timestamp: now, emitStructuredLog: false });
          }
          const existingAsset = (
            await tx
              .select()
              .from(productAssets)
              .where(eq(productAssets.id, replay.id))
          )[0];
          return warning ? {...existingAsset,publicationWarning:warning} : existingAsset;
        }
        const isPrimary = command.isPrimary ?? existing.length === 0;
        if (isPrimary)
          await tx.update(productAssets).set({ isPrimary: 0 }).where(gallery);
        const position =
          command.position ??
          existing.reduce(
            (maximum, asset) => Math.max(maximum, asset.position),
            -1,
          ) + 1;
        if (position > 2_147_483_647)
          throw new ProductAssetError(
            "ASSET_ORDER_INVALID",
            "No gallery positions remain. Reorder the photos before adding another.",
            409,
          );
        const [asset] = await tx
          .insert(productAssets)
          .values({
            productId: command.productId,
            productVariantId: command.productVariantId,
            assetType: "image",
            url: command.sourceUrl,
            altText: command.altText,
            position,
            isPrimary: isPrimary ? 1 : 0,
            width: measured.width,
            height: measured.height,
            fileSize: measured.bytes,
            mimeType: measured.mimeType,
            storageType: command.sourceUrl === null ? "file" : "both",
            createdAt: now,
          })
          .returning();
        await storeCatalogOriginal(
          tx,
          asset.id,
          { data, mimeType: measured.mimeType },
          command.sourceUrl === null ? "file" : "both",
          now,
          rendition,
        );
        await persistAuditEvent(
          tx,
          {
            actor: command.actor,
            action: "catalog.image_original.created",
            target: `catalog.product_assets:${asset.id}`,
            changes: {
              before: {
                primaryAssetIds: existing
                  .filter((photo) => photo.isPrimary === 1)
                  .map((photo) => photo.id),
              },
              after: {
                assetId: asset.id,
                productVariantId: command.productVariantId,
                position,
                isPrimary,
                contentHash: measured.contentHash,
                storageType: command.sourceUrl === null ? "file" : "both",
                mimeType: measured.mimeType,
                width: measured.width,
                height: measured.height,
                fileSize: measured.bytes,
              },
            },
            context: {
              productId: command.productId,
              sourceUrl: command.sourceUrl,
              ...(warning ? { renditionWarning: warning } : {}),
            },
          },
          { timestamp: now, emitStructuredLog: false },
        );
        return warning ? {...asset,publicationWarning:warning} : asset;
      });
    },
    async preview(
      input: CatalogOriginalReplacement,
      image: DownloadableProductImage,
      priorImage?: DownloadableProductImage,
    ): Promise<{ wouldApply: boolean; contentHash: string }> {
      const result = await recoverOriginal(input, image, false, priorImage);
      return { wouldApply: result.changed, contentHash: result.contentHash };
    },
    async replace(
      input: CatalogOriginalReplacement,
      image: DownloadableProductImage,
      priorImage?: DownloadableProductImage,
    ): Promise<{ applied: boolean; contentHash: string }> {
      const result = await recoverOriginal(input, image, true, priorImage);
      return { applied: result.changed, contentHash: result.contentHash };
    },
    /** One product's entire reviewed gallery commits together, before any
     * listing-intent worker can observe a partially recovered photo set. */
    async replaceBatch(items: readonly {command: CatalogOriginalReplacement; image: DownloadableProductImage;
      priorImage?: DownloadableProductImage}[]): Promise<Array<{assetId:number;applied:boolean;contentHash:string}>> {
      if (!Array.isArray(items) || items.length === 0 || items.length > MAX_RECOVERY_PHOTOS_PER_PRODUCT)
        throw new ProductAssetError("CATALOG_RECOVERY_BATCH_INVALID", "Select a bounded set of photos for one product.", 422);
      const commands = items.map(item => catalogOriginalReplacementSchema.parse(item.command));
      if (new Set(commands.map(command => command.productId)).size !== 1
        || new Set(commands.map(command => command.assetId)).size !== commands.length)
        throw new ProductAssetError("CATALOG_RECOVERY_BATCH_INVALID", "Each photo must appear once and belong to the same product.", 422);
      let bytes = 0;
      const prepared: Awaited<ReturnType<typeof prepareRecovery>>[] = [];
      for (const item of items) {
        const next = await prepareRecovery(item.command,item.image,item.priorImage);
        bytes += next.data.byteLength + (next.prior?.data.byteLength ?? 0) + (next.rendition?.image.data.byteLength ?? 0);
        if (bytes > MAX_RECOVERY_BATCH_BYTES)
          throw new ProductAssetError("CATALOG_RECOVERY_BATCH_TOO_LARGE", "The reviewed photos exceed the per-product recovery limit.", 413);
        prepared.push(next);
      }
      const now = clock();
      return database.transaction(async tx => {
        const results = [];
        for (const item of prepared) {
          const result = await recoverPrepared(item,true,tx,now);
          results.push({assetId:item.command.assetId,applied:result.changed,contentHash:result.contentHash});
        }
        return results;
      });
    },
  };
}
