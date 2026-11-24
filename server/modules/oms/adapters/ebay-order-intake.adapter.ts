/**
 * eBay Channel Order Intake Adapter (`P3.1`)
 *
 * Implements `ChannelOrderAdapter` for eBay:
 *   - `verifyWebhook`: verifies `x-ebay-signature` notification signature
 *   - `normalizeOrder`: eBay Fulfillment API `EbayOrder` -> `ValidatedChannelOrder`
 *   - `normalizeCancel`: eBay `cancelStatus.cancelState === "CANCELED"` -> `ValidatedChannelCancelEvent`
 *   - `normalizeRefund`: eBay `FULLY_REFUNDED` / `PARTIALLY_REFUNDED` -> `ValidatedChannelRefundEvent`
 */

import { parseDecimalCents } from "@shared/money-read";
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
} from "../../channels/channel-adapter.interface.api";
import type { EbayApiClient, EbayOrder } from "../../channels/ebay-connector.api";
import { extractEbayShipByDate } from "../application/ebay-shipby";
import { createEbayWebhookSignatureVerifier } from "../application/ebay-webhook-signature";
import type { LineItemData, OrderData } from "../application/oms.service";

// eBay reports pricingSummary.priceDiscount as a negative amount ("-1.50").
export function ebayDollarsToCents(value: string | undefined | null): number {
  if (!value) return 0;
  return parseDecimalCents(value, "dollarsToCents", true);
}

