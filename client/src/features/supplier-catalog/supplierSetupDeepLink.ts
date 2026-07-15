export interface SupplierSetupDeepLink {
  productId: number;
  productVariantId: number | null;
  vendorId: number | null;
  vendorProductId: number | null;
  recommendationId: string | null;
  action: string | null;
  returnTo: string;
}

function positiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeReturnPath(value: string | null): string {
  return value === "/reorder-analysis" || value === "/purchasing"
    ? value
    : "/purchasing";
}

export function parseSupplierSetupDeepLink(search: string): SupplierSetupDeepLink | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const productId = positiveInteger(params.get("setupProductId"));
  if (!productId) return null;

  return {
    productId,
    productVariantId: positiveInteger(params.get("setupVariantId")),
    vendorId: positiveInteger(params.get("vendorId")),
    vendorProductId: positiveInteger(params.get("vendorProductId")),
    recommendationId: params.get("recommendationId")?.trim() || null,
    action: params.get("setupAction")?.trim() || null,
    returnTo: safeReturnPath(params.get("returnTo")),
  };
}
