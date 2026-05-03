import { DropshipError } from "../domain/errors";
import type { RecordDropshipOrderIntakeInput } from "../application/dropship-order-intake-service";

export interface ShopifyDropshipOrderIntakeStoreContext {
  vendorId: number;
  storeConnectionId: number;
}

type ShopifyOrderPayload = Record<string, unknown>;

const SHOPIFY_ORDER_GID_PREFIX = "gid://shopify/Order/";
const SHOPIFY_LINE_ITEM_GID_PREFIX = "gid://shopify/LineItem/";
const SHOPIFY_PRODUCT_GID_PREFIX = "gid://shopify/Product/";
const SHOPIFY_PRODUCT_VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/";

export function buildShopifyDropshipOrderIntakeInput(input: {
  store: ShopifyDropshipOrderIntakeStoreContext;
  order: ShopifyOrderPayload;
}): RecordDropshipOrderIntakeInput {
  const externalOrderId = readShopifyOrderGid(input.order);
  const sourceOrderId = readOptionalId(input.order.id);
  const externalOrderNumber = readOptionalString(input.order.name)
    ?? readOptionalString(input.order.order_number);

  return {
    vendorId: input.store.vendorId,
    storeConnectionId: input.store.storeConnectionId,
    platform: "shopify",
    externalOrderId,
    externalOrderNumber: externalOrderNumber ?? undefined,
    sourceOrderId: sourceOrderId ?? undefined,
    rawPayload: input.order,
    normalizedPayload: {
      lines: buildShopifyDropshipOrderLines(input.order),
      shipTo: buildShopifyShipTo(input.order),
      totals: buildShopifyTotals(input.order),
      orderedAt: readShopifyOrderedAt(input.order),
      marketplaceStatus: readOptionalString(input.order.financial_status)
        ?? readOptionalString(input.order.fulfillment_status)
        ?? undefined,
    },
    idempotencyKey: `dropship:shopify:intake:${input.store.storeConnectionId}:${externalOrderId}`,
  };
}

export function shouldRecordShopifyDropshipOrder(input: {
  order: ShopifyOrderPayload;
  requirePaid: boolean;
}): { record: true } | { record: false; reason: string } {
  if (readOptionalString(input.order.cancelled_at)) {
    return { record: false, reason: "order_cancelled" };
  }
  if (input.requirePaid) {
    const financialStatus = readOptionalString(input.order.financial_status)?.toLowerCase();
    if (financialStatus !== "paid" && financialStatus !== "partially_paid") {
      return { record: false, reason: "order_not_paid" };
    }
  }
  return { record: true };
}

export function parseShopifyMoneyCents(value: unknown, field: string): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_MONEY_INVALID",
      "Shopify order money value must be a non-negative decimal with at most two fractional digits.",
      { field, value, retryable: false },
    );
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_MONEY_UNSAFE",
      "Shopify order money value is outside the safe integer range.",
      { field, value, retryable: false },
    );
  }
  return cents;
}

function buildShopifyDropshipOrderLines(order: ShopifyOrderPayload): RecordDropshipOrderIntakeInput["normalizedPayload"]["lines"] {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (lineItems.length === 0) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_LINES_REQUIRED",
      "Shopify dropship order intake requires at least one line item.",
      { externalOrderId: readOptionalString(order.admin_graphql_api_id) ?? readOptionalString(order.id), retryable: false },
    );
  }

  return lineItems.map((rawLine, index) => {
    if (!isRecord(rawLine)) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_ORDER_LINE_INVALID",
        "Shopify dropship order line item must be an object.",
        { lineIndex: index, retryable: false },
      );
    }
    const quantity = readPositiveInteger(rawLine.quantity, `line_items.${index}.quantity`);
    const lineItemId = readRequiredId(rawLine.admin_graphql_api_id ?? rawLine.id, `line_items.${index}.id`);
    const productId = readOptionalId(rawLine.product_id);
    const variantId = readOptionalId(rawLine.variant_id);
    return {
      externalLineItemId: lineItemId.startsWith(SHOPIFY_LINE_ITEM_GID_PREFIX)
        ? lineItemId
        : `${SHOPIFY_LINE_ITEM_GID_PREFIX}${lineItemId}`,
      externalListingId: productId ? `${SHOPIFY_PRODUCT_GID_PREFIX}${productId}` : undefined,
      externalOfferId: variantId ? `${SHOPIFY_PRODUCT_VARIANT_GID_PREFIX}${variantId}` : undefined,
      sku: readOptionalString(rawLine.sku) ?? undefined,
      quantity,
      unitRetailPriceCents: parseShopifyMoneyCents(rawLine.price, `line_items.${index}.price`),
      title: readOptionalString(rawLine.title)
        ?? readOptionalString(rawLine.name)
        ?? `Shopify line ${lineItemId}`,
    };
  });
}

