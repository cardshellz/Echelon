/**
 * Shopify Channel Order Intake Adapter (`P3.1`)
 *
 * Implements `ChannelOrderAdapter` for Shopify:
 *   - `verifyWebhook`: HMAC-SHA256 verification over raw request bytes
 *   - `normalizeOrder`: Shopify order payload -> Zod-validated `ValidatedChannelOrder`
 *   - `normalizeCancel`: Shopify `cancelled_at` order payload -> `ValidatedChannelCancelEvent`
 *   - `normalizeRefund`: Shopify refund payload -> `ValidatedChannelRefundEvent`
 */

import * as crypto from "node:crypto";
import { resolveProviderCountryCode } from "@shared/country-code";
import { parseDecimalCents, readIntegerCents } from "@shared/money-read";
import {
  parseValidatedChannelCancel,
  parseValidatedChannelOrder,
  parseValidatedChannelRefund,
  type ChannelOrderAdapter,
  type ChannelOrderNormalizeContext,
  type ChannelWebhookVerifyInput,
  type ChannelWebhookVerifyResult,
  type ValidatedChannelCancelEvent,
  type ValidatedChannelOrder,
  type ValidatedChannelRefundEvent,
} from "../../channels/channel-adapter.interface";
import { deriveShopifyRefundFinancialStatus } from "../domain/shopify-refund-financial-status";
import type { LineItemData, ShopifyOrderData } from "../oms.service";
import { normalizeShopifyCustomerId } from "../shopify-customer-identity";
import { normalizeShopifyLineItems } from "../shopify-line-item-normalizer";
import { extractRefundLineAdjustments } from "../shopify-refund-cascade.service";

const RISK_LEVEL_SEVERITY: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function normalizeRiskLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRiskRecommendation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRiskScore(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return String(parsed);
  }
  return null;
}

export interface ExtractedShopifyRisk {
  riskLevel: string | null;
  riskScore: string | null;
  riskRecommendation: string | null;
  riskFacts: unknown;
}

export function extractShopifyRisk(shopifyOrder: any): ExtractedShopifyRisk {
  const empty: ExtractedShopifyRisk = {
    riskLevel: null,
    riskScore: null,
    riskRecommendation: null,
    riskFacts: null,
  };
  if (!shopifyOrder || typeof shopifyOrder !== "object") return empty;

  const assessments = (shopifyOrder as any).risk_assessments;
  if (Array.isArray(assessments) && assessments.length > 0) {
    let bestLevel: string | null = null;
    let bestSeverity = -1;
    let bestRecommendation: string | null = null;
    let bestScore: string | null = null;

    for (const a of assessments) {
      if (!a || typeof a !== "object") continue;
      const level = normalizeRiskLevel((a as any).risk_level ?? (a as any).level);
      const severity = level !== null ? RISK_LEVEL_SEVERITY[level] ?? -1 : -1;
      if (severity > bestSeverity) {
        bestSeverity = severity;
        bestLevel = level;
        bestRecommendation = normalizeRiskRecommendation((a as any).recommendation);
        bestScore = parseRiskScore((a as any).score);
      }
    }

    return {
      riskLevel: bestLevel,
      riskScore: bestScore,
      riskRecommendation: bestRecommendation,
      riskFacts: assessments,
    };
  }

  const legacy = (shopifyOrder as any).risk;
  if (legacy && typeof legacy === "object") {
    const level = normalizeRiskLevel(legacy.level);
    const recommendation = normalizeRiskRecommendation(legacy.recommendation);
    if (level === null && recommendation === null) {
      return empty;
    }
    return {
      riskLevel: level,
      riskScore: parseRiskScore(legacy.score),
      riskRecommendation: recommendation,
      riskFacts: legacy,
    };
  }

  return empty;
}

export function shopifyDollarsToCents(
  value: string | number | undefined | null,
): number {
  if (value === null || value === undefined) return 0;
  return parseDecimalCents(String(value), "dollarsToCents");
}

