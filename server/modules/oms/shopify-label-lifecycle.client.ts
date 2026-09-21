import type { ShopifyAdminGraphQLClient } from "../shopify/admin-gql-client";
import { ChannelFulfillmentProviderError } from "../channels/channel-fulfillment-provider.error";
import { labelLifecycleConflict, type ShopifyLabelPackage } from "./shopify-label-lifecycle.domain";

interface OrderPackagesResponse {
  order: null | { id: string; fulfillmentsCount: { count: number }; fulfillments: Array<{
    id: string; status: string; trackingInfo: Array<{ number: string | null }>;
  }> };
}
interface LinesResponse {
  fulfillment: null | { id: string; order: { id: string }; fulfillmentLineItems: {
    nodes: Array<{ quantity: number; lineItem: { id: string } }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } };
}

/** Reads only the exact originating order. Incomplete/invalid reads are never
 * interpreted as an absent fulfillment. Line connections are cursor-paginated. */
export async function readShopifyLabelPackages(client: ShopifyAdminGraphQLClient, orderId: string,
  trackingNumber: string, expectedIds: readonly string[]): Promise<readonly ShopifyLabelPackage[]> {
  const response = await client.request<OrderPackagesResponse>(`query labelLifecyclePackages($id: ID!) {
    order(id: $id) { id fulfillmentsCount { count } fulfillments(first: 100) {
      id status trackingInfo(first: 100) { number }
    } }
  }`, { id: orderId });
  if (!response.order || response.order.id !== orderId || !Array.isArray(response.order.fulfillments)
    || !Number.isSafeInteger(response.order.fulfillmentsCount?.count)
    || response.order.fulfillmentsCount.count !== response.order.fulfillments.length) {
    labelLifecycleConflict("SHOPIFY_VOID_ORDER_READ_INCOMPLETE");
  }
  const result: ShopifyLabelPackage[] = [];
  for (const fulfillment of response.order.fulfillments) {
    if (!Array.isArray(fulfillment.trackingInfo)) labelLifecycleConflict("SHOPIFY_VOID_TRACKING_READ_INVALID");
    const trackingNumbers = fulfillment.trackingInfo.map(value => value.number ?? "");
    if (!expectedIds.includes(fulfillment.id) && !trackingNumbers.includes(trackingNumber)) continue;
    const items: ShopifyLabelPackage["items"] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const page: LinesResponse = await client.request<LinesResponse>(`query labelLifecycleLines($id: ID!, $after: String) {
        fulfillment(id: $id) { id order { id } fulfillmentLineItems(first: 250, after: $after) {
          nodes { quantity lineItem { id } } pageInfo { hasNextPage endCursor }
        } }
      }`, { id: fulfillment.id, after: cursor });
      const value = page.fulfillment;
      if (!value || value.id !== fulfillment.id || value.order?.id !== orderId
        || !Array.isArray(value.fulfillmentLineItems?.nodes)
        || typeof value.fulfillmentLineItems.pageInfo?.hasNextPage !== "boolean") {
        labelLifecycleConflict("SHOPIFY_VOID_LINES_READ_INVALID");
      }
      items.push(...value.fulfillmentLineItems.nodes.map(item => ({ lineId: item.lineItem?.id, quantity: item.quantity })));
      if (!value.fulfillmentLineItems.pageInfo.hasNextPage) break;
      cursor = value.fulfillmentLineItems.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor) || cursors.size >= 100) labelLifecycleConflict("SHOPIFY_VOID_LINES_READ_INCOMPLETE");
      cursors.add(cursor);
    }
    result.push({ id: fulfillment.id, status: fulfillment.status, trackingNumbers, items });
  }
  return result;
}

export async function cancelExactShopifyLabelPackage(client: ShopifyAdminGraphQLClient, fulfillmentId: string): Promise<void> {
  const response = await client.request<{ fulfillmentCancel: null | {
    fulfillment: null | { id: string; status: string }; userErrors: readonly { message: string }[];
  } }>(`mutation cancelVoidedLabelPackage($id: ID!) {
    fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { field message } }
  }`, { id: fulfillmentId });
  const payload = response.fulfillmentCancel;
  // No text matching for 'already cancelled': the next attempt proves it by readback.
  if (!payload || !Array.isArray(payload.userErrors)) throw new ChannelFulfillmentProviderError(
    "SHOPIFY_VOID_RESPONSE_INVALID", "Shopify cancellation returned no valid result", "transient");
  if (payload.userErrors.length > 0) throw new ChannelFulfillmentProviderError(
    "SHOPIFY_VOID_CANCEL_REJECTED", "Shopify rejected the exact package cancellation", "transient");
  if (payload.fulfillment?.id !== fulfillmentId || payload.fulfillment.status !== "CANCELLED") {
    throw new ChannelFulfillmentProviderError("SHOPIFY_VOID_NOT_CONFIRMED", "Shopify cancellation was not confirmed", "transient");
  }
}
