import { DropshipError } from "../domain/errors";
import type {
  DropshipReturnIntakeDraft,
  DropshipReturnIntakeItemDraft,
  DropshipReturnIntakeTrackingDraft,
} from "../application/dropship-return-intake-provider";

/**
 * Shopify Admin API return → normalized RMA draft (design spec D2a).
 *
 * Source: GraphQL Admin API `returns` query on the connected store. A Shopify
 * Return carries the order reference, return line items, and (when the vendor
 * bought the return label via Shopify Shipping) the reverse fulfillment
 * order's label + tracking. The return EVENT is always visible regardless of
 * label provenance; labelCostCents is null when Shopify doesn't expose it
 * (best-effort, D2a).
 *
 * GIDs are kept verbatim as channel ids — they are stable and unique per
 * shop, which is what the (store connection, channel return id) dedupe key
 * needs.
 */

export interface ShopifyReturnNode {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  createdAt?: unknown;
  order?: { id?: unknown; legacyResourceId?: unknown; name?: unknown } | null;
  returnLineItems?: {
    nodes?: Array<{
      id?: unknown;
      quantity?: unknown;
      returnReason?: unknown;
      returnReasonNote?: unknown;
      fulfillmentLineItem?: {
        lineItem?: {
          id?: unknown;
          sku?: unknown;
        } | null;
      } | null;
    }>;
  } | null;
  reverseFulfillmentOrders?: {
    nodes?: Array<{
      id?: unknown;
      status?: unknown;
      label?: {
        cost?: { amount?: unknown; currencyCode?: unknown } | null;
        trackingNumber?: unknown;
        trackingUrl?: unknown;
      } | null;
      deliverable?: {
        tracking?: {
          number?: unknown;
          carrierName?: unknown;
          url?: unknown;
        } | null;
      } | null;
    }>;
  } | null;
  [key: string]: unknown;
}

const SHOPIFY_RETURN_GID_PREFIX = "gid://shopify/Return/";
const SHOPIFY_ORDER_GID_PREFIX = "gid://shopify/Order/";

/** Shopify return statuses that represent a real return event for us. */
const SHOPIFY_RECORDED_RETURN_STATUSES = new Set([
  "OPEN",
  "CLOSED",
  "PROCESSING",
]);

export function shouldRecordShopifyReturn(input: {
  returnNode: ShopifyReturnNode;
}): { record: true } | { record: false; reason: string } {
  const status = readOptionalString(input.returnNode.status)?.toUpperCase();
  if (status === "DECLINED" || status === "CANCELED" || status === "CANCELLED") {
    return { record: false, reason: `shopify_return_status_${status.toLowerCase()}` };
  }
  if (status && !SHOPIFY_RECORDED_RETURN_STATUSES.has(status)) {
    return { record: false, reason: `shopify_return_status_${status.toLowerCase()}` };
  }
  return { record: true };
}

export function buildShopifyReturnIntakeDraft(input: {
  returnNode: ShopifyReturnNode;
}): DropshipReturnIntakeDraft {
  const channelReturnId = readRequiredGid(input.returnNode.id, "id");
  const orderGid = readOptionalString(input.returnNode.order?.id);
  const orderRef = orderGid
    ?? readOptionalString(input.returnNode.order?.legacyResourceId);
  if (!orderRef) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_RETURN_ORDER_REF_MISSING",
      "Shopify return is missing its order reference.",
      { returnId: channelReturnId, retryable: false },
    );
  }

  const items = buildShopifyReturnItems(input.returnNode);
  if (items.length === 0) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_RETURN_ITEMS_MISSING",
      "Shopify return has no mappable return line items.",
      { returnId: channelReturnId, retryable: false },
    );
  }

  const label = findShopifyReturnLabel(input.returnNode);
  const labelCostCents = label?.costCents ?? null;
  const reasonText = readShopifyReasonText(input.returnNode);
  const returnTracking = buildShopifyReturnTracking(input.returnNode);

  return {
    channelReturnId,
    orderRef,
    items,
    labelCostCents,
    faultHint: mapShopifyReturnReasonToFaultHint(reasonText),
    reasonText,
    evidence: {
      channel: "shopify",
      returnId: channelReturnId,
      orderRef,
      name: readOptionalString(input.returnNode.name) ?? null,
      status: readOptionalString(input.returnNode.status) ?? null,
      createdAt: readOptionalString(input.returnNode.createdAt) ?? null,
      labelCostCents,
      raw: input.returnNode as Record<string, unknown>,
    },
    returnTracking,
  };
}

