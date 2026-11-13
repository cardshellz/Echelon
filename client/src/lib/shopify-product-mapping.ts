export function formatShopifyMappingRepairError(
  body: unknown,
  fallbackMessage = "Failed to repair Shopify product mapping",
): string {
  const response = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const baseMessage = typeof response?.error === "string" ? response.error : fallbackMessage;
  const context = response?.context && typeof response.context === "object"
    ? response.context as Record<string, unknown>
    : null;
  const issues = Array.isArray(context?.issues) ? context.issues : [];
  const issueMessages = issues.slice(0, 3).flatMap((rawIssue) => {
    if (!rawIssue || typeof rawIssue !== "object") return [];
    const issue = rawIssue as Record<string, unknown>;
    const identifier = typeof issue.sku === "string"
      ? issue.sku
      : `variant ${String(issue.variantId ?? "unknown")}`;
    const descriptions: Record<string, string> = {
      EXACT_SKU_NOT_FOUND: "no exact SKU exists on the verified Shopify product",
      EXACT_SKU_AMBIGUOUS: "the SKU matches more than one Shopify variant",
      ID_SKU_MISMATCH: "the linked Shopify variant has a different SKU",
      ID_SKU_CONFLICT: "the linked ID and exact SKU point to different Shopify variants",
      MULTIPLE_LIVE_IDS: "multiple linked IDs are still live on the Shopify product",
      INVENTORY_ITEM_ID_MISSING: "Shopify did not return an inventory item ID",
      LOCAL_SKU_MISSING: "the Echelon variant has no SKU for deterministic matching",
      LIVE_VARIANT_ASSIGNED_TWICE: "the same Shopify variant matched two Echelon variants",
      SELECTED_VARIANT_MISMATCH: "the selected Shopify variant does not match the verified SKU resolution",
      NO_ACTIVE_VARIANT_ON_SHOPIFY: "every linked Shopify variant was deleted, so nothing would remain mapped",
    };
    const description = descriptions[String(issue.code)] ?? "the active variant could not be resolved";
    return [`${identifier}: ${description}`];
  });

  return issueMessages.length > 0 ? `${baseMessage}. ${issueMessages.join("; ")}` : baseMessage;
}

/** Names the SKUs a repair marked not listed because their Shopify variant was deleted. */
export function describeDelistedShopifyVariants(body: unknown): string | null {
  const response = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const delisted = Array.isArray(response?.delistedVariants) ? response.delistedVariants : [];
  const labels = delisted.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const variant = raw as Record<string, unknown>;
    return [typeof variant.sku === "string" && variant.sku ? variant.sku : `variant ${String(variant.variantId ?? "unknown")}`];
  });
  if (labels.length === 0) return null;
  return `Not listed on this store anymore (deleted in Shopify): ${labels.join(", ")}.`;
}
