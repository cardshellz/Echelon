import {
  orderLineIdentityInputSchema, selectOrderLineCatalogIdentity, OrderLineIdentityError,
  type OrderLineIdentityInput, type ResolvedCatalogOrderLineIdentity,
} from "./domain/order-line-catalog-identity";
import { createOrderLineCatalogIdentityRepository, type CatalogIdentityDatabase } from "./infrastructure/order-line-catalog-identity.repository";
import { omsOrderEvents } from "@shared/schema";
import type { db } from "../../db";

/** Shared by initial ingest, replay, and order-update handlers; reads use the caller's transaction. */
export async function resolveOrderLineCatalogIdentity(
  database: CatalogIdentityDatabase, rawInput: OrderLineIdentityInput,
): Promise<ResolvedCatalogOrderLineIdentity | null> {
  const parsed = orderLineIdentityInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new OrderLineIdentityError("ORDER_LINE_IDENTITY_INVALID", "Order line identity is malformed", { channelId: rawInput.channelId });
  const input = parsed.data;
  const repository = createOrderLineCatalogIdentityRepository(database);
  const channel = input.externalVariantId ? await repository.byChannelVariant(input.channelId, input.externalVariantId) : [];
  const productCandidates = input.externalProductId
    ? await repository.byChannelProduct(input.channelId, input.externalProductId) : [];
  const product = productCandidates[0];
  if (productCandidates.length > 1 || (product && channel.some(variant => variant.productId !== product.productId))) {
    throw new OrderLineIdentityError("ORDER_LINE_PRODUCT_IDENTITY_CONFLICT", "Channel product and variant identities disagree", { channelId: input.channelId });
  }
  if (channel.length === 0 && product && !product.hasVariants) {
    if (!product.isActive || input.previousVariantId != null
      || (input.previousProductId != null && input.previousProductId !== product.productId)) {
      throw new OrderLineIdentityError("ORDER_LINE_IDENTITY_CHANGE_REQUIRES_REVIEW", "Product identity requires review", { channelId: input.channelId });
    }
    // Verified channel product identity wins over a reused source SKU. No variant is invented.
    return { id: null, productId: product.productId, sku: product.sku, isActive: product.isActive,
      compareAtPriceCents: null, inventoryTracking: product.inventoryTracking, matchedBy: "channel_product_id" };
  }
  const bySku = input.sku ? await repository.bySku(input.sku.toUpperCase(), input.channelId) : [];
  const identity = selectOrderLineCatalogIdentity(input, channel, bySku);
  if (product && identity && identity.productId !== product.productId) {
    throw new OrderLineIdentityError("ORDER_LINE_PRODUCT_IDENTITY_CONFLICT", "Resolved variant belongs to a different channel product", { channelId: input.channelId });
  }
  if (!identity && input.externalVariantId) {
    console.warn(JSON.stringify({ code: "ORDER_LINE_IDENTITY_UNRESOLVED", channelId: input.channelId,
      externalVariantId: input.externalVariantId, sourceSkuPresent: Boolean(input.sku) }));
  }
  return identity;
}

/** Caller holds the OMS line lock (or just inserted it), making transition-only events replay-safe. */
export async function recordOrderLineCatalogIdentity(
  database: Pick<typeof db, "insert">,
  input: { orderId: number; orderLineId: number; channelId: number;
    previousVariantId: number | null; previousProductId?: number | null; identity: ResolvedCatalogOrderLineIdentity | null;
    source: OrderLineIdentityInput; sourceEventId?: string | null },
): Promise<void> {
  if (!input.identity || (input.previousVariantId === input.identity.id
    && (input.identity.id !== null || input.previousProductId === input.identity.productId))) return;
  await database.insert(omsOrderEvents).values({
    orderId: input.orderId,
    eventType: "line_catalog_identity_resolved",
    details: {
      orderLineId: input.orderLineId, channelId: input.channelId,
      previousVariantId: input.previousVariantId, productVariantId: input.identity.id,
      catalogProductId: input.identity.productId ?? null, inventoryTracking: input.identity.inventoryTracking ?? null,
      matchedBy: input.identity.matchedBy, sourceEventId: input.sourceEventId ?? null,
      externalVariantId: input.source.externalVariantId ?? null,
      externalProductId: input.source.externalProductId ?? null,
      sourceSku: input.source.sku ?? null, catalogSku: input.identity.sku,
    },
  });
}

/** Catalog settings affect new lines; replay cannot rewrite an established inventory policy. */
export function orderLineInventoryIdentitySnapshot(
  identity: ResolvedCatalogOrderLineIdentity | null,
  previous?: { catalogProductId?: number | null; inventoryTracking?: boolean | null },
): { catalogProductId: number | null; inventoryTracking: boolean | null } {
  // Legacy lines have no policy snapshot. Replaying their source must not add one
  // while an already-materialized WMS line still has the historical NULL policy.
  if (previous) return {
    catalogProductId: previous.catalogProductId ?? null,
    inventoryTracking: previous.inventoryTracking ?? null,
  };
  return {
    catalogProductId: identity?.productId ?? null,
    inventoryTracking: identity?.inventoryTracking ?? null,
  };
}
