import type { OrderEditRecord } from "../../application/order-edit-store";
import {
  orderEditQuoteSchema,
  orderEditSnapshotSchema,
} from "../../application/order-edit-provider.schema";
import { paidRewardFixture } from "./order-edit-paid-reward.fixture";

/** Synthetic line replacement plus a successful price-adjustment refund. */
export function settledRefundEditFixture(
  operationId: string,
  now: Date,
): OrderEditRecord {
  const template = paidRewardFixture(operationId, now);
  const baseline = orderEditSnapshotSchema.parse({
    connectionId: 4,
    channelId: 36,
    orderId: "gid://shopify/Order/1",
    name: "#1",
    customerId: null,
    currency: "USD",
    updatedAt: now.toISOString(),
    editable: true,
    editableErrors: [],
    cancelled: false,
    closed: false,
    fullyPaid: true,
    totalCents: 1000,
    outstandingCents: 0,
    subtotalCents: 1000,
    taxCents: 0,
    netPaidCents: 1000,
    capturableCents: 0,
    shippingCents: 0,
    paymentUrl: null,
    memberPlan: null,
    memberPricingEnabled: false,
    discountsPresent: false,
    lines: [
      {
        id: "gid://shopify/LineItem/101",
        variantId: "gid://shopify/ProductVariant/100",
        title: "Product",
        variantTitle: null,
        sku: "SKU",
        quantity: 1,
        unfulfilledQuantity: 1,
        originalUnitPriceCents: 1000,
        discountedUnitPriceCents: 1000,
        totalCents: 1000,
        discountFingerprint: "a".repeat(64),
        unsupported: false,
      },
    ],
    transactions: [
      {
        id: "gid://shopify/OrderTransaction/1",
        parentId: null,
        kind: "SALE",
        status: "SUCCESS",
        gateway: "bogus",
        amountCents: 1000,
        manual: false,
      },
    ],
    refunds: [],
    contentFingerprint: "b".repeat(64),
    fingerprint: "c".repeat(64),
    evidence: {
      countryCode: "US",
      shippingAddressFingerprint: "d".repeat(64),
      discountApplications: [],
      unsupportedPaymentTerms: false,
    },
  });
  const refundIntent = {
    connectionId: 4,
    channelId: 36,
    orderId: baseline.orderId,
    operationId,
    idempotencyKey: "00000000-0000-4000-8000-000000000003",
    currency: "USD" as const,
    amountCents: 100,
    parentTransactionId: baseline.transactions[0].id,
    gateway: "bogus",
    note: `Echelon order edit ${operationId}`,
    contentFingerprint: "e".repeat(64),
  };
  const refundTransaction = {
    id: "gid://shopify/OrderTransaction/2",
    parentId: baseline.transactions[0].id,
    kind: "REFUND",
    status: "SUCCESS",
    gateway: "bogus",
    amountCents: 100,
    manual: false,
  };
  const current = orderEditSnapshotSchema.parse({
    ...baseline,
    totalCents: 900,
    subtotalCents: 900,
    netPaidCents: 900,
    fingerprint: "f".repeat(64),
    contentFingerprint: refundIntent.contentFingerprint,
    lines: [
      {
        ...baseline.lines[0],
        quantity: 0,
        unfulfilledQuantity: 0,
        totalCents: 0,
      },
      {
        ...baseline.lines[0],
        id: "gid://shopify/LineItem/102",
        originalUnitPriceCents: 900,
        discountedUnitPriceCents: 900,
        totalCents: 900,
      },
    ],
    transactions: [...baseline.transactions, refundTransaction],
    refunds: [
      {
        id: "gid://shopify/Refund/1",
        note: refundIntent.note,
        amountCents: 100,
        transactions: [refundTransaction],
      },
    ],
  });
  const plan = {
    changes: [{ lineItemId: baseline.lines[0].id, quantity: 0 }],
    additions: [{ variantId: baseline.lines[0].variantId, quantity: 1 }],
  };
  const quote = orderEditQuoteSchema.parse({
    connectionId: 4,
    channelId: 36,
    orderId: baseline.orderId,
    operationId,
    calculatedOrderId: "gid://shopify/CalculatedOrder/1",
    sessionId: "gid://shopify/OrderEditSession/1",
    baselineFingerprint: baseline.fingerprint,
    baseline,
    plan,
    lines: current.lines.map((line, index) => ({
      originalLineId: index === 0 ? line.id : null,
      calculatedLineId: `gid://shopify/CalculatedLineItem/${index + 1}`,
      variantId: line.variantId,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      originalUnitPriceCents: line.originalUnitPriceCents,
      discountedUnitPriceCents: line.discountedUnitPriceCents,
      totalCents: line.totalCents,
    })),
    totalCents: 900,
    outstandingCents: -100,
    deltaCents: -100,
    shippingCents: 0,
    createdAt: now.toISOString(),
    evidence: {},
  });
  return {
    ...template,
    baseline,
    quote,
    lastSnapshot: current,
    refundIntent,
    refundStartedAt: now.toISOString(),
    input: {
      connectionId: 4,
      omsOrderId: 20,
      requestKey: template.requestKey,
      ...plan,
      expectedRevision: baseline.fingerprint,
    },
  };
}