export function getShopifyExternalOrderId(shopifyOrder: any): string {
  const raw = shopifyOrder?.admin_graphql_api_id || shopifyOrder?.id;
  if (raw === undefined || raw === null) {
    throw new Error(
      "getExternalOrderId: missing admin_graphql_api_id and id on payload",
    );
  }
  const s = String(raw).trim();
  const PREFIX = "gid://shopify/Order/";
  if (s.startsWith(PREFIX)) {
    return s.substring(PREFIX.length);
  }
  if (!s) {
    throw new Error("getExternalOrderId: blank order id on payload");
  }
  return s;
}

export function verifyShopifyHmacSignature(
  rawBody: Buffer,
  hmacHeader: string | undefined,
  secrets: readonly string[] = [
    process.env.SHOPIFY_API_SECRET,
    process.env.SHOPIFY_WEBHOOK_SECRET,
  ].filter(Boolean) as string[],
): boolean {
  if (!hmacHeader) return false;
  for (const secret of secrets) {
    const computed = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    try {
      if (
        crypto.timingSafeEqual(
          Buffer.from(computed),
          Buffer.from(hmacHeader),
        )
      ) {
        return true;
      }
    } catch {
      if (computed === hmacHeader) return true;
    }
  }
  return false;
}

export function mapShopifyOrderToOrderData(shopifyOrder: any): ShopifyOrderData {
  const shipping = shopifyOrder.shipping_address || {};
  const shipToCountry = resolveProviderCountryCode(
    shipping.country_code,
    shipping.country,
  );
  const customer = shopifyOrder.customer || {};

  const discountApplications = shopifyOrder.discount_applications || [];
  const normalizedItems = normalizeShopifyLineItems(
    shopifyOrder.line_items || [],
    discountApplications,
    shopifyOrder.order_number,
  );

  const lineItems: LineItemData[] = normalizedItems.map((item) => ({
    externalLineItemId: item.externalLineItemId,
    externalProductId: item.externalProductId,
    externalVariantId: item.externalVariantId,
    sku: item.sku,
    title: item.title,
    name: item.name,
    variantTitle: item.variantTitle,
    quantity: item.quantity,
    currentQuantity: item.currentQuantity,
    fulfillableQuantity: item.fulfillableQuantity,
    paidPriceCents: item.paidPriceCents,
    totalCents: item.totalCents,
    taxCents: 0,
    discountCents: item.discountCents,
    requiresShipping: item.requiresShipping,
  }));

  const financialStatus = shopifyOrder.financial_status || "paid";
  const fulfillmentStatus = shopifyOrder.fulfillment_status || "unfulfilled";

  let status: "pending" | "confirmed" | "cancelled" | "shipped" = "pending";
  if (shopifyOrder.cancelled_at) {
    status = "cancelled";
  } else if (fulfillmentStatus === "fulfilled") {
    status = "shipped";
  } else if (
    financialStatus === "paid" ||
    financialStatus === "partially_paid"
  ) {
    status = "confirmed";
  }

  const customerName =
    shipping.name ||
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
    shopifyOrder.name;

  const risk = extractShopifyRisk(shopifyOrder);

  return {
    externalOrderNumber:
      shopifyOrder.name || shopifyOrder.order_number?.toString(),
    status,
    financialStatus,
    fulfillmentStatus,
    riskLevel: risk.riskLevel,
    riskScore: risk.riskScore,
    riskRecommendation: risk.riskRecommendation,
    riskFacts: risk.riskFacts,
    customerName,
    customerEmail: shopifyOrder.email || customer.email,
    customerPhone: shipping.phone || customer.phone,
    externalCustomerId: normalizeShopifyCustomerId(customer.id),
    shipToName: shipping.name,
    shipToCompany: shipping.company || null,
    shipToAddress1: shipping.address1,
    shipToAddress2: shipping.address2,
    shipToCity: shipping.city,
    shipToState: shipping.province_code || shipping.province,
    shipToZip: shipping.zip,
    shipToCountry,
    shippingMethod: shopifyOrder.shipping_lines?.[0]?.title || null,
    shippingMethodCode: shopifyOrder.shipping_lines?.[0]?.code || null,
    shippingServiceLevel: "standard" as const,
    subtotalCents: shopifyDollarsToCents(shopifyOrder.subtotal_price),
    shippingCents: (shopifyOrder.shipping_lines || []).reduce(
      (sum: number, s: any) => sum + shopifyDollarsToCents(s.price),
      0,
    ),
    taxCents: shopifyDollarsToCents(shopifyOrder.total_tax),
    discountCents: shopifyDollarsToCents(shopifyOrder.total_discounts),
    totalCents: shopifyDollarsToCents(shopifyOrder.total_price),
    currency: shopifyOrder.currency || "USD",
    rawPayload: shopifyOrder,
    notes: shopifyOrder.note || undefined,
    tags: shopifyOrder.tags
      ? shopifyOrder.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
      : undefined,
    orderedAt: shopifyOrder.created_at
      ? new Date(shopifyOrder.created_at)
      : new Date(),
    channelUpdatedAt: shopifyOrder.updated_at ?? null,
    lineItems,
  };
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

export interface ShopifyOrderIntakeAdapterOptions {
  secrets?: readonly string[];
  internalRetrySecret?: string;
}

export function createShopifyOrderIntakeAdapter(
  options: ShopifyOrderIntakeAdapterOptions = {},
): ChannelOrderAdapter {
  return {
    adapterName: "Shopify",
    providerKey: "shopify",

    verifyWebhook(input: ChannelWebhookVerifyInput): ChannelWebhookVerifyResult {
      const internalSecret =
        options.internalRetrySecret ?? process.env.SESSION_SECRET;
      const retryHeader = readHeader(input.headers, "x-internal-retry");
      if (internalSecret && retryHeader === internalSecret) {
        return { ok: true, bypassed: true };
      }

      const rawBuffer =
        typeof input.rawBody === "string"
          ? Buffer.from(input.rawBody, "utf8")
          : input.rawBody;
      if (!rawBuffer || !Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
        return {
          ok: false,
          statusCode: 400,
          code: "SHOPIFY_RAW_BODY_MISSING",
          message: "Empty or missing Shopify webhook rawBody",
        };
      }

      const hmac = readHeader(input.headers, "x-shopify-hmac-sha256");
      const secrets =
        options.secrets ??
        ([
          process.env.SHOPIFY_API_SECRET,
          process.env.SHOPIFY_WEBHOOK_SECRET,
        ].filter(Boolean) as string[]);

      if (!verifyShopifyHmacSignature(rawBuffer, hmac, secrets)) {
        return {
          ok: false,
          statusCode: 401,
          code: "SHOPIFY_HMAC_INVALID",
          message: "Invalid Shopify HMAC-SHA256 webhook signature",
        };
      }
      return { ok: true };
    },

    normalizeOrder(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelOrder {
      if (!rawPayload || typeof rawPayload !== "object") {
        return parseValidatedChannelOrder("shopify", {} as any);
      }
      const shopifyOrder = rawPayload as any;
      const externalOrderId = getShopifyExternalOrderId(shopifyOrder);
      const mapped = mapShopifyOrderToOrderData(shopifyOrder);

      return parseValidatedChannelOrder("shopify", {
        externalOrderId,
        externalOrderNumber: mapped.externalOrderNumber ?? externalOrderId,
        channelId: context.channelId,
        source: "shopify",
        status: (mapped.status as any) ?? "confirmed",
        financialStatus: mapped.financialStatus ?? "paid",
        fulfillmentStatus: mapped.fulfillmentStatus ?? "unfulfilled",
        customerEmail: mapped.customerEmail ?? null,
        customerName: mapped.customerName ?? null,
        customerPhone: mapped.customerPhone ?? null,
        externalCustomerId: mapped.externalCustomerId,
        shippingAddress: {
          name: mapped.shipToName ?? null,
          company: mapped.shipToCompany ?? null,
          address1: mapped.shipToAddress1 ?? null,
          address2: mapped.shipToAddress2 ?? null,
          city: mapped.shipToCity ?? null,
          province: mapped.shipToState ?? null,
          zip: mapped.shipToZip ?? null,
          country: mapped.shipToCountry ?? null,
          phone: mapped.customerPhone ?? null,
        },
        shippingMethod: mapped.shippingMethod ?? null,
        shippingMethodCode: mapped.shippingMethodCode ?? null,
        shippingServiceLevel: mapped.shippingServiceLevel,
        subtotalCents: mapped.subtotalCents ?? 0,
        shippingCents: mapped.shippingCents ?? 0,
        taxCents: mapped.taxCents ?? 0,
        discountCents: mapped.discountCents ?? 0,
        totalCents: mapped.totalCents ?? 0,
        currency: mapped.currency ?? "USD",
        notes: mapped.notes ?? null,
        tags: mapped.tags ?? null,
        riskLevel: mapped.riskLevel ?? null,
        riskScore: mapped.riskScore ?? null,
        riskRecommendation: mapped.riskRecommendation ?? null,
        riskFacts: mapped.riskFacts ?? null,
        orderDate: mapped.orderedAt,
        channelUpdatedAt: mapped.channelUpdatedAt ?? null,
        sourceTopic: context.sourceTopic ?? "orders/paid",
        sourceEventId: context.sourceEventId ?? null,
        sourceInboxId: context.sourceInboxId ?? null,
        rawPayload,
        lineItems: mapped.lineItems.map((li) => ({
          externalLineItemId: String(li.externalLineItemId ?? "").trim(),
          externalProductId: li.externalProductId ?? null,
          externalVariantId: li.externalVariantId ?? null,
          sku: li.sku ?? null,
          title: li.title || li.sku || "Untitled Item",
          name: li.name ?? null,
          variantTitle: li.variantTitle ?? null,
          quantity: li.quantity,
          currentQuantity: li.currentQuantity,
          fulfillableQuantity: li.fulfillableQuantity,
          paidPriceCents: li.paidPriceCents ?? 0,
          discountCents: li.discountCents ?? 0,
          taxCents: li.taxCents ?? 0,
          totalCents: li.totalCents ?? 0,
          requiresShipping: li.requiresShipping,
        })),
      });
    },

    normalizeCancel(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelCancelEvent | null {
      if (!rawPayload || typeof rawPayload !== "object") return null;
      const shopifyOrder = rawPayload as any;
      if (!shopifyOrder.cancelled_at) return null;

      const externalOrderId = getShopifyExternalOrderId(shopifyOrder);
      return parseValidatedChannelCancel("shopify", {
        externalOrderId,
        channelId: context.channelId,
        source: "shopify",
        reason: shopifyOrder.cancel_reason ?? null,
        cancelledAt: new Date(shopifyOrder.cancelled_at),
        lineItems: null,
        rawPayload,
      });
    },

    normalizeRefund(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelRefundEvent | null {
      if (!rawPayload || typeof rawPayload !== "object") return null;
      const refund = rawPayload as any;
      const orderIdRaw = refund.order_id ?? refund.admin_graphql_api_order_id;
      if (orderIdRaw === undefined || orderIdRaw === null) return null;

      const externalOrderId = getShopifyExternalOrderId({ id: orderIdRaw });
      const adjustments = extractRefundLineAdjustments(refund.refund_line_items);
      const txSumCents = Array.isArray(refund.transactions)
        ? refund.transactions
            .filter((t: any) => !t?.status || t.status === "success")
            .reduce(
              (sum: number, t: any) => sum + shopifyDollarsToCents(t?.amount),
              0,
            )
        : 0;
      const orderTotalCents =
        refund.order_total_cents != null
          ? readIntegerCents(refund.order_total_cents, "refund.order_total_cents")
          : null;
      const derivedStatus = deriveShopifyRefundFinancialStatus({
        totalCents: orderTotalCents,
        previousRefundCents: null,
        refundCents: txSumCents,
        previousFinancialStatus: null,
      });

      return parseValidatedChannelRefund("shopify", {
        externalOrderId,
        externalRefundId: refund.id != null ? String(refund.id) : null,
        channelId: context.channelId,
        source: "shopify",
        financialStatus:
          refund.financial_status === "partially_refunded" ||
          (orderTotalCents != null && derivedStatus === "partially_refunded")
            ? "partially_refunded"
            : "refunded",
        refundAmountCents: txSumCents,
        refundedAt: refund.created_at
          ? new Date(refund.created_at)
          : context.observedAt ?? new Date(),
        lineItems: adjustments.map((adj) => ({
          externalLineItemId: adj.externalLineItemId,
          quantity: adj.quantity,
          restockType: adj.restockPolicy ?? null,
        })),
        rawPayload,
      });
    },
  };
}
