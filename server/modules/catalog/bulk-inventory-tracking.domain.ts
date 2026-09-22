import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { bulkInventoryTrackingPreviewSchema, type BulkInventoryTrackingProduct, type InventoryTrackingEvidence } from "@shared/catalog/bulk-inventory-tracking";
import type { Product, ProductVariant } from "@shared/schema";

export type BulkInventoryTrackingSelection = Array<{
  productId: number;
  snapshot: {
    product: Pick<Product, "name" | "sku" | "inventoryTrackingDefault" | "updatedAt">;
    transitions: Array<{
      variant: Pick<ProductVariant, "id" | "name" | "sku" | "requiresShipping" | "inventoryTrackingOverride" | "trackInventory" | "updatedAt">;
      effective: boolean;
      blockers: string[];
      evidence?: Record<string, InventoryTrackingEvidence>;
    }>;
  } | null;
}>;

const blockerMessages: Record<string, string> = {
  stock: "stock or warehouse quantities", lots: "inventory lots", claims: "active inventory claims",
  resources: "claimed inventory resources", open_orders: "unfinished warehouse orders",
  oms_orders: "unfinished sales orders", publication: "pending inventory publication",
};

export function buildBulkInventoryTrackingPreview(selection: BulkInventoryTrackingSelection, next: boolean) {
  const products: BulkInventoryTrackingProduct[] = selection.map(({ productId, snapshot }) => {
    if (!snapshot) return { productId, name: `Product ${productId}`, sku: null, currentDefault: null,
      status: "blocked", variantCount: 0, changingVariantCount: 0, trackedOverrideCount: 0, untrackedOverrideCount: 0,
      blockers: [{ variantId: null, code: "CATALOG_PRODUCT_MISSING", message: "Product no longer exists. Remove it from the selection." }] };
    const { product, transitions } = snapshot;
    const blockers = transitions.flatMap(({ variant, blockers, evidence }) => blockers.map(code => ({
      variantId: variant.id, code,
      message: `${variant.sku ?? variant.name}: ${blockerMessages[code] ?? code}`,
      evidence: evidence?.[code],
    })));
    return { productId, name: product.name, sku: product.sku, currentDefault: product.inventoryTrackingDefault,
      status: blockers.length > 0 ? "blocked" : product.inventoryTrackingDefault === next ? "unchanged" : "change",
      variantCount: transitions.length,
      changingVariantCount: transitions.filter(({ variant, effective }) => (variant.trackInventory !== false) !== effective).length,
      trackedOverrideCount: transitions.filter(({ variant }) => variant.inventoryTrackingOverride === true).length,
      untrackedOverrideCount: transitions.filter(({ variant }) => variant.inventoryTrackingOverride === false).length,
      blockers };
  });
  // Include identities and current policies, including overrides that preserve
  // their effective value. A concurrent edit must not change the reviewed set.
  const evidence = selection.map(({ productId, snapshot }) => ({ productId,
    product: snapshot ? { name: snapshot.product.name, sku: snapshot.product.sku,
      default: snapshot.product.inventoryTrackingDefault, updatedAt: snapshot.product.updatedAt } : null,
    variants: snapshot?.transitions.map(({ variant, effective, blockers, evidence }) => ({ id: variant.id,
      sku: variant.sku, name: variant.name, requiresShipping: variant.requiresShipping,
      override: variant.inventoryTrackingOverride, current: variant.trackInventory,
      updatedAt: variant.updatedAt, effective, blockers, evidence })) ?? [],
  }));
  const previewHash = createHash("sha256").update(canonicalJson({ version: 2, next, evidence })).digest("hex");
  return bulkInventoryTrackingPreviewSchema.parse({ previewHash, inventoryTrackingDefault: next, products });
}
