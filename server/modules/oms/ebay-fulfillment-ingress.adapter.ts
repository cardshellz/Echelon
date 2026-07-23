import { z } from "zod";

import type { ChannelFulfillmentIngressInput } from "./channel-fulfillment-ingress";
import type {
  ChannelFulfillmentIngressResult,
  ChannelFulfillmentIngressService,
} from "./channel-fulfillment-ingress.service";

const ebayId = z.union([z.string().trim().min(1), z.number().int().positive()])
  .transform((value) => String(value));

const ebayFulfillmentLineSchema = z.object({
  lineItemId: ebayId,
  quantity: z.number().int().positive(),
}).passthrough();

const ebayShippingFulfillmentSchema = z.object({
  fulfillmentId: ebayId,
  lineItems: z.array(ebayFulfillmentLineSchema).min(1),
  shippedDate: z.string().datetime({ offset: true }).nullable().optional(),
  shippingCarrierCode: z.string().trim().min(1).nullable().optional(),
  shipmentTrackingNumber: z.string().trim().min(1).nullable().optional(),
}).passthrough();

export class EbayFulfillmentIngressPayloadError extends Error {
  readonly code = "EBAY_FULFILLMENT_PAYLOAD_INVALID";
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "EbayFulfillmentIngressPayloadError";
    this.context = Object.freeze({ ...context });
  }
}

export interface EbayFulfillmentIngressMetadata {
  readonly sourceChannelId: number | null;
  readonly sourceOrderId: string;
  readonly sourceEventId: string | null;
  readonly sourceInboxId?: number | null;
  readonly source: string;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
}

export function mapEbayFulfillmentIngress(
  payload: unknown,
  metadata: EbayFulfillmentIngressMetadata,
): ChannelFulfillmentIngressInput {
  const parsed = ebayShippingFulfillmentSchema.safeParse(payload);
  if (!parsed.success) {
    throw new EbayFulfillmentIngressPayloadError(
      "eBay fulfillment payload is missing exact fulfillment or line identity",
      { issues: parsed.error.issues },
    );
  }

  return {
    sourceProvider: "ebay",
    sourceChannelId: metadata.sourceChannelId,
    sourceOrderId: metadata.sourceOrderId,
    sourceFulfillmentId: parsed.data.fulfillmentId,
    sourceEventId: metadata.sourceEventId,
    sourceInboxId: metadata.sourceInboxId ?? null,
    eventKind: "reconciled",
    source: metadata.source,
    trackingNumber: parsed.data.shipmentTrackingNumber ?? null,
    carrier: parsed.data.shippingCarrierCode ?? null,
    trackingUrl: null,
    shippedAt: parsed.data.shippedDate ? new Date(parsed.data.shippedDate) : null,
    correlationId: metadata.correlationId ?? null,
    causationId: metadata.causationId ?? metadata.sourceEventId,
    rawPayload: payload,
    lineItems: parsed.data.lineItems.map((line) => ({
      channelOrderLineId: line.lineItemId,
      sourceFulfillmentLineId: line.lineItemId,
      quantity: line.quantity,
    })),
  };
}

export async function processEbayFulfillmentIngress(
  service: ChannelFulfillmentIngressService,
  payload: unknown,
  metadata: EbayFulfillmentIngressMetadata,
): Promise<ChannelFulfillmentIngressResult> {
  return service.process(mapEbayFulfillmentIngress(payload, metadata));
}
