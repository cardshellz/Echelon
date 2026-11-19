import {
  connectionFingerprint, eligibleConnectionVariants, ShopifyProductConnectionError,
  type ShopifyConnectionSource, type ShopifyConnectionRemoteProduct, type ShopifyConnectionSkuAssignment,
  type ShopifyConnectionReviewEvidence,
} from "./shopify-product-connection.domain";
import { STOCK_LINK_SKU_MAX_LENGTH } from "@shared/types/stock-link";

const skuKey = (sku: string | null): string => (sku ?? "").trim().toUpperCase();

/** Freeze only blank fields on explicitly resolved identities. Existing values
 * are preserved, including channel-specific SKUs that differ from the catalog. */
export function planLinkSkuAssignments(source: ShopifyConnectionSource, remote: ShopifyConnectionRemoteProduct,
  bindings: ShopifyConnectionReviewEvidence["bindings"]): ShopifyConnectionSkuAssignment[] {
  const selected = eligibleConnectionVariants(source).map(variant => ({ variantId: variant.id,
    sku: variant.stockSku === undefined ? variant.sku : variant.stockSku,
    remoteVariantId: bindings.find(binding => binding.variantId === variant.id)?.remoteVariantId }));
  if (source.variants.length === 0 && remote.variants.length === 1) {
    const variant = remote.variants[0];
    if (skuKey(variant.sku)) return [];
    return [assignment(null, source.product.sku, variant)];
  }
  const result: ShopifyConnectionSkuAssignment[] = [];
  for (const selectedVariant of selected) {
    if (!selectedVariant.remoteVariantId) continue; // The preview already requires a variant selection.
    const variant = remote.variants.find(candidate => candidate.id === selectedVariant.remoteVariantId);
    if (!variant) throw new ShopifyProductConnectionError("SHOPIFY_SKU_IDENTITY_CHANGED", "A selected Shopify variant no longer exists.");
    if (!skuKey(variant.sku)) result.push(assignment(selectedVariant.variantId, selectedVariant.sku, variant));
  }
  if (new Set(result.map(item => skuKey(item.sku))).size !== result.length) {
    throw new ShopifyProductConnectionError("SHOPIFY_SKU_CONFLICT", "The selected catalog variants have duplicate SKUs. Resolve them before linking.");
  }
  return result;
}

function assignment(variantId: number | null, sku: string | null, remote: ShopifyConnectionRemoteProduct["variants"][number]): ShopifyConnectionSkuAssignment {
  const value = sku?.trim();
  if (!value || Array.from(value).length > STOCK_LINK_SKU_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ShopifyProductConnectionError("SHOPIFY_SKU_REQUIRED", "A selected Shopify variant has no SKU. Set a valid catalog or channel SKU before linking.", 422);
  }
  if (!remote.inventoryItemId) throw new ShopifyProductConnectionError("SHOPIFY_SKU_IDENTITY_CHANGED", "The selected Shopify variant has no verified inventory item.");
  return { variantId, remoteVariantId: remote.id, inventoryItemId: remote.inventoryItemId, beforeSku: remote.sku, sku: value };
}

export function shopifyConnectionRemoteFingerprint(remote: ShopifyConnectionRemoteProduct): string {
  // Quantities change independently of product identity.
  return connectionFingerprint({ id: remote.id, title: remote.title, status: remote.status,
    variants: remote.variants.map(variant => ({ id: variant.id, sku: variant.sku,
      inventoryItemId: variant.inventoryItemId, barcode: variant.barcode })).sort((left, right) => left.id < right.id ? -1 : 1) });
}

/** A retry may observe none, some or all of this command's requested fills.
 * Normalize only its exact expected value; unrelated changes still fail closed. */
export function assertLinkSkuProgress(remote: ShopifyConnectionRemoteProduct, review: ShopifyConnectionReviewEvidence, complete = false): void {
  const assignments = review.skuAssignments ?? [];
  for (const item of assignments) {
    const variant = remote.variants.find(candidate => candidate.id === item.remoteVariantId);
    if (!variant || variant.inventoryItemId !== item.inventoryItemId ||
      (variant.sku !== item.beforeSku && variant.sku !== item.sku)) {
      throw new ShopifyProductConnectionError("SHOPIFY_SKU_CHANGED", "A reviewed Shopify SKU or inventory identity changed. Existing SKUs were not overwritten; review the current product.");
    }
    if (complete && variant.sku !== item.sku) throw new ShopifyProductConnectionError("SHOPIFY_SKU_UNCONFIRMED", "Shopify has not confirmed every requested SKU. Resume the saved command before inventory sync.", 503, true);
  }
  const normalized = { ...remote, variants: remote.variants.map(variant => {
    const item = assignments.find(item => item.remoteVariantId === variant.id);
    return item && variant.sku === item.sku ? { ...variant, sku: item.beforeSku } : variant;
  }) };
  if (shopifyConnectionRemoteFingerprint(normalized) !== review.remoteFingerprint) {
    throw new ShopifyProductConnectionError("SHOPIFY_REMOTE_CHANGED", "The reviewed Shopify product or variant identities changed. Review a new linking request.");
  }
}

export function assertLinkSkusAvailable(assignments: readonly ShopifyConnectionSkuAssignment[], products: readonly ShopifyConnectionRemoteProduct[]): void {
  for (const item of assignments) {
    if (products.some(product => product.variants.some(variant => skuKey(variant.sku) === skuKey(item.sku) && variant.id !== item.remoteVariantId))) {
      throw new ShopifyProductConnectionError("SHOPIFY_SKU_CONFLICT", `Shopify already uses ${item.sku} on another variant. No existing SKU will be overwritten.`);
    }
  }
}
