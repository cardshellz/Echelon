import type { DropshipListingAccessResolution } from "../../../../shared/dropship/listing-access";
import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
import { listingIntentDestinationSchema } from "../../../../shared/listing-intent-propagation";
export const intentDestinationSchema = listingIntentDestinationSchema;
export type IntentDestination = z.infer<typeof intentDestinationSchema>;
export interface IntentChange {
  id: string;
  sourceRelation: string;
  sourceKind: string;
  changedFields: string[];
  operation: "INSERT" | "UPDATE" | "DELETE";
  beforeScope: Record<string, unknown> | null;
  afterScope: Record<string, unknown> | null;
}
export interface IntentDelivery {
  id: string;
  changeId: string;
  destination: IntentDestination;
  productId: number;
  variantIds: number[];
  commandKey: string;
  leaseToken: string;
  change: IntentChange;
  changes: IntentChange[];
}
export type IntentHandoff =
  | {
      state: "delivered";
      receipt: {
        owner: "ebay_listing_sync" | "dropship_listing_push";
        operationId: string;
        commandKey: string;
      };
    }
  | {
      state: "needs_review" | "blocked";
      code: string;
      message: string;
      resolution?: DropshipListingAccessResolution;
    };

export interface IntentSelector {
  channelId?: number;
  storeConnectionId?: number;
  provider?: string;
  environment?: string;
  productId?: number;
  variantId?: number;
  assetId?: number;
  productType?: string;
  categoryId?: number;
  retailCacheId?: string;
  retailSku?: string;
}

/** Old and new scopes are source facts. Eligibility, prices, media and policies
 * are deliberately resolved by the existing source/execution owners. */
export function intentSelectors(change: IntentChange): IntentSelector[] {
  return [change.beforeScope, change.afterScope].flatMap((row) => {
    if (!row) return [];
    const selector: IntentSelector = {};
    const positive = (value: unknown): number | undefined => {
      const parsed = id.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    };
    selector.channelId = positive(row.channel_id);
    selector.storeConnectionId = positive(row.store_connection_id);
    if (change.sourceRelation.startsWith("ebay.")) selector.provider = "ebay";
    if (
      change.sourceRelation === "ebay.ebay_oauth_tokens" &&
      typeof row.environment === "string"
    )
      selector.environment = row.environment;
    switch (change.sourceKind) {
      case "product":
        selector.productId = positive(row.product_id ?? row.id);
        if (!selector.productId) return [];
        break;
      case "variant":
        selector.variantId = positive(row.product_variant_id ?? row.id);
        // A moved Catalog size invalidates both product aggregates.
        selector.productId = positive(row.product_id);
        if (!selector.variantId && !selector.productId) return [];
        break;
      case "asset":
        selector.productId = positive(row.product_id);
        if (!selector.variantId && !selector.productId) return [];
        break;
      case "asset_override":
        selector.assetId = positive(row.product_asset_id);
        if (!selector.assetId) return [];
        break;
      case "product_type":
        selector.productType =
          typeof row.product_type_slug === "string"
            ? row.product_type_slug
            : undefined;
        if (!selector.productType) return [];
        break;
      case "category":
        selector.categoryId = positive(row.category_id);
        if (!selector.categoryId) return [];
        break;
      case "retail_cache":
        selector.retailCacheId =
          typeof row.id === "string" || typeof row.id === "number"
            ? String(row.id)
            : undefined;
        selector.retailSku = typeof row.sku === "string" ? row.sku : undefined;
        break;
      case "price_rule":
        if (row.scope === "product")
          selector.productId = positive(Number(row.scope_id));
        else if (row.scope === "variant")
          selector.variantId = positive(Number(row.scope_id));
        else if (row.scope === "category" && typeof row.scope_id === "string")
          selector.productType = row.scope_id;
        else if (row.scope !== "channel") return [];
        if (
          row.scope !== "channel" &&
          !selector.productId &&
          !selector.variantId &&
          !selector.productType
        )
          return [];
        break;
      case "connection":
        selector.channelId = positive(row.channel_id);
        break;
      case "store":
        if (change.sourceRelation === "dropship.dropship_store_connections")
          selector.storeConnectionId = positive(row.id);
        if (!selector.storeConnectionId) return [];
        break;
      default:
        throw new Error("Unsupported persisted listing intent source kind.");
    }
    // Malformed or removed scopes never broaden to every publication.
    const scoped =
      selector.productId ||
      selector.variantId ||
      selector.assetId ||
      selector.productType ||
      selector.categoryId ||
      selector.retailCacheId ||
      selector.retailSku ||
      selector.channelId ||
      selector.storeConnectionId;
    return scoped ? [selector] : [];
  });
}

export function intentCommandKey(
  changeId: string,
  destinationKey: string,
  productId: number,
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "listing-intent-v1",
        changeId,
        destinationKey,
        productId,
      ]),
    )
    .digest("hex");
  return (
    hash.slice(0, 8) +
    "-" +
    hash.slice(8, 12) +
    "-5" +
    hash.slice(13, 16) +
    "-a" +
    hash.slice(17, 20) +
    "-" +
    hash.slice(20, 32)
  );
}
export function intentNeedsReview(change: IntentChange): boolean {
  // Scope columns on an override INSERT identify its recipient; they do not
  // themselves change Catalog membership or provider identity.
  const fieldsBySource: Record<string, readonly string[]> = {
    "catalog.products": [
      "product_type",
      "category",
      "category_id",
      "ebay_browse_category_id",
    ],
    "catalog.product_variants": ["sku", "product_id"],
    "channels.channel_product_overrides": [
      "marketplace_category_id",
      "category_override",
      "listing_format",
      "condition_id",
    ],
    "channels.channel_variant_overrides": ["sku_override"],
    "ebay.ebay_category_mappings": ["ebay_browse_category_id"],
    "ebay.ebay_oauth_tokens": [
      "external_account_id",
      "environment",
      "external_account_verified_at",
      "external_account_identity_scheme",
    ],
    "dropship.dropship_store_connections": [
      "platform",
      "external_account_id",
      "provider_environment",
      "external_account_verified_at",
      "external_account_identity_scheme",
    ],
    "channels.walmart_connections": [
      "partner_id",
      "environment",
      "ship_node_id",
      "warehouse_id",
      "revision",
    ],
  };
  const structuralFields = fieldsBySource[change.sourceRelation] ?? [];
  return change.changedFields.some((field) => structuralFields.includes(field));
}