export function mapEbayOrderToOrderData(ebayOrder: EbayOrder): OrderData {
  const shippingStep = ebayOrder.fulfillmentStartInstructions?.[0]?.shippingStep;
  const shipTo = shippingStep?.shipTo;
  const address = shipTo?.contactAddress;
  const pricingSummary = ebayOrder.pricingSummary;

  const channelShipByDate = extractEbayShipByDate(ebayOrder);

  const lineItems: LineItemData[] = (ebayOrder.lineItems || []).map((item) => {
    const lineItemCostCents = ebayDollarsToCents(item.lineItemCost?.value);
    const qty = item.quantity || 1;
    const paidPriceCents = Math.round(lineItemCostCents / qty);
    const discountCents = item.discountedLineItemCost
      ? lineItemCostCents - ebayDollarsToCents(item.discountedLineItemCost?.value)
      : 0;
    const taxCents = 0;

    return {
      externalLineItemId: item.lineItemId,
      externalProductId: item.legacyItemId || null,
      sku: item.sku,
      title: item.title,
      name: item.title,
      quantity: qty,
      fulfillmentProvider: "ebay",
      paidPriceCents,
      totalCents: lineItemCostCents,
      taxCents,
      discountCents,
    };
  });

  let financialStatus = "paid";
  if (ebayOrder.orderPaymentStatus === "PENDING") financialStatus = "pending";
  else if (ebayOrder.orderPaymentStatus === "FAILED") financialStatus = "failed";
  else if (ebayOrder.orderPaymentStatus === "FULLY_REFUNDED") financialStatus = "refunded";
  else if (ebayOrder.orderPaymentStatus === "PARTIALLY_REFUNDED") financialStatus = "partially_refunded";

  let fulfillmentStatus = "unfulfilled";
  if (ebayOrder.orderFulfillmentStatus === "FULFILLED") fulfillmentStatus = "fulfilled";
  else if (ebayOrder.orderFulfillmentStatus === "IN_PROGRESS") fulfillmentStatus = "partially_fulfilled";

  let status: "pending" | "confirmed" | "cancelled" = "pending";
  if (ebayOrder.cancelStatus?.cancelState === "CANCELED") {
    status = "cancelled";
  } else if (financialStatus === "paid") {
    status = "confirmed";
  }

  return {
    sourceTopic: "ebay/order",
    externalOrderNumber: ebayOrder.orderId,
    status,
    financialStatus,
    fulfillmentStatus,
    customerName: shipTo?.fullName || ebayOrder.buyer?.username,
    customerEmail: shipTo?.email,
    customerPhone: shipTo?.primaryPhone?.phoneNumber,
    externalCustomerId: ebayOrder.buyer?.username || undefined,
    shipToName: shipTo?.fullName,
    shipToCompany:
      (shipTo as any)?.companyName || (address as any)?.companyName || null,
    shipToAddress1: address?.addressLine1,
    shipToAddress2: address?.addressLine2,
    shipToCity: address?.city,
    shipToState: address?.stateOrProvince,
    shipToZip: address?.postalCode,
    shipToCountry: address?.countryCode,
    subtotalCents: ebayDollarsToCents(pricingSummary?.priceSubtotal?.value),
    shippingCents: ebayDollarsToCents(pricingSummary?.deliveryCost?.value),
    taxCents: 0,
    discountCents: ebayDollarsToCents(pricingSummary?.priceDiscount?.value),
    totalCents:
      ebayDollarsToCents(pricingSummary?.priceSubtotal?.value) +
      ebayDollarsToCents(pricingSummary?.deliveryCost?.value),
    currency: pricingSummary?.total?.currency || "USD",
    rawPayload: ebayOrder as unknown,
    orderedAt: new Date(ebayOrder.creationDate),
    channelShipByDate,
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

export interface EbayOrderIntakeAdapterOptions {
  ebayApiClient?: EbayApiClient;
  signatureVerifier?: (reqLike: {
    headers: Record<string, unknown>;
    body?: unknown;
    rawBody?: Buffer;
  }) => Promise<{
    ok: boolean;
    statusCode?: number;
    code?: string;
    message?: string;
  }>;
}

export function createEbayOrderIntakeAdapter(
  options: EbayOrderIntakeAdapterOptions = {},
): ChannelOrderAdapter {
  const verifyWithSdk =
    options.signatureVerifier ??
    (options.ebayApiClient
      ? createEbayWebhookSignatureVerifier(options.ebayApiClient)
      : null);

  return {
    adapterName: "eBay",
    providerKey: "ebay",

    async verifyWebhook(
      input: ChannelWebhookVerifyInput,
    ): Promise<ChannelWebhookVerifyResult> {
      const sigHeader = readHeader(input.headers, "x-ebay-signature");
      if (!sigHeader || !sigHeader.trim()) {
        return {
          ok: false,
          statusCode: 401,
          code: "EBAY_SIGNATURE_MISSING",
          message: "Missing notification signature",
        };
      }

      if (verifyWithSdk) {
        const rawBuf =
          typeof input.rawBody === "string"
            ? Buffer.from(input.rawBody, "utf8")
            : input.rawBody ?? undefined;
        const result = await verifyWithSdk({
          headers: input.headers,
          body: input.parsedBody,
          rawBody: rawBuf,
        } as any);
        if (!result.ok) {
          return {
            ok: false,
            statusCode: ((result.statusCode as any) ?? 401) as
              | 400
              | 401
              | 403
              | 500
              | 503,
            code: result.code ?? "EBAY_SIGNATURE_INVALID",
            message: result.message ?? "Invalid eBay notification signature",
          };
        }
      }

      return { ok: true };
    },

    normalizeOrder(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelOrder {
      if (!rawPayload || typeof rawPayload !== "object") {
        return parseValidatedChannelOrder("ebay", {} as any);
      }
      const ebayOrder = rawPayload as EbayOrder;
      const mapped = mapEbayOrderToOrderData(ebayOrder);

      return parseValidatedChannelOrder("ebay", {
        externalOrderId: String(ebayOrder.orderId ?? "").trim(),
        externalOrderNumber: String(ebayOrder.orderId ?? "").trim(),
        channelId: context.channelId,
        source: "ebay",
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
        channelShipByDate: mapped.channelShipByDate ?? null,
        subtotalCents: mapped.subtotalCents ?? 0,
        shippingCents: mapped.shippingCents ?? 0,
        taxCents: mapped.taxCents ?? 0,
        discountCents: mapped.discountCents ?? 0,
        totalCents: mapped.totalCents ?? 0,
        currency: mapped.currency ?? "USD",
        notes: null,
        tags: null,
        orderDate: mapped.orderedAt,
        sourceTopic: context.sourceTopic ?? "ebay/order",
        sourceEventId: context.sourceEventId ?? null,
        sourceInboxId: context.sourceInboxId ?? null,
        rawPayload,
        lineItems: mapped.lineItems.map((li) => ({
          externalLineItemId: String(li.externalLineItemId ?? "").trim(),
          externalProductId: li.externalProductId ?? null,
          externalVariantId: null,
          sku: li.sku ?? null,
          title: li.title || li.sku || String(li.externalLineItemId ?? "Item"),
          name: li.name ?? li.title ?? null,
          variantTitle: null,
          quantity: li.quantity,
          paidPriceCents: li.paidPriceCents ?? 0,
          discountCents: li.discountCents ?? 0,
          taxCents: li.taxCents ?? 0,
          totalCents: li.totalCents ?? 0,
          fulfillmentProvider: "ebay",
        })),
      });
    },

    normalizeCancel(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelCancelEvent | null {
      if (!rawPayload || typeof rawPayload !== "object") return null;
      const ebayOrder = rawPayload as EbayOrder;
      if (ebayOrder.cancelStatus?.cancelState !== "CANCELED") {
        return null;
      }

      const cancelRequests = (ebayOrder.cancelStatus as any)?.cancelRequests;
      const firstCancelDate = Array.isArray(cancelRequests)
        ? cancelRequests[0]?.cancelCompletedDate ||
          cancelRequests[0]?.cancelInitiatedDate
        : null;

      return parseValidatedChannelCancel("ebay", {
        externalOrderId: String(ebayOrder.orderId ?? "").trim(),
        channelId: context.channelId,
        source: "ebay",
        reason:
          (Array.isArray(cancelRequests) && cancelRequests[0]?.cancelReason) ||
          "ebay_cancel",
        cancelledAt: firstCancelDate
          ? new Date(firstCancelDate)
          : context.observedAt ?? new Date(),
        lineItems: null,
        rawPayload,
      });
    },

    normalizeRefund(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelRefundEvent | null {
      if (!rawPayload || typeof rawPayload !== "object") return null;
      const ebayOrder = rawPayload as EbayOrder;
      if (
        ebayOrder.orderPaymentStatus !== "FULLY_REFUNDED" &&
        ebayOrder.orderPaymentStatus !== "PARTIALLY_REFUNDED"
      ) {
        return null;
      }

      const mapped = mapEbayOrderToOrderData(ebayOrder);
      const isFull = ebayOrder.orderPaymentStatus === "FULLY_REFUNDED";

      return parseValidatedChannelRefund("ebay", {
        externalOrderId: String(ebayOrder.orderId ?? "").trim(),
        externalRefundId: null,
        channelId: context.channelId,
        source: "ebay",
        financialStatus: isFull ? "refunded" : "partially_refunded",
        refundAmountCents: isFull ? Math.max(0, mapped.totalCents ?? 0) : 0,
        refundedAt: context.observedAt ?? new Date(),
        lineItems: [],
        rawPayload,
      });
    },
  };
}
