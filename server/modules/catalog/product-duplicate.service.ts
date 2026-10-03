// ─────────────────────────────────────────────────────────────────────────────
// Duplicate Product
//
// Clones an existing catalog product into a NEW product with fresh SKUs. Mirrors
// the purchase-order duplicate pattern (duplicatePurchaseOrder), adapted for the
// product model. The crux vs. POs: a PO number is auto-generated, but product
// and variant SKUs are caller-supplied and variant SKUs are uniquely enforced
// (partial unique index on UPPER(sku) WHERE is_active — migration 0251), so the
// new SKUs must be provided and validated up front.
//
// What it COPIES: descriptive product fields, every ACTIVE variant, and all assets
// (images/media, product- and variant-scoped).
// What it RESETS: identity (ids), status → draft, and — critically —
// every Shopify sync key (shopifyProductId / shopifyVariantId /
// shopifyInventoryItemId) plus lastPushedAt, so the copy is fully unlinked and
// can't corrupt the source's channel sync.
// What it does NOT copy: inventory behavior, directions, recipe bindings,
// inventory levels, channel feeds, bin/pick locations,
// supplier SKUs — those live in other tables and are established per-product
// after creation.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Product,
  ProductVariant,
  ProductAsset,
  InsertProduct,
  InsertProductVariant,
  InsertProductAsset,
} from "@shared/schema";

export class ProductDuplicateError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "ProductDuplicateError";
  }
}

export interface DuplicateProductInput {
  name: string;
  sku: string;
  variants?: Array<{ sourceVariantId: number; sku: string }>;
  status?: string; // Only draft is accepted; inventory behavior requires review.
}

export interface DuplicateProductStorage {
  getProductById(id: number): Promise<Product | undefined>;
  getProductBySku(sku: string): Promise<Product | undefined>;
  getActiveVariantBySku(sku: string, excludeId?: number): Promise<ProductVariant | undefined>;
  getProductVariantsByProductId(productId: number): Promise<ProductVariant[]>;
  getProductAssetsByProductId(productId: number): Promise<ProductAsset[]>;
  createProduct(product: InsertProduct): Promise<Product>;
  createProductVariant(variant: InsertProductVariant): Promise<ProductVariant>;
  createProductAsset(asset: InsertProductAsset): Promise<ProductAsset>;
}

export async function duplicateProduct(
  storage: DuplicateProductStorage,
  sourceId: number,
  input: DuplicateProductInput,
): Promise<Product & { variants: ProductVariant[] }> {
  const name = (input.name ?? "").trim();
  const sku = (input.sku ?? "").trim();
  if (!name) throw new ProductDuplicateError("Product name is required");
  if (!sku) throw new ProductDuplicateError("Base SKU is required");
  if (input.status !== undefined && input.status !== "draft") {
    throw new ProductDuplicateError("A duplicate must start as a draft. Review its inventory behavior before activating it.");
  }

  const source = await storage.getProductById(sourceId);
  if (!source) throw new ProductDuplicateError("Product not found", 404);

  // Base SKU must not collide with another product (not DB-unique, enforced here).
  const skuConflict = await storage.getProductBySku(sku);
  if (skuConflict) {
    throw new ProductDuplicateError(
      `Base SKU "${sku}" is already used by another product`,
      409,
      { conflictProductId: skuConflict.id },
    );
  }

  // Only ACTIVE variants are duplicated; each needs a new, unique SKU.
  const sourceVariants = (await storage.getProductVariantsByProductId(sourceId)).filter((v) => v.isActive);
  const newSkuBySourceVariant = new Map<number, string>();
  for (const vi of input.variants ?? []) {
    if (vi && vi.sourceVariantId != null && typeof vi.sku === "string") {
      newSkuBySourceVariant.set(Number(vi.sourceVariantId), vi.sku.trim());
    }
  }

  // Validate every active variant has a non-empty, non-duplicate, non-conflicting SKU.
  const seen = new Set<string>();
  for (const v of sourceVariants) {
    const newSku = newSkuBySourceVariant.get(v.id);
    if (!newSku) {
      throw new ProductDuplicateError(`A new SKU is required for variant "${v.name}"`, 400, {
        sourceVariantId: v.id,
      });
    }
    const key = newSku.toUpperCase();
    if (seen.has(key)) {
      throw new ProductDuplicateError(`Duplicate SKU "${newSku}" among the new variants`, 409);
    }
    seen.add(key);
    const conflict = await storage.getActiveVariantBySku(newSku);
    if (conflict) {
      throw new ProductDuplicateError(`Variant SKU "${newSku}" already exists`, 409, {
        conflictVariantId: conflict.id,
      });
    }
  }

  // ── Create the new product: copy source fields, reset identity + sync keys ──
  const { id: _pid, createdAt: _pc, updatedAt: _pu, ...productFields } = source as any;
  const newProduct = await storage.createProduct({
    ...productFields,
    name,
    sku,
    title: null, // Shopify display title — the unlinked copy has none; falls back to name.
    shopifyProductId: null, // MUST reset — never bind the copy to the source's Shopify product.
    lastPushedAt: null,
    status: "draft",
    // No source strategy/permission is silently inherited. The new product
    // has no active model until its own Inventory behavior is reviewed/applied.
    inventoryStrategy: "physical_only",
    isActive: true,
  } as InsertProduct);

  // Copy physical SKU definitions. Parent links are retired conversion controls.
  const newIdBySourceVariant = new Map<number, number>();
  for (const v of sourceVariants) {
    const { id: _vid, createdAt: _vc, updatedAt: _vu, trackInventory: _effectiveTracking, ...variantFields } = v as any;
    const created = await storage.createProductVariant({
      ...variantFields,
      productId: newProduct.id,
      sku: newSkuBySourceVariant.get(v.id)!,
      parentVariantId: null,
      shopifyVariantId: null, // MUST reset
      shopifyInventoryItemId: null, // MUST reset
      isActive: true,
    } as InsertProductVariant);
    newIdBySourceVariant.set(v.id, created.id);
  }

  // ── Copy assets (images/media); remap variant-scoped assets to new variant ids ──
  const sourceAssets = await storage.getProductAssetsByProductId(sourceId);
  for (const a of sourceAssets) {
    let newVariantId: number | null = null;
    if (a.productVariantId != null) {
      newVariantId = newIdBySourceVariant.get(a.productVariantId) ?? null;
      // Variant-scoped asset whose variant wasn't duplicated (inactive) → skip.
      if (newVariantId == null) continue;
    }
    const { id: _aid, createdAt: _ac, ...assetFields } = a as any;
    await storage.createProductAsset({
      ...assetFields,
      productId: newProduct.id,
      productVariantId: newVariantId,
    } as InsertProductAsset);
  }

  const variants = await storage.getProductVariantsByProductId(newProduct.id);
  return { ...newProduct, variants };
}
