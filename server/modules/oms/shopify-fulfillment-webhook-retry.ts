import { createHash } from "node:crypto";

import { webhookRetryQueue } from "@shared/schema";

export type ShopifyFulfillmentWebhookTopic =
  | "fulfillments/create"
  | "fulfillments/update";

const SOURCE_EVENT_FIELD = "__echelon_source_event_id";
const SOURCE_CHANNEL_FIELD = "__echelon_source_channel_id";
const SHOP_DOMAIN_FIELD = "shop_domain";

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function payloadHash(payload: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

export interface ShopifyFulfillmentRetryEnvelope {
  readonly retryKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function buildShopifyFulfillmentRetryEnvelope(input: {
  topic: ShopifyFulfillmentWebhookTopic;
  payload: Readonly<Record<string, unknown>>;
  sourceEventId: string | null;
  sourceChannelId: number | null;
  shopDomain: string | null;
}): ShopifyFulfillmentRetryEnvelope {
  const sourceEventId = nullableText(input.sourceEventId);
  const sourceChannelId = positiveInteger(input.sourceChannelId);
  const shopDomain = nullableText(input.shopDomain)?.toLowerCase() ?? null;
  const eventIdentity = sourceEventId ?? payloadHash(input.payload);
  const retryKey = [
    "shopify-fulfillment-webhook:v1",
    input.topic,
    String(sourceChannelId ?? 0),
    shopDomain ?? "unknown-shop",
    eventIdentity,
  ].join(":");

  if (retryKey.length > 1_000) {
    throw new Error(`Shopify fulfillment retry key exceeds 1000 characters (${retryKey.length})`);
  }

  return Object.freeze({
    retryKey,
    payload: Object.freeze({
      ...input.payload,
      ...(sourceEventId ? { [SOURCE_EVENT_FIELD]: sourceEventId } : {}),
      ...(sourceChannelId ? { [SOURCE_CHANNEL_FIELD]: sourceChannelId } : {}),
      ...(shopDomain ? { [SHOP_DOMAIN_FIELD]: shopDomain } : {}),
    }),
  });
}

export function sourceEventIdFromRetryPayload(payload: unknown): string | null {
  return nullableText((payload as Record<string, unknown> | null)?.[SOURCE_EVENT_FIELD]);
}

export function sourceChannelIdFromRetryPayload(payload: unknown): number | null {
  return positiveInteger((payload as Record<string, unknown> | null)?.[SOURCE_CHANNEL_FIELD]);
}

export type ReceiptRecoveryOwnedStatus = "pending" | "processing";

export function receiptRecoveryOwnedStatus(
  error: unknown,
): ReceiptRecoveryOwnedStatus | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "RECEIPT_ALREADY_PROCESSING") return "processing";
  if (code === "RECEIPT_RETRY_NOT_DUE") return "pending";
  return null;
}

export async function enqueueShopifyFulfillmentWebhookRetry(
  dbArg: any,
  input: {
    topic: ShopifyFulfillmentWebhookTopic;
    envelope: ShopifyFulfillmentRetryEnvelope;
    errorMessage: string;
  },
): Promise<void> {
  await dbArg
    .insert(webhookRetryQueue)
    .values({
      provider: "shopify",
      topic: input.topic,
      payload: input.envelope.payload,
      retryKey: input.envelope.retryKey,
      lastError: input.errorMessage,
    })
    .onConflictDoNothing();
}