function buildShopifyReturnItems(returnNode: ShopifyReturnNode): DropshipReturnIntakeItemDraft[] {
  const nodes = returnNode.returnLineItems?.nodes;
  if (!Array.isArray(nodes)) return [];
  const items: DropshipReturnIntakeItemDraft[] = [];
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== "object") continue;
    const channelLineId = readOptionalString(node.id);
    if (!channelLineId) continue;
    const quantity = readPositiveInteger(node.quantity);
    if (!quantity) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_RETURN_ITEM_QTY_INVALID",
        "Shopify return line item has no positive quantity.",
        { lineIndex: index, channelLineId, retryable: false },
      );
    }
    items.push({
      channelLineId,
      externalLineItemId: readOptionalString(node.fulfillmentLineItem?.lineItem?.id) ?? null,
      sku: readOptionalString(node.fulfillmentLineItem?.lineItem?.sku) ?? null,
      quantity,
    });
  }
  return items;
}

function findShopifyReturnLabel(
  returnNode: ShopifyReturnNode,
): { costCents: number | null; trackingNumber: string | null } | null {
  const nodes = returnNode.reverseFulfillmentOrders?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const amount = node.label?.cost?.amount;
    const trackingNumber = readOptionalString(node.label?.trackingNumber)
      ?? readOptionalString(node.deliverable?.tracking?.number)
      ?? null;
    const costCents = amount === null || amount === undefined || amount === ""
      ? null
      : parseShopifyMoneyCents(amount, "reverseFulfillmentOrders.label.cost.amount");
    if (costCents !== null || trackingNumber !== null) {
      return { costCents, trackingNumber };
    }
  }
  return null;
}

function buildShopifyReturnTracking(returnNode: ShopifyReturnNode): DropshipReturnIntakeTrackingDraft | null {
  const nodes = returnNode.reverseFulfillmentOrders?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const trackingNumber = readOptionalString(node.deliverable?.tracking?.number)
      ?? readOptionalString(node.label?.trackingNumber);
    if (!trackingNumber) continue;
    return {
      carrier: readOptionalString(node.deliverable?.tracking?.carrierName) ?? null,
      trackingNumber,
      // Shopify reverse deliveries don't expose an expected delivery date;
      // the no-inspection watcher's timeout path needs one, so leave null —
      // the watcher falls back to carrier-lost-status only for this RMA.
      expectedDeliveryAt: null,
      status: readOptionalString(node.status) ?? null,
    };
  }
  return null;
}

function readShopifyReasonText(returnNode: ShopifyReturnNode): string | null {
  const nodes = returnNode.returnLineItems?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const reason = readOptionalString(node.returnReason);
    const note = readOptionalString(node.returnReasonNote);
    if (reason && note) return `${reason}: ${note}`.slice(0, 1000);
    if (reason) return reason.slice(0, 1000);
    if (note) return note.slice(0, 1000);
  }
  return null;
}

/**
 * Fault hint from the Shopify return reason. Best-effort, never authoritative
 * (D2b: human disposes).
 */
export function mapShopifyReturnReasonToFaultHint(
  reasonText: string | null,
): DropshipReturnIntakeDraft["faultHint"] {
  if (!reasonText) return null;
  const normalized = reasonText.toUpperCase();
  if (
    normalized.includes("DEFECTIVE")
    || normalized.includes("NOT_AS_DESCRIBED")
    || normalized.includes("WRONG_ITEM")
    || normalized.includes("DAMAGED")
  ) {
    return "vendor";
  }
  if (
    normalized.includes("UNWANTED")
    || normalized.includes("SIZE_TOO")
    || normalized.includes("COLOR")
    || normalized.includes("STYLE")
  ) {
    return "customer";
  }
  return null;
}

/**
 * Exact decimal money parsing (no floats, coding standards #3). Shopify
 * money amounts are decimal strings like "12.90".
 */
export function parseShopifyMoneyCents(value: unknown, field: string): number {
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_RETURN_MONEY_INVALID",
      "Shopify money value must be a non-negative decimal with at most two fractional digits.",
      { field, value, retryable: false },
    );
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_RETURN_MONEY_UNSAFE",
      "Shopify money value is outside the safe integer range.",
      { field, value, retryable: false },
    );
  }
  return cents;
}

export function isShopifyReturnGid(value: string): boolean {
  return value.startsWith(SHOPIFY_RETURN_GID_PREFIX);
}

export function isShopifyOrderGid(value: string): boolean {
  return value.startsWith(SHOPIFY_ORDER_GID_PREFIX);
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRequiredGid(value: unknown, field: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_RETURN_FIELD_MISSING",
      `Shopify return is missing required field ${field}.`,
      { field, retryable: false },
    );
  }
  return text;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isInteger(parsed) && (parsed as number) > 0 ? (parsed as number) : null;
}