function buildShopifyShipTo(order: ShopifyOrderPayload): RecordDropshipOrderIntakeInput["normalizedPayload"]["shipTo"] {
  const shipping = isRecord(order.shipping_address) ? order.shipping_address : {};
  const customer = isRecord(order.customer) ? order.customer : {};
  const country = readOptionalString(shipping.country_code);
  const customerName = [readOptionalString(customer.first_name), readOptionalString(customer.last_name)]
    .filter(Boolean)
    .join(" ");
  return {
    name: readOptionalString(shipping.name)
      ?? readOptionalString(customerName)
      ?? undefined,
    company: readOptionalString(shipping.company) ?? undefined,
    address1: readOptionalString(shipping.address1) ?? undefined,
    address2: readOptionalString(shipping.address2) ?? undefined,
    city: readOptionalString(shipping.city) ?? undefined,
    region: readOptionalString(shipping.province_code) ?? readOptionalString(shipping.province) ?? undefined,
    postalCode: readOptionalString(shipping.zip) ?? undefined,
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined,
    phone: readOptionalString(shipping.phone) ?? readOptionalString(order.phone) ?? undefined,
    email: readOptionalString(order.email)
      ?? readOptionalString(order.contact_email)
      ?? readOptionalString(customer.email)
      ?? undefined,
  };
}

function buildShopifyTotals(order: ShopifyOrderPayload): RecordDropshipOrderIntakeInput["normalizedPayload"]["totals"] {
  return {
    retailSubtotalCents: parseShopifyMoneyCents(order.subtotal_price, "subtotal_price"),
    shippingPaidCents: sumShopifyShippingCents(order),
    taxCents: parseShopifyMoneyCents(order.total_tax, "total_tax"),
    discountCents: parseShopifyMoneyCents(order.total_discounts, "total_discounts"),
    grandTotalCents: parseShopifyMoneyCents(order.total_price, "total_price"),
    currency: (readOptionalString(order.currency) ?? "USD").toUpperCase(),
  };
}

function sumShopifyShippingCents(order: ShopifyOrderPayload): number {
  const shippingLines = Array.isArray(order.shipping_lines) ? order.shipping_lines : [];
  let total = 0;
  for (let index = 0; index < shippingLines.length; index += 1) {
    const line = shippingLines[index];
    if (!isRecord(line)) continue;
    total += parseShopifyMoneyCents(line.price, `shipping_lines.${index}.price`);
  }
  if (!Number.isSafeInteger(total)) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_SHIPPING_TOTAL_UNSAFE",
      "Shopify order shipping total is outside the safe integer range.",
      { retryable: false },
    );
  }
  return total;
}

function readShopifyOrderGid(order: ShopifyOrderPayload): string {
  const gid = readOptionalString(order.admin_graphql_api_id);
  if (gid) {
    if (!gid.startsWith(SHOPIFY_ORDER_GID_PREFIX)) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_ORDER_GID_INVALID",
        "Shopify order admin_graphql_api_id must be an Order GID.",
        { adminGraphqlApiId: gid, retryable: false },
      );
    }
    return gid;
  }
  const id = readRequiredId(order.id, "id");
  return `${SHOPIFY_ORDER_GID_PREFIX}${id}`;
}

function readShopifyOrderedAt(order: ShopifyOrderPayload): string | undefined {
  const orderedAt = readOptionalString(order.processed_at)
    ?? readOptionalString(order.created_at);
  if (!orderedAt) {
    return undefined;
  }
  const parsed = new Date(orderedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDERED_AT_INVALID",
      "Shopify order timestamp is invalid.",
      { orderedAt, retryable: false },
    );
  }
  return parsed.toISOString();
}

function readRequiredId(value: unknown, field: string): string {
  const id = readOptionalId(value);
  if (!id) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_ID_REQUIRED",
      "Shopify order payload is missing a required identifier.",
      { field, retryable: false },
    );
  }
  return id;
}

function readOptionalId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_QUANTITY_INVALID",
      "Shopify order quantity must be a positive integer.",
      { field, value, retryable: false },
    );
  }
  return parsed;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
