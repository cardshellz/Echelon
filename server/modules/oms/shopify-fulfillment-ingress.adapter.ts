import { z } from "zod";

import type { ChannelFulfillmentIngressInput } from "./channel-fulfillment-ingress";
import type {
  ChannelFulfillmentIngressResult,
  ChannelFulfillmentIngressService,
} from "./channel-fulfillment-ingress.service";

function normalizeShopifyResourceId(value: string | number): string {
  const text = String(value).trim();
  const gidMatch = /^gid:\/\/shopify\/[^/]+\/(\d+)$/.exec(text);
  return gidMatch?.[1] ?? text;
}

const shopifyId = z.union([z.string().trim().min(1), z.number().int().positive()])
  .transform(normalizeShopifyResourceId);

const shopifyFulfillmentLineSchema = z.object({
  id: shopifyId,
  quantity: z.number().int().positive(),
}).passthrough();

const shopifyFulfillmentSchema = z.object({
  id: shopifyId,
  order_id: shopifyId,
  status: z.string().trim().toLowerCase().optional(),
  tracking_number: z.string().trim().min(1).nullable().optional(),
  tracking_url: z.string().trim().url().nullable().optional(),
  tracking_company: z.string().trim().min(1).nullable().optional(),
  created_at: z.string().datetime({ offset: true }).nullable().optional(),
  updated_at: z.string().datetime({ offset: true }).nullable().optional(),
  line_items: z.array(shopifyFulfillmentLineSchema).min(1),
}).passthrough();

const SHOPIFY_TO_CANONICAL_CARRIER: Readonly<Record<string, string>> = Object.freeze({
  usps: "USPS",
  "u.s. postal service": "USPS",
  ups: "UPS",
  fedex: "FedEx",
  "federal express": "FedEx",
  dhl: "DHL",
  "dhl express": "DHL",
  "dhl ecommerce": "DHL",
});

export class ShopifyFulfillmentIngressPayloadError extends Error {
  readonly code = "SHOPIFY_FULFILLMENT_PAYLOAD_INVALID";
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "ShopifyFulfillmentIngressPayloadError";
    this.context = Object.freeze({ ...context });
  }
}

export interface ShopifyFulfillmentIngressMetadata {
  readonly sourceChannelId: number | null;
  readonly sourceEventId: string | null;
  readonly sourceInboxId?: number | null;
  readonly eventKind: "created" | "updated" | "reconciled";
  readonly source: string;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
}

export interface ShopifyFulfillmentIngressOutcome {
  readonly actionable: boolean;
  readonly result: ChannelFulfillmentIngressResult | null;
}

export function mapShopifyFulfillmentCarrier(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return SHOPIFY_TO_CANONICAL_CARRIER[normalized.toLowerCase()] ?? normalized.toUpperCase();
}

export function mapShopifyFulfillmentIngress(
  payload: unknown,
  metadata: ShopifyFulfillmentIngressMetadata,
): ChannelFulfillmentIngressInput | null {
  const parsed = shopifyFulfillmentSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ShopifyFulfillmentIngressPayloadError(
      "Shopify fulfillment payload is missing exact order, fulfillment, or line identity",
      { issues: parsed.error.issues },
    );
  }
  if (parsed.data.status && parsed.data.status !== "success") return null;

  const eventTimestamp = parsed.data.updated_at ?? parsed.data.created_at ?? null;
  return {
    sourceProvider: "shopify",
    sourceChannelId: metadata.sourceChannelId,
    sourceOrderId: parsed.data.order_id,
    sourceFulfillmentId: parsed.data.id,
    sourceEventId: metadata.sourceEventId,
    sourceInboxId: metadata.sourceInboxId ?? null,
    eventKind: metadata.eventKind,
    source: metadata.source,
    trackingNumber: parsed.data.tracking_number ?? null,
    carrier: mapShopifyFulfillmentCarrier(parsed.data.tracking_company),
    trackingUrl: parsed.data.tracking_url ?? null,
    shippedAt: eventTimestamp ? new Date(eventTimestamp) : null,
    correlationId: metadata.correlationId ?? null,
    causationId: metadata.causationId ?? metadata.sourceEventId,
    rawPayload: payload,
    lineItems: parsed.data.line_items.map((line) => ({
      channelOrderLineId: line.id,
      sourceFulfillmentLineId: line.id,
      quantity: line.quantity,
    })),
  };
}

export async function processShopifyFulfillmentIngress(
  service: ChannelFulfillmentIngressService,
  payload: unknown,
  metadata: ShopifyFulfillmentIngressMetadata,
): Promise<ShopifyFulfillmentIngressOutcome> {
  const input = mapShopifyFulfillmentIngress(payload, metadata);
  if (!input) return Object.freeze({ actionable: false, result: null });
  return Object.freeze({ actionable: true, result: await service.process(input) });
}
