import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { OrderData } from "../../../oms/oms.service";
import { WalmartApiError } from "./walmart-client";
import type { WalmartOrder } from "./walmart-us-api";

const MAX_CENTS = 2_147_483_647;
const MoneyDecimal = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });
export function walmartCents(value: string | number): number {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw invalid("WALMART_MONEY_INVALID", "Walmart amounts must be nonnegative USD values with at most two decimal places");
  const cents = new MoneyDecimal(text).times(100);
  if (!cents.isInteger() || cents.greaterThan(MAX_CENTS)) throw invalid("WALMART_MONEY_OVERFLOW", "Walmart amount exceeds the supported monetary range");
  return cents.toNumber();
}
function sum(values: number[]): number {
  const value = values.reduce((total, next) => total + BigInt(next), BigInt(0));
  if (value > BigInt(MAX_CENTS)) throw invalid("WALMART_MONEY_OVERFLOW", "Walmart order exceeds the supported monetary range");
  return Number(value);
}
function invalid(code: string, message: string) { return new WalmartApiError(code, message, false); }
export function walmartOrderHash(order: unknown): string {
  return createHash("sha256").update(JSON.stringify(order)).digest("hex");
}
export interface WalmartLineDisposition {
  quantity: number; cancelled_quantity: number; refunded_quantity: number;
  authority_fulfillable_quantity: number; authorization_status: string;
}
export function reconcileWalmartLineDisposition(line: WalmartOrder["orderLines"]["orderLine"][number], before: WalmartLineDisposition): WalmartLineDisposition {
  const cancelled = line.orderLineStatuses.orderLineStatus.filter(state => state.status === "Cancelled")
    .reduce((sum, state) => sum + state.statusQuantity.amount, 0);
  if (before.quantity !== line.orderLineQuantity.amount || before.cancelled_quantity > cancelled || before.refunded_quantity > 0) {
    throw invalid("WALMART_AUTHORITY_CONFLICT", "Provider order conflicts with an existing quantity, cancellation or refund disposition");
  }
  return { ...before, cancelled_quantity: cancelled,
    authority_fulfillable_quantity: Math.min(before.authority_fulfillable_quantity, before.quantity - cancelled),
    authorization_status: cancelled === before.quantity ? "cancelled" : cancelled > 0 ? "partially_cancelled" : before.authorization_status };
}
export function validateWalmartOrderScope(order: WalmartOrder, shipNodeId: string): void {
  if (order.shipNode.type !== "SellerFulfilled" || order.shipNode.id !== shipNodeId) {
    throw invalid("WALMART_ORDER_SCOPE_MISMATCH", "Order belongs to another fulfillment center or fulfillment program");
  }
  if (order.orderType === "REPLACEMENT") throw invalid("WALMART_REPLACEMENT_REVIEW", "Replacement orders require explicit commercial and inventory treatment");
  const seen = new Set<string>();
  for (const line of order.orderLines.orderLine) {
    if (seen.has(line.lineNumber)) throw invalid("WALMART_DUPLICATE_LINE", "Walmart order contains duplicate line identities");
    seen.add(line.lineNumber);
    if (line.orderLineQuantity.amount <= 0) throw invalid("WALMART_QUANTITY_INVALID", "Walmart order quantity must be positive");
    const total = line.orderLineStatuses.orderLineStatus.reduce((value, state) => value + state.statusQuantity.amount, 0);
    if (total !== line.orderLineQuantity.amount) throw invalid("WALMART_STATUS_QUANTITY_MISMATCH", "Walmart line statuses do not account for the complete ordered quantity");
    if (line.refund != null || line.orderLineStatuses.orderLineStatus.some(state => state.status === "Refund")) {
      throw invalid("WALMART_REFUND_REVIEW", "Walmart refund disposition requires review before changing order authority");
    }
    if (!["S2H", "DELIVERY"].includes(line.fulfillment.fulfillmentOption)) throw invalid("WALMART_FULFILLMENT_UNSUPPORTED", "Only seller-shipped delivery orders are supported");
  }
}
export function mapWalmartOrder(order: WalmartOrder, shipNodeId: string, acknowledged: boolean): OrderData {
  validateWalmartOrderScope(order, shipNodeId);
  const address = order.shippingInfo.postalAddress;
  const shipping: number[] = [], taxes: number[] = [];
  const lineItems = order.orderLines.orderLine.map(line => {
    // The published US examples prove charge semantics for quantity one only.
    // Until a multi-quantity provider fixture is reconciled, fail explicitly
    // rather than guessing whether its amounts are unit prices or line totals.
    if (line.orderLineQuantity.amount !== 1) throw invalid("WALMART_MULTI_QUANTITY_REVIEW", "Multi-quantity financial mapping requires a verified Walmart order fixture");
    const product: number[] = [], productTaxes: number[] = [];
    for (const charge of line.charges.charge) {
      if (charge.chargeName === "SubscriptionDiscount") throw invalid("WALMART_DISCOUNT_REVIEW", "Subscription discounts require a verified monetary mapping");
      const cents = walmartCents(charge.chargeAmount.amount);
      (charge.chargeType === "PRODUCT" ? product : shipping).push(cents);
      if (charge.tax) {
        const tax = walmartCents(charge.tax.taxAmount.amount);
        taxes.push(tax);
        if (charge.chargeType === "PRODUCT") productTaxes.push(tax);
      }
    }
    if (product.length !== 1) throw invalid("WALMART_PRODUCT_CHARGE_INVALID", "Each line must contain one verified product charge");
    return {
      externalLineItemId: line.lineNumber, externalVariantId: line.item.sku, sku: line.item.sku,
      title: line.item.productName, name: line.item.productName, quantity: line.orderLineQuantity.amount,
      paidPriceCents: sum(product), retailPriceCents: sum(product), totalCents: sum(product), taxCents: sum(productTaxes), discountCents: 0,
      requiresShipping: true, fulfillmentProvider: "walmart", fulfillmentService: "manual",
      // Walmart shipment confirmation is commercial fulfillment. Existing WMS
      // work retains its paid quantity until physical dispatch; a label-time
      // Shipped state must not revoke that warehouse authority. The fulfilled
      // order header prevents creating WMS work for historical shipped orders.
      fulfillableQuantity: acknowledged ? line.orderLineStatuses.orderLineStatus
        .filter(state => ["Acknowledged", "Shipped", "Delivered"].includes(state.status))
        .reduce((total, state) => total + state.statusQuantity.amount, 0) : 0,
      providerFulfillmentOrderId: order.purchaseOrderId, providerFulfillmentOrderLineItemId: line.lineNumber,
    };
  });
  const states = order.orderLines.orderLine.flatMap(line => line.orderLineStatuses.orderLineStatus);
  const allCancelled = states.every(state => state.status === "Cancelled");
  const allShipped = states.every(state => ["Shipped", "Delivered", "Cancelled"].includes(state.status));
  const subtotalCents = sum(lineItems.map(line => line.totalCents));
  const shippingCents = sum(shipping), taxCents = sum(taxes);
  return {
    // Walmart purchaseOrderId, not customerOrderId, is the provider's fulfillment identity.
    externalOrderNumber: order.purchaseOrderId,
    sourceTopic: acknowledged ? "walmart/acknowledged" : "walmart/observed",
    sourceEventId: `walmart:${walmartOrderHash(order)}`,
    status: allCancelled ? "cancelled" : "confirmed", financialStatus: "paid",
    fulfillmentStatus: allShipped && !allCancelled ? "fulfilled" : "unfulfilled",
    customerName: address.name, customerEmail: order.customerEmailId, customerPhone: order.shippingInfo.phone,
    shipToName: address.name, shipToAddress1: address.address1, shipToAddress2: address.address2 ?? undefined,
    shipToCity: address.city, shipToState: address.state, shipToZip: address.postalCode, shipToCountry: "US",
    shippingMethod: order.shippingInfo.methodCode, shippingMethodCode: order.shippingInfo.methodCode,
    shippingServiceLevel: order.shippingInfo.methodCode === "OneDay" ? "overnight"
      : order.shippingInfo.methodCode === "Express" ? "expedited" : "standard",
    channelShipByDate: new Date(order.shippingInfo.estimatedShipDate), orderedAt: new Date(order.orderDate),
    subtotalCents, grossSubtotalCents: subtotalCents, shippingCents, taxCents, totalCents: sum([subtotalCents, shippingCents, taxCents]),
    discountCents: 0, currency: "USD", rawPayload: order, lineItems,
  };
}
