export interface ChannelFulfillmentInventoryConfiguration {
  readonly omsInventoryTracking?: boolean | null;
  readonly wmsInventoryTracking?: boolean | null;
  readonly omsCatalogProductId?: number | null;
  readonly wmsCatalogProductId?: number | null;
  readonly omsRequiresShipping: boolean | null;
  readonly wmsRequiresShipping: number;
  readonly productVariantId: number | null;
  readonly catalogVariantId: number | null;
  readonly catalogRequiresShipping: boolean | null;
  readonly catalogTrackInventory: boolean | null;
}

export type ChannelFulfillmentInventoryDecision =
  | Readonly<{
      status: "resolved";
      requiresInventoryPosting: boolean;
      reason: "tracked_physical_item" | "non_shipping_item" | "non_inventory_item";
    }>
  | Readonly<{
      status: "conflict";
      reasons: readonly string[];
    }>;

/**
 * Decide whether a provider fulfillment line transfers inventory custody.
 *
 * Fulfillment and inventory are separate facts: a channel may legitimately
 * fulfill a donation, service, or other non-stock line without moving warehouse
 * inventory. Explicit disagreement between OMS, WMS, and catalog shipping facts
 * is never resolved by precedence; it is retained for review instead.
 */
export function decideChannelFulfillmentInventoryPosting(
  configuration: ChannelFulfillmentInventoryConfiguration,
): ChannelFulfillmentInventoryDecision {
  const reasons: string[] = [];
  if (!Number.isInteger(configuration.wmsRequiresShipping)
    || ![0, 1].includes(configuration.wmsRequiresShipping)) {
    reasons.push("wms_requires_shipping_invalid");
  }
  if (configuration.catalogVariantId !== null
    && configuration.catalogRequiresShipping === null) {
    reasons.push("catalog_requires_shipping_missing");
  }
  if (configuration.productVariantId !== null && configuration.catalogVariantId === null) {
    reasons.push("catalog_variant_missing");
  }
  if (configuration.productVariantId !== null && configuration.catalogVariantId !== null
    && configuration.productVariantId !== configuration.catalogVariantId) {
    reasons.push("catalog_variant_identity_conflict");
  }
  if (reasons.length > 0) {
    return Object.freeze({ status: "conflict", reasons: Object.freeze(reasons) });
  }

  const shippingFacts: Array<readonly [string, boolean]> = [
    ["wms", configuration.wmsRequiresShipping === 1],
  ];
  if (configuration.omsRequiresShipping !== null) {
    shippingFacts.push(["oms", configuration.omsRequiresShipping]);
  }
  if (configuration.catalogVariantId !== null) {
    shippingFacts.push(["catalog", configuration.catalogRequiresShipping === true]);
  }
  if (new Set(shippingFacts.map(([, value]) => value)).size > 1) {
    return Object.freeze({
      status: "conflict",
      reasons: Object.freeze(shippingFacts.map(([owner, value]) => `${owner}_requires_shipping_${value}`)),
    });
  }
  if (shippingFacts[0]![1] === false) {
    return Object.freeze({
      status: "resolved",
      requiresInventoryPosting: false,
      reason: "non_shipping_item",
    });
  }
  const omsTracking = configuration.omsInventoryTracking ?? null;
  const wmsTracking = configuration.wmsInventoryTracking ?? null;
  if (omsTracking !== wmsTracking || ((omsTracking !== null || wmsTracking !== null)
    && (!configuration.omsCatalogProductId || configuration.omsCatalogProductId !== configuration.wmsCatalogProductId))) {
    return Object.freeze({ status: "conflict", reasons: Object.freeze(["inventory_policy_snapshot_conflict"]) });
  }
  if (omsTracking === false) {
    return Object.freeze({ status: "resolved", requiresInventoryPosting: false, reason: "non_inventory_item" });
  }
  if (omsTracking === true && configuration.catalogTrackInventory === false) {
    return Object.freeze({ status: "conflict", reasons: Object.freeze(["catalog_inventory_policy_changed"]) });
  }
  // The catalog's historical NULL value retains its established meaning of
  // inventory-tracked. Only an explicit false disables inventory movement.
  if (configuration.catalogVariantId !== null
    && configuration.catalogTrackInventory === false) {
    return Object.freeze({
      status: "resolved",
      requiresInventoryPosting: false,
      reason: "non_inventory_item",
    });
  }
  return Object.freeze({
    status: "resolved",
    requiresInventoryPosting: true,
    reason: "tracked_physical_item",
  });
}
