import {
  createDefaultShopifyAdminClient,
  type ShopifyAdminGraphQLClient,
} from "../shopify/admin-gql-client";

const MAX_FULFILLMENTS_PER_ORDER = 250;
const MAX_LINES_PER_FULFILLMENT = 250;
const MAX_TRACKING_NUMBERS_PER_FULFILLMENT = 10;

interface ShopifySnapshotResponse {
  order?: {
    id?: string | null;
    fulfillmentsCount?: { count?: number | null } | null;
    fulfillments?: Array<{
      id?: string | null;
      status?: string | null;
      trackingInfo?: Array<{ number?: string | null }> | null;
      fulfillmentLineItems?: {
        nodes?: Array<{
          id?: string | null;
          quantity?: number | null;
          lineItem?: { id?: string | null } | null;
        }> | null;
        pageInfo?: { hasNextPage?: boolean | null } | null;
      } | null;
    }> | null;
  } | null;
}

export interface ShopifyFulfillmentSnapshotItem {
  readonly sourceFulfillmentLineId: string;
  readonly channelOrderLineId: string;
  readonly quantity: number;
}

export interface ShopifyFulfillmentSnapshotPackage {
  readonly sourceFulfillmentId: string;
  readonly trackingNumbers: readonly string[];
  readonly items: readonly ShopifyFulfillmentSnapshotItem[];
}

export interface ShopifyFulfillmentSnapshot {
  readonly sourceOrderId: string;
  readonly observedAt: Date;
  readonly complete: boolean;
  readonly packages: readonly ShopifyFulfillmentSnapshotPackage[];
  readonly incompleteReasons: readonly string[];
}

export interface ShopifyFulfillmentSnapshotOrder {
  readonly external_order_id: string;
}

function normalizeShopifyResourceId(value: unknown): string | null {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  const gidMatch = /^gid:\/\/shopify\/[^/]+\/(\d+)$/.exec(text);
  return gidMatch?.[1] ?? text;
}

function normalizeTrackingNumber(value: unknown): string | null {
  const normalized = value == null
    ? ""
    : String(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized || null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function shopifyOrderGid(externalOrderId: string): string {
  const normalized = externalOrderId.trim();
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(normalized)) return normalized;
  if (/^\d+$/.test(normalized)) return `gid://shopify/Order/${normalized}`;
  throw new Error(`Invalid Shopify order identity: ${externalOrderId}`);
}

export class ShopifyFulfillmentSnapshotReader {
  constructor(
    private readonly client: ShopifyAdminGraphQLClient = createDefaultShopifyAdminClient(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetch(
    order: ShopifyFulfillmentSnapshotOrder,
  ): Promise<ShopifyFulfillmentSnapshot> {
    const sourceOrderId = normalizeShopifyResourceId(order.external_order_id);
    if (!sourceOrderId || !/^\d+$/.test(sourceOrderId)) {
      throw new Error(`Invalid Shopify external order id: ${order.external_order_id}`);
    }

    const response = await this.client.request<ShopifySnapshotResponse>(
      `
        query fulfillmentEvidenceForOrder($id: ID!) {
          order(id: $id) {
            id
            fulfillmentsCount { count }
            fulfillments(first: ${MAX_FULFILLMENTS_PER_ORDER}) {
              id
              status
              trackingInfo(first: ${MAX_TRACKING_NUMBERS_PER_FULFILLMENT}) {
                number
              }
              fulfillmentLineItems(first: ${MAX_LINES_PER_FULFILLMENT}) {
                nodes {
                  id
                  quantity
                  lineItem {
                    id
                  }
                }
                pageInfo {
                  hasNextPage
                }
              }
            }
          }
        }
      `,
      { id: shopifyOrderGid(sourceOrderId) },
    );

    const observedAt = this.now();
    if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
      throw new Error("Shopify fulfillment snapshot clock returned an invalid Date");
    }

    const incompleteReasons = new Set<string>();
    const responseOrderId = normalizeShopifyResourceId(response.order?.id);
    if (!responseOrderId || responseOrderId !== sourceOrderId) {
      incompleteReasons.add("shopify_order_not_found_or_identity_mismatch");
    }

    const fulfillments = response.order?.fulfillments ?? [];
    const fulfillmentCount = nonNegativeInteger(
      response.order?.fulfillmentsCount?.count,
    );
    if (fulfillmentCount === null || fulfillmentCount !== fulfillments.length) {
      incompleteReasons.add("shopify_fulfillment_snapshot_truncated_or_count_missing");
    }

    const packages: ShopifyFulfillmentSnapshotPackage[] = [];
    const fulfillmentIds = new Set<string>();
    for (const fulfillment of fulfillments) {
      if (String(fulfillment.status ?? "").trim().toLowerCase() !== "success") {
        continue;
      }
      const sourceFulfillmentId = normalizeShopifyResourceId(fulfillment.id);
      if (!sourceFulfillmentId || fulfillmentIds.has(sourceFulfillmentId)) {
        incompleteReasons.add("shopify_fulfillment_identity_invalid_or_duplicate");
        continue;
      }
      fulfillmentIds.add(sourceFulfillmentId);

      const lineConnection = fulfillment.fulfillmentLineItems;
      if (lineConnection?.pageInfo?.hasNextPage) {
        incompleteReasons.add(`shopify_fulfillment_lines_truncated:${sourceFulfillmentId}`);
      }
      const items: ShopifyFulfillmentSnapshotItem[] = [];
      const sourceLineIds = new Set<string>();
      for (const line of lineConnection?.nodes ?? []) {
        const sourceFulfillmentLineId = normalizeShopifyResourceId(line.id);
        const channelOrderLineId = normalizeShopifyResourceId(line.lineItem?.id);
        const quantity = positiveInteger(line.quantity);
        if (
          !sourceFulfillmentLineId
          || !channelOrderLineId
          || !quantity
          || sourceLineIds.has(sourceFulfillmentLineId)
        ) {
          incompleteReasons.add(`shopify_fulfillment_line_invalid:${sourceFulfillmentId}`);
          continue;
        }
        sourceLineIds.add(sourceFulfillmentLineId);
        items.push(Object.freeze({
          sourceFulfillmentLineId,
          channelOrderLineId,
          quantity,
        }));
      }
      if (items.length === 0) {
        incompleteReasons.add(`shopify_fulfillment_has_no_valid_lines:${sourceFulfillmentId}`);
      }

      const trackingNumbers = [
        ...new Set(
          (fulfillment.trackingInfo ?? [])
            .map((tracking) => normalizeTrackingNumber(tracking.number))
            .filter((tracking): tracking is string => tracking !== null),
        ),
      ];
      packages.push(Object.freeze({
        sourceFulfillmentId,
        trackingNumbers: Object.freeze(trackingNumbers),
        items: Object.freeze(items),
      }));
    }

    return Object.freeze({
      sourceOrderId,
      observedAt,
      complete: incompleteReasons.size === 0,
      packages: Object.freeze(packages),
      incompleteReasons: Object.freeze([...incompleteReasons].sort()),
    });
  }
}
