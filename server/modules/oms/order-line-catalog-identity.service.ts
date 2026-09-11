import {
  orderLineIdentityInputSchema, selectOrderLineCatalogIdentity, OrderLineIdentityError,
  type OrderLineIdentityInput, type ResolvedOrderLineIdentity,
} from "./domain/order-line-catalog-identity";
import { createOrderLineCatalogIdentityRepository, type CatalogIdentityDatabase } from "./infrastructure/order-line-catalog-identity.repository";
import { omsOrderEvents } from "@shared/schema";
import type { db } from "../../db";

/** Shared by initial ingest, replay, and order-update handlers; reads use the caller's transaction. */
export async function resolveOrderLineCatalogIdentity(
  database: CatalogIdentityDatabase, rawInput: OrderLineIdentityInput,
): Promise<ResolvedOrderLineIdentity | null> {
  const parsed = orderLineIdentityInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new OrderLineIdentityError("ORDER_LINE_IDENTITY_INVALID", "Order line identity is malformed", { channelId: rawInput.channelId });
  const input = parsed.data;
  const repository = createOrderLineCatalogIdentityRepository(database);
  const channel = input.externalVariantId ? await repository.byChannelVariant(input.channelId, input.externalVariantId) : [];
  const bySku = input.sku ? await repository.bySku(input.sku.toUpperCase()) : [];
  const identity = selectOrderLineCatalogIdentity(input, channel, bySku);
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
    previousVariantId: number | null; identity: ResolvedOrderLineIdentity | null;
    source: OrderLineIdentityInput; sourceEventId?: string | null },
): Promise<void> {
  if (!input.identity || input.previousVariantId === input.identity.id) return;
  await database.insert(omsOrderEvents).values({
    orderId: input.orderId,
    eventType: "line_catalog_identity_resolved",
    details: {
      orderLineId: input.orderLineId, channelId: input.channelId,
      previousVariantId: input.previousVariantId, productVariantId: input.identity.id,
      matchedBy: input.identity.matchedBy, sourceEventId: input.sourceEventId ?? null,
      externalVariantId: input.source.externalVariantId ?? null,
      externalProductId: input.source.externalProductId ?? null,
      sourceSku: input.source.sku ?? null, catalogSku: input.identity.sku,
    },
  });
}
