import { DropshipError } from "../domain/errors";
import type { RecordDropshipOrderIntakeInput } from "../application/dropship-order-intake-service";
import type { EbayAmount, EbayOrder, EbayOrderLineItem } from "../../channels/adapters/ebay/ebay-types";

export interface EbayDropshipOrderIntakeStoreContext {
  vendorId: number;
  storeConnectionId: number;
}

export function buildEbayDropshipOrderIntakeInput(input: {
  store: EbayDropshipOrderIntakeStoreContext;
  order: EbayOrder;
}): RecordDropshipOrderIntakeInput {
  const externalOrderId = readRequiredString(input.order.orderId, "orderId");
  const externalOrderNumber =
    readOptionalString(input.order.salesRecordReference)
    ?? readOptionalString(input.order.legacyOrderId)
    ?? externalOrderId;

  return {
    vendorId: input.store.vendorId,
    storeConnectionId: input.store.storeConnectionId,
    platform: "ebay",
    externalOrderId,
    externalOrderNumber,
    sourceOrderId: readOptionalString(input.order.legacyOrderId) ?? undefined,
    rawPayload: input.order as unknown as Record<string, unknown>,
    normalizedPayload: {
      lines: buildEbayDropshipOrderLines(input.order),
      shipTo: buildEbayShipTo(input.order),
      totals: buildEbayTotals(input.order),
      orderedAt: readEbayOrderedAt(input.order),
      marketplaceStatus: `${input.order.orderPaymentStatus}:${input.order.orderFulfillmentStatus}`,
    },
    idempotencyKey: `dropship:ebay:intake:${input.store.storeConnectionId}:${externalOrderId}`,
  };
}

export function shouldRecordEbayDropshipOrder(input: {
  order: EbayOrder;
}): { record: true } | { record: false; reason: string } {
  const cancelState = readOptionalString(input.order.cancelStatus?.cancelState)?.toUpperCase();
  if (cancelState === "CANCELED" || cancelState === "CANCELLED") {
    return { record: false, reason: "order_cancelled" };
  }
  if (input.order.orderPaymentStatus !== "PAID") {
    return { record: false, reason: "order_not_paid" };
  }
  if (input.order.orderFulfillmentStatus === "FULFILLED") {
    return { record: false, reason: "order_already_fulfilled" };
  }
  return { record: true };
}

export function parseEbayMoneyCents(value: unknown, field: string): number {
  const raw = isEbayAmount(value) ? value.value : value;
  if (raw === null || raw === undefined || raw === "") {
    return 0;
  }
  const text = String(raw).trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_MONEY_INVALID",
      "eBay order money value must be a non-negative decimal with at most two fractional digits.",
      { field, value: raw, retryable: false },
    );
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_MONEY_UNSAFE",
      "eBay order money value is outside the safe integer range.",
      { field, value: raw, retryable: false },
    );
  }
  return cents;
}

function buildEbayDropshipOrderLines(
  order: EbayOrder,
): RecordDropshipOrderIntakeInput["normalizedPayload"]["lines"] {
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  if (lineItems.length === 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_LINES_REQUIRED",
      "eBay dropship order intake requires at least one line item.",
      { externalOrderId: readOptionalString(order.orderId), retryable: false },
    );
  }

  return lineItems.map((item, index) => buildEbayOrderLine(item, index));
}

function buildEbayOrderLine(
  item: EbayOrderLineItem,
  index: number,
): RecordDropshipOrderIntakeInput["normalizedPayload"]["lines"][number] {
  const quantity = readPositiveInteger(item.quantity, `lineItems.${index}.quantity`);
  const lineTotalCents = parseEbayMoneyCents(item.lineItemCost, `lineItems.${index}.lineItemCost`);
  const exactUnitCents = lineTotalCents % quantity === 0
    ? lineTotalCents / quantity
    : undefined;

  return {
    externalLineItemId: readRequiredString(item.lineItemId, `lineItems.${index}.lineItemId`),
    externalListingId: readOptionalString(item.legacyItemId) ?? undefined,
    externalOfferId: readOptionalString(item.legacyVariationId) ?? undefined,
    sku: readOptionalString(item.sku) ?? undefined,
    quantity,
    unitRetailPriceCents: exactUnitCents,
    title: readOptionalString(item.title) ?? `eBay line ${item.lineItemId}`,
  };
}

function buildEbayShipTo(
  order: EbayOrder,
): RecordDropshipOrderIntakeInput["normalizedPayload"]["shipTo"] {
  const shippingStep = order.fulfillmentStartInstructions?.[0]?.shippingStep;
  const shipTo = shippingStep?.shipTo;
  const address = shipTo?.contactAddress;
  const country = readOptionalString(address?.countryCode);

  return {
    name: readOptionalString(shipTo?.fullName) ?? readOptionalString(order.buyer?.username) ?? undefined,
    address1: readOptionalString(address?.addressLine1) ?? undefined,
    address2: readOptionalString(address?.addressLine2) ?? undefined,
    city: readOptionalString(address?.city) ?? undefined,
    region: readOptionalString(address?.stateOrProvince) ?? undefined,
    postalCode: readOptionalString(address?.postalCode) ?? undefined,
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined,
    phone: readOptionalString(shipTo?.primaryPhone?.phoneNumber) ?? undefined,
    email: readOptionalString(shipTo?.email) ?? undefined,
  };
}

function buildEbayTotals(
  order: EbayOrder,
): RecordDropshipOrderIntakeInput["normalizedPayload"]["totals"] {
  const pricing = order.pricingSummary ?? {};
  return {
    retailSubtotalCents: parseEbayMoneyCents(pricing.priceSubtotal, "pricingSummary.priceSubtotal"),
    shippingPaidCents: parseEbayMoneyCents(pricing.deliveryCost, "pricingSummary.deliveryCost"),
    taxCents: parseEbayMoneyCents(pricing.tax, "pricingSummary.tax"),
    discountCents: parseEbayMoneyCents(pricing.priceDiscount, "pricingSummary.priceDiscount"),
    grandTotalCents: parseEbayMoneyCents(pricing.total, "pricingSummary.total"),
    currency: (readMoneyCurrency(pricing.total) ?? "USD").toUpperCase(),
  };
}

function readEbayOrderedAt(order: EbayOrder): string | undefined {
  const orderedAt = readOptionalString(order.creationDate);
  if (!orderedAt) {
    return undefined;
  }
  const parsed = new Date(orderedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDERED_AT_INVALID",
      "eBay order timestamp is invalid.",
      { orderedAt, retryable: false },
    );
  }
  return parsed.toISOString();
}

function readMoneyCurrency(value: unknown): string | null {
  return isEbayAmount(value) ? readOptionalString(value.currency) : null;
}

function readRequiredString(value: unknown, field: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_ID_REQUIRED",
      "eBay order payload is missing a required identifier.",
      { field, retryable: false },
    );
  }
  return text;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_QUANTITY_INVALID",
      "eBay order quantity must be a positive integer.",
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

function isEbayAmount(value: unknown): value is EbayAmount {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "value" in value);
}
