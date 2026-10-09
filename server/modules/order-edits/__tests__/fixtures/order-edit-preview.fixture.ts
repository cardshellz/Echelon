import type { OrderEditPreviewContext } from "../../application/order-edit-preview-provider";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";
import { priceOrderEditPreviewItems } from "../../domain/order-edit-preview-pricing";
import { toOrderEditPreviewPricingInput } from "../../application/order-edit-preview-pricing-input";
import type { OrderEditPreviewInput } from "@shared/order-edits/order-edit-preview";

export const PREVIEW_NOW = Date.parse("2026-10-09T12:00:00.000Z");
export const PREVIEW_LINE = "gid://shopify/LineItem/1";
export const PREVIEW_VARIANT = "gid://shopify/ProductVariant/10";
export function previewContext(): OrderEditPreviewContext {
  const financials = buildOrderEditFinancials({
    lines: [{ id: PREVIEW_LINE, grossCents: 14999, netCents: 10099 }],
    itemsNetCents: 10099,
    itemDiscountLabels: ["Reward", "Member discount"],
    itemDiscounts: [
      {
        key: "code:Reward",
        label: "Reward",
        value: { type: "fixed", amountCents: 1900 },
        amountCents: 1900,
      },
      {
        key: "product",
        label: "Product discounts",
        value: { type: "allocated" },
        amountCents: 3000,
      },
    ],
    shippingGrossCents: 1199,
    shippingCents: 0,
    shippingDiscountLabels: ["Member free shipping"],
    taxCents: 0,
    taxesIncluded: false,
    totalCents: 10099,
  });
  return {
    snapshot: {
      connectionId: 4,
      channelId: 36,
      orderId: "gid://shopify/Order/100",
      name: "#100",
      customerId: "gid://shopify/Customer/8",
      currency: "USD",
      updatedAt: new Date(PREVIEW_NOW).toISOString(),
      editable: true,
      editableErrors: [],
      cancelled: false,
      closed: false,
      fullyPaid: true,
      totalCents: 10099,
      outstandingCents: 0,
      subtotalCents: 10099,
      taxCents: 0,
      netPaidCents: 10099,
      capturableCents: 0,
      shippingCents: 0,
      paymentUrl: null,
      memberPlan: "member",
      memberPricingEnabled: true,
      discountsPresent: true,
      lines: [
        {
          id: PREVIEW_LINE,
          variantId: PREVIEW_VARIANT,
          title: "Team Bags",
          variantTitle: "Case",
          sku: "BAGS",
          quantity: 1,
          unfulfilledQuantity: 1,
          originalUnitPriceCents: 14999,
          discountedUnitPriceCents: 11999,
          totalCents: 11999,
          discountFingerprint: "d".repeat(64),
          unsupported: false,
        },
      ],
      transactions: [],
      refunds: [],
      fingerprint: "a".repeat(64),
      contentFingerprint: "b".repeat(64),
      evidence: {
        countryCode: "US",
        shippingAddressFingerprint: "c".repeat(64),
        unsupportedPaymentTerms: false,
        discountApplications: [],
      },
      financials,
      previewProductDiscounts: [
        { lineId: PREVIEW_LINE, amountCents: 3000, automaticCents: 3000 },
      ],
      discountRules: [
        {
          index: 0,
          type: "AutomaticDiscountApplication",
          targetType: "LINE_ITEM",
          allocationMethod: "ACROSS",
          targetSelection: "ENTITLED",
          label: "Member discount",
          value: { type: "fixed", amountCents: 3000 },
        },
        {
          index: 1,
          type: "DiscountCodeApplication",
          targetType: "LINE_ITEM",
          allocationMethod: "ACROSS",
          targetSelection: "ALL",
          label: "Reward",
          value: { type: "fixed", amountCents: 1900 },
        },
      ],
      shippingContext: {
        address: {
          address1: "100 Test St",
          address2: null,
          city: "Test",
          provinceCode: "PA",
          zip: "16066",
          countryCodeV2: "US",
        },
        lines: [
          {
            id: "gid://shopify/ShippingLine/1",
            title: "Standard Shipping",
            code: "standard",
            source: "Echelon Shipping",
            grossCents: 1199,
            netCents: 0,
          },
        ],
      },
    },
    variants: [
      {
        variantId: PREVIEW_VARIANT,
        title: "Team Bags",
        variantTitle: "Case",
        retailCents: 14999,
        memberCents: 11999,
        availableQuantity: 100,
        available: true,
      },
    ],
  };
}
export function previewInput(quantity = 2): OrderEditPreviewInput {
  return {
    connectionId: 4,
    omsOrderId: 1,
    expectedRevision: "a".repeat(64),
    changes: [{ lineItemId: PREVIEW_LINE, quantity }],
    additions: [],
  };
}
export function previewCalculation(
  context = previewContext(),
  plan = previewInput(),
) {
  const pricing = priceOrderEditPreviewItems(
    toOrderEditPreviewPricingInput(context),
    { changes: plan.changes, additions: plan.additions },
  );
  return {
    financials: buildOrderEditFinancials({
      lines: pricing.lines.map(({ id, grossCents, netCents }) => ({
        id,
        grossCents,
        netCents,
      })),
      itemsNetCents: pricing.itemsNetCents,
      itemDiscounts: pricing.discounts,
      itemDiscountLabels: pricing.discounts.map((d) => d.label),
      shippingGrossCents: 1199,
      shippingCents: 0,
      shippingDiscountLabels: ["Member free shipping"],
      taxCents: 0,
      taxesIncluded: false,
      totalCents: pricing.itemsNetCents,
    }),
    shippingRepricing: {
      title: "Standard Shipping",
      code: "standard",
      source: "Echelon Shipping",
      grossCents: 1199,
      netCents: 0,
      discountCents: 1199,
      discountLabels: ["Member free shipping"],
    },
    lines: pricing.lines.map((line) => ({
      id: line.id,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      totalCents: line.netCents,
    })),
  };
}
