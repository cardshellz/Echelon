import type { OrderEditRecord } from "../../application/order-edit-store";
import type {
  OrderEditSnapshot,
  OrderEditQuote,
} from "../../application/order-edit-provider";
import {
  orderEditSnapshotSchema,
  orderEditQuoteSchema,
} from "../../application/order-edit-provider.schema";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";
import {
  priceOrderEditCodes,
  presentOrderEditCodeFinancials,
} from "../../domain/order-edit-code-pricing";
import { orderEditAdditionSourceKey } from "../../domain/order-edit-line-plan";

/** Synthetic identities with the native/raw versus allocated amounts that caused
 * paid edits to stall. No customer, coupon, address or payment URL is copied. */
export function paidRewardFixture(
  operationId: string,
  now: Date,
): OrderEditRecord {
  const originalId = "gid://shopify/LineItem/101";
  const addedId = "gid://shopify/LineItem/102";
  const originalVariant = "gid://shopify/ProductVariant/100";
  const addedVariant = "gid://shopify/ProductVariant/101";
  const retained = [
    {
      key: "code:ORIGINAL-REWARD",
      label: "ORIGINAL-REWARD",
      amountCents: 279,
      value: { type: "allocated" as const },
    },
  ];
  const baseline: OrderEditSnapshot = orderEditSnapshotSchema.parse({
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
    totalCents: 582,
    outstandingCents: 0,
    subtotalCents: 0,
    taxCents: 33,
    netPaidCents: 582,
    capturableCents: 0,
    shippingCents: 549,
    paymentUrl: null,
    memberPlan: "Club",
    memberPricingEnabled: true,
    discountsPresent: true,
    lines: [
      {
        id: originalId,
        variantId: originalVariant,
        title: "Original item",
        variantTitle: null,
        sku: "SKU",
        quantity: 1,
        unfulfilledQuantity: 1,
        originalUnitPriceCents: 279,
        discountedUnitPriceCents: 279,
        totalCents: 279,
        discountFingerprint: "a".repeat(64),
        unsupported: false,
      },
    ],
    transactions: [],
    refunds: [],
    contentFingerprint: "b".repeat(64),
    fingerprint: "c".repeat(64),
    evidence: {
      countryCode: "US",
      shippingAddressFingerprint: "d".repeat(64),
      discountApplications: [],
      unsupportedPaymentTerms: false,
    },
    financials: buildOrderEditFinancials({
      lines: [{ id: originalId, grossCents: 279, netCents: 0 }],
      itemsNetCents: 0,
      itemDiscountLabels: ["ORIGINAL-REWARD"],
      itemDiscounts: retained,
      shippingGrossCents: 549,
      shippingCents: 549,
      shippingDiscountLabels: [],
      taxCents: 33,
      taxesIncluded: false,
      totalCents: 582,
    }),
    discountRules: [
      {
        index: 0,
        type: "DiscountCodeApplication",
        targetType: "LINE_ITEM",
        allocationMethod: "ACROSS",
        targetSelection: "ALL",
        label: "ORIGINAL-REWARD",
        value: { type: "fixed", amountCents: 723 },
      },
    ],
    nativeDiscountAllocations: [
      { lineId: originalId, ruleKey: "code:ORIGINAL-REWARD", amountCents: 279 },
    ],
  });
  const logicalPrices = priceOrderEditCodes(
    [
      {
        id: originalId,
        variantId: originalVariant,
        quantity: 1,
        grossCents: 279,
        productNetCents: 279,
        nativeDiscountCents: 279,
      },
      {
        id: orderEditAdditionSourceKey(addedVariant),
        variantId: addedVariant,
        quantity: 1,
        grossCents: 499,
        productNetCents: 449,
      },
    ],
    [
      {
        discountId: "gid://shopify/DiscountCodeNode/1",
        code: "SAVED-REWARD",
        classes: ["ORDER"],
        combinesWith: {
          productDiscounts: true,
          orderDiscounts: true,
          shippingDiscounts: true,
        },
        value: { type: "fixed", amountCents: 233 },
        fingerprint: "e".repeat(64),
        redemption: "club_reward",
        usageLimit: 1,
        appliesOncePerCustomer: true,
      },
    ],
    ["SAVED-REWARD"],
    undefined,
    retained,
  );
  const pricing = {
    ...logicalPrices,
    lines: logicalPrices.lines.map((line, index) => ({
      ...line,
      id: index === 0 ? originalId : addedId,
    })),
  };
  const financials = presentOrderEditCodeFinancials(
    buildOrderEditFinancials({
      lines: [
        { id: originalId, grossCents: 279, netCents: 0 },
        { id: addedId, grossCents: 499, netCents: 216 },
      ],
      itemsNetCents: 216,
      itemDiscountLabels: [],
      shippingGrossCents: 649,
      shippingCents: 649,
      shippingDiscountLabels: [],
      taxCents: 52,
      taxesIncluded: false,
      totalCents: 917,
    }),
    pricing,
  );
  const current = orderEditSnapshotSchema.parse({
    ...baseline,
    updatedAt: now.toISOString(),
    totalCents: 917,
    subtotalCents: 216,
    taxCents: 52,
    netPaidCents: 917,
    shippingCents: 649,
    contentFingerprint: "f".repeat(64),
    fingerprint: "1".repeat(64),
    lines: [
      baseline.lines[0],
      {
        ...baseline.lines[0],
        id: addedId,
        variantId: addedVariant,
        title: "Added item",
        sku: "OTHER-PACK",
        originalUnitPriceCents: 499,
        discountedUnitPriceCents: 216,
        totalCents: 216,
      },
    ],
    financials,
    codePricing: pricing,
  });
  const plan = {
    changes: [{ lineItemId: originalId, quantity: 1 }],
    additions: [{ variantId: addedVariant, quantity: 1 }],
    discountCodes: ["SAVED-REWARD"],
  };
  const quote: OrderEditQuote = orderEditQuoteSchema.parse({
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
    totalCents: 917,
    outstandingCents: 335,
    deltaCents: 335,
    shippingCents: 649,
    financials: {
      ...financials,
      lines: financials.lines.map((line, index) => ({
        ...line,
        id: `gid://shopify/CalculatedLineItem/${index + 1}`,
      })),
    },
    codePricing: {
      ...pricing,
      lines: pricing.lines.map((line, index) => ({
        ...line,
        id: `gid://shopify/CalculatedLineItem/${index + 1}`,
      })),
    },
    createdAt: now.toISOString(),
    evidence: {},
  });
  const requestKey = "00000000-0000-4000-8000-000000000002";
  return {
    id: operationId,
    omsOrderId: 20,
    connectionId: 4,
    requestKey,
    requestHash: "a".repeat(64),
    actorId: "staff",
    status: "synchronizing",
    version: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    input: {
      ...plan,
      connectionId: 4,
      omsOrderId: 20,
      expectedRevision: baseline.fingerprint,
      requestKey,
    },
    baseline,
    quote,
    lastSnapshot: current,
    paymentWindowMinutes: 30,
    quoteDeadline: now.toISOString(),
    paymentDeadline: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    commitKey: requestKey,
    commitStartedAt: now.toISOString(),
    refundIntent: null,
    refundStartedAt: null,
    recoveryStartedAt: null,
    error: null,
  };
}
