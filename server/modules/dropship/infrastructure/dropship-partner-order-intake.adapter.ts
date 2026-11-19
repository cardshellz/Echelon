/**
 * Dropship Partner Feed Order Intake Adapter (`P3.1` / `P3.2`)
 *
 * Bridges vendor/partner dropship order feeds onto the canonical
 * `ChannelOrderAdapter` intake port (`P3.1`) while keeping wallet, quote,
 * and entitlement domain rules strictly inside `modules/dropship`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { readIntegerCents } from "@shared/money-read";
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

export interface DropshipPartnerOrderIntakeAdapterOptions {
  webhookSecret?: string;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function createDropshipPartnerOrderIntakeAdapter(
  options: DropshipPartnerOrderIntakeAdapterOptions = {},
): ChannelOrderAdapter {
  return {
    adapterName: "Dropship Partner Feed",
    providerKey: "dropship_partner",

    verifyWebhook(input: ChannelWebhookVerifyInput): ChannelWebhookVerifyResult {
      const secret =
        options.webhookSecret ?? process.env.DROPSHIP_PARTNER_WEBHOOK_SECRET;
      if (!secret) {
        return {
          ok: false,
          statusCode: 503,
          code: "DROPSHIP_PARTNER_SECRET_MISSING",
          message: "Dropship partner webhook secret is not configured",
        };
      }

      const rawBuffer =
        typeof input.rawBody === "string"
          ? Buffer.from(input.rawBody, "utf8")
          : input.rawBody;
      const provided = readHeader(input.headers, "x-dropship-partner-signature");
      if (!rawBuffer || !Buffer.isBuffer(rawBuffer) || !provided) {
        return {
          ok: false,
          statusCode: 401,
          code: "DROPSHIP_PARTNER_SIGNATURE_MISSING",
          message: "Missing dropship partner webhook signature",
        };
      }

      const expected = createHmac("sha256", secret)
        .update(rawBuffer)
        .digest("hex");
      const left = Buffer.from(expected, "utf8");
      const right = Buffer.from(provided.trim(), "utf8");
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        return {
          ok: false,
          statusCode: 401,
          code: "DROPSHIP_PARTNER_SIGNATURE_INVALID",
          message: "Invalid dropship partner webhook signature",
        };
      }

      return { ok: true };
    },

    normalizeOrder(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelOrder {
      if (!rawPayload || typeof rawPayload !== "object") {
        return parseValidatedChannelOrder("dropship_partner", {} as any);
      }
      const p = rawPayload as Record<string, any>;
      const shipTo =
        p.shipTo && typeof p.shipTo === "object" ? (p.shipTo as any) : {};
      const totals =
        p.totals && typeof p.totals === "object" ? (p.totals as any) : {};
      const rawLines = Array.isArray(p.lines) ? p.lines : [];

      const subtotalCents = readIntegerCents(
        totals.subtotalCents ?? totals.retailSubtotalCents ?? 0,
        "totals.subtotalCents",
      );
      const shippingCents = readIntegerCents(
        totals.shippingCents ?? totals.shippingPaidCents ?? 0,
        "totals.shippingCents",
      );
      const taxCents = readIntegerCents(totals.taxCents ?? 0, "totals.taxCents");
      const discountCents = readIntegerCents(
        totals.discountCents ?? 0,
        "totals.discountCents",
      );
      const totalCents = readIntegerCents(
        totals.totalCents ??
          totals.grandTotalCents ??
          subtotalCents + shippingCents + taxCents - discountCents,
        "totals.totalCents",
      );

      return parseValidatedChannelOrder("dropship_partner", {
        externalOrderId: String(p.externalOrderId ?? "").trim(),
        externalOrderNumber: String(
          p.externalOrderNumber ?? p.externalOrderId ?? "",
        ).trim(),
        channelId: context.channelId,
        source: "dropship_partner",
        status: p.cancelledAt ? "cancelled" : "confirmed",
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        customerEmail: shipTo.email ?? null,
        customerName: shipTo.name ?? null,
        customerPhone: shipTo.phone ?? null,
        externalCustomerId:
          p.vendorId != null ? `dropship_vendor:${String(p.vendorId)}` : null,
        shippingAddress: {
          name: shipTo.name ?? null,
          company: shipTo.company ?? null,
          address1: shipTo.address1 ?? null,
          address2: shipTo.address2 ?? null,
          city: shipTo.city ?? null,
          province: shipTo.region ?? shipTo.province ?? null,
          zip: shipTo.postalCode ?? shipTo.zip ?? null,
          country: shipTo.country ?? null,
          phone: shipTo.phone ?? null,
        },
        subtotalCents,
        shippingCents,
        taxCents,
        discountCents,
        totalCents,
        currency: String(totals.currency ?? "USD"),
        notes: typeof p.notes === "string" ? p.notes : null,
        tags: ["dropship"],
        orderDate: p.orderedAt ? new Date(String(p.orderedAt)) : new Date(),
        sourceTopic: context.sourceTopic ?? "dropship/order",
        sourceEventId: context.sourceEventId ?? null,
        sourceInboxId: context.sourceInboxId ?? null,
        rawPayload,
        lineItems:
          rawLines.length > 0
            ? rawLines.map((line: any) => {
                const qty = Number(line?.quantity ?? 0);
                const unitPriceCents = readIntegerCents(
                  line?.unitPriceCents ?? line?.unitRetailPriceCents ?? 0,
                  "line.unitPriceCents",
                );
                return {
                  externalLineItemId: String(
                    line?.externalLineItemId ?? "",
                  ).trim(),
                  sku: line?.sku ?? null,
                  title: String(line?.title ?? line?.sku ?? "Item"),
                  quantity: qty,
                  paidPriceCents: unitPriceCents,
                  discountCents: 0,
                  taxCents: 0,
                  totalCents: unitPriceCents * Math.max(0, qty),
                };
              })
            : [],
      });
    },

    normalizeCancel(
      rawPayload: unknown,
      context: ChannelOrderNormalizeContext,
    ): ValidatedChannelCancelEvent | null {
      if (!rawPayload || typeof rawPayload !== "object") return null;
      const p = rawPayload as Record<string, any>;
      if (!p.cancelledAt && p.cancelled !== true) return null;

      return parseValidatedChannelCancel("dropship_partner", {
        externalOrderId: String(p.externalOrderId ?? "").trim(),
        channelId: context.channelId,
        source: "dropship_partner",
        reason: typeof p.cancelReason === "string" ? p.cancelReason : "partner_cancelled",
        cancelledAt: p.cancelledAt
          ? new Date(String(p.cancelledAt))
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
      const p = rawPayload as Record<string, any>;
      if (p.refundAmountCents === undefined || p.refundAmountCents === null) {
        return null;
      }

      const refundAmountCents = readIntegerCents(
        p.refundAmountCents,
        "refundAmountCents",
      );

      return parseValidatedChannelRefund("dropship_partner", {
        externalOrderId: String(p.externalOrderId ?? "").trim(),
        externalRefundId:
          p.externalRefundId != null ? String(p.externalRefundId) : null,
        channelId: context.channelId,
        source: "dropship_partner",
        financialStatus:
          p.financialStatus === "partially_refunded"
            ? "partially_refunded"
            : "refunded",
        refundAmountCents,
        refundedAt: p.refundedAt
          ? new Date(String(p.refundedAt))
          : context.observedAt ?? new Date(),
        lineItems: [],
        rawPayload,
      });
    },
  };
}
