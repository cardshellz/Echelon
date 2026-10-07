import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../../db";
import { productAssets, products, productVariants } from "@shared/schema";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { ProductAssetError } from "./product-asset-errors";

const id = z.number().int().positive().max(2_147_483_647);
const snapshotSchema = z.object({
  id, url: z.string().url(), productVariantId: id,
  position: z.number().int(), isPrimary: z.union([z.literal(0), z.literal(1)]),
}).strict();
export const imageScopeRepairSchema = z.object({
  productId: id,
  expected: z.array(snapshotSchema).min(1).max(100),
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
  evidenceReference: z.string().trim().min(1).max(1000),
  now: z.date(),
}).strict().refine(input => new Set(input.expected.map(asset => asset.id)).size === input.expected.length,
  "Image IDs must be unique");
export type ImageScopeRepair = z.infer<typeof imageScopeRepairSchema>;

export interface ImageScopeSnapshot {
  id: number; productId: number; productVariantId: number | null; variantProductId: number | null;
  assetType: string; url: string | null; position: number; isPrimary: number;
}

/** Only an explicitly reviewed cross-product mistake can become a shared photo.
 * Valid sibling-specific photos must never be promoted as a fallback for missing images.
 */
export function planImageScopeRepair(input: ImageScopeRepair, current: ImageScopeSnapshot[]) {
  const parsed = imageScopeRepairSchema.safeParse(input);
  if (!parsed.success) throw new ProductAssetError("IMAGE_SCOPE_REPAIR_INVALID", "Provide a complete, reviewed image repair snapshot.", 400);
  const expected = new Map(parsed.data.expected.map(asset => [asset.id, asset]));
  if (current.length !== expected.size || new Set(current.map(asset => asset.id)).size !== expected.size) {
    throw new ProductAssetError("IMAGE_SCOPE_REPAIR_STALE", "Images changed. Review the repair again.", 409);
  }
  for (const asset of current) {
    const before = expected.get(asset.id);
    if (!before || asset.productId !== input.productId || asset.assetType !== "image"
      || asset.url !== before.url || asset.position !== before.position || asset.isPrimary !== before.isPrimary
      || (asset.productVariantId !== null && (asset.productVariantId !== before.productVariantId
        || asset.variantProductId === null || asset.variantProductId === input.productId))) {
      throw new ProductAssetError("IMAGE_SCOPE_REPAIR_STALE", "Image ownership or content changed. Review the repair again.", 409);
    }
  }
  const alreadyApplied = current.every(asset => asset.productVariantId === null);
  if (!alreadyApplied && current.some(asset => asset.productVariantId === null)) {
    throw new ProductAssetError("IMAGE_SCOPE_REPAIR_STALE", "Image ownership partially changed. Review the repair again.", 409);
  }
  return { alreadyApplied, before: current, after: current.map(asset => ({ ...asset, productVariantId: null, variantProductId: null })) };
}

/** Defaults to a dry run. The data change and audit event are one transaction. */
export async function repairCatalogImageScope(database: Pick<typeof db, "transaction">, input: ImageScopeRepair, apply = false) {
  const parsed = imageScopeRepairSchema.safeParse(input);
  if (!parsed.success) throw new ProductAssetError("IMAGE_SCOPE_REPAIR_INVALID", "Provide a complete, reviewed image repair snapshot.", 400);
  const command = parsed.data;
  return database.transaction(async tx => {
    const [product] = await tx.select({ id: products.id }).from(products)
      .where(eq(products.id, command.productId)).for("update");
    if (!product) throw new ProductAssetError("PRODUCT_NOT_FOUND", "Product not found.", 404);
    const assets = await tx.select({
      id: productAssets.id, productId: productAssets.productId, productVariantId: productAssets.productVariantId,
      assetType: productAssets.assetType, url: productAssets.url, position: productAssets.position, isPrimary: productAssets.isPrimary,
    }).from(productAssets).where(and(eq(productAssets.productId, command.productId), inArray(productAssets.id, command.expected.map(asset => asset.id))))
      .orderBy(productAssets.id).for("update");
    const variantIds = [...new Set(assets.flatMap(asset => asset.productVariantId === null ? [] : [asset.productVariantId]))];
    const variants = variantIds.length ? await tx.select({ id: productVariants.id, productId: productVariants.productId })
      .from(productVariants).where(inArray(productVariants.id, variantIds)).orderBy(productVariants.id).for("share") : [];
    const variantProducts = new Map(variants.map(variant => [variant.id, variant.productId]));
    const plan = planImageScopeRepair(command, assets.map(asset => ({ ...asset,
      variantProductId: asset.productVariantId === null ? null : variantProducts.get(asset.productVariantId) ?? null,
    })));
    if (apply && !plan.alreadyApplied) {
      await tx.update(productAssets).set({ productVariantId: null })
        .where(and(eq(productAssets.productId, command.productId), inArray(productAssets.id, command.expected.map(asset => asset.id))));
      await persistAuditEvent(tx, {
        actor: command.actor, action: "catalog.image_variant_scope_repaired", target: `catalog.product:${command.productId}`,
        changes: { before: { assets: plan.before }, after: { assets: plan.after } },
        context: { reason: command.reason, evidenceReference: command.evidenceReference },
      }, { timestamp: command.now, emitStructuredLog: false });
    }
    return { ...plan, applied: apply && !plan.alreadyApplied };
  });
}
