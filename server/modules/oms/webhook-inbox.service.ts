import { createHash } from "crypto";
import type { Request } from "express";
import { sql } from "drizzle-orm";

export type WebhookInboxStatus = "received" | "processing" | "succeeded" | "failed" | "dead";

export interface WebhookInboxInput {
  provider: string;
  topic: string;
  eventId: string;
  idempotencyKey: string;
  sourceDomain: string | null;
  payload: unknown;
  headers: Record<string, string | string[]>;
}

export interface WebhookInboxReceipt {
  id: number;
  status: WebhookInboxStatus;
  attempts: number;
  inserted: boolean;
}

export interface WebhookInboxReplayResult {
  inboxId: number;
  retryQueueId: number;
  provider: string;
  topic: string;
  previousStatus: WebhookInboxStatus;
}

const REPLAYABLE_SHOPIFY_OMS_TOPICS = new Set([
  "orders/paid",
  "orders/updated",
  "orders/cancelled",
  "orders/fulfilled",
  "refunds/create",
]);

function isReplayableWebhookInboxTopic(provider: string, topic: string): boolean {
  if (provider === "shopify") {
    return REPLAYABLE_SHOPIFY_OMS_TOPICS.has(topic);
  }
  if (provider === "ebay") {
    return topic.toLowerCase().includes("order");
  }
  return false;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function extractShopifyPayloadEventId(topic: string, payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;

  if (topic === "refunds/create") {
    if (payload.id && payload.order_id) return `${payload.order_id}:${payload.id}`;
    if (payload.id) return String(payload.id);
  }

  return String(
    payload.admin_graphql_api_id ??
      payload.id ??
      payload.order_id ??
      payload.name ??
      "",
  ) || null;
}

export function buildWebhookIdempotencyKey(input: {
  provider: string;
  topic: string;
  sourceDomain?: string | null;
  eventId: string;
}): string {
  return [
    input.provider,
    input.topic,
    input.sourceDomain || "unknown",
    input.eventId,
  ].join(":");
}

export function buildShopifyWebhookInboxInput(
  req: Request,
  topic: string,
  payload: unknown,
): WebhookInboxInput {
  const sourceDomain = headerValue(req, "x-shopify-shop-domain") ?? null;
  const webhookId = headerValue(req, "x-shopify-webhook-id");
  const fallbackEventId = extractShopifyPayloadEventId(topic, payload);
  const eventId = webhookId || fallbackEventId || `payload:${sha256(stableJson(payload))}`;

  return {
    provider: "shopify",
    topic,
    eventId,
    idempotencyKey: buildWebhookIdempotencyKey({
      provider: "shopify",
      topic,
      sourceDomain,
      eventId,
    }),
    sourceDomain,
    payload,
    headers: {
      "x-shopify-shop-domain": sourceDomain || "",
      "x-shopify-topic": headerValue(req, "x-shopify-topic") || topic,
      "x-shopify-webhook-id": webhookId || "",
      "x-shopify-triggered-at": headerValue(req, "x-shopify-triggered-at") || "",
    },
  };
}

function firstRow<T>(result: any): T | undefined {
  return Array.isArray(result?.rows) ? result.rows[0] : undefined;
}

export async function recordWebhookReceived(
  db: any,
  input: WebhookInboxInput,
): Promise<WebhookInboxReceipt> {
  const result = await db.execute(sql`
    WITH inserted AS (
      INSERT INTO oms.webhook_inbox (
        provider,
        topic,
        event_id,
        idempotency_key,
        source_domain,
        payload,
        headers
      )
      VALUES (
        ${input.provider},
        ${input.topic},
        ${input.eventId},
        ${input.idempotencyKey},
        ${input.sourceDomain},
        ${JSON.stringify(input.payload)}::jsonb,
        ${JSON.stringify(input.headers)}::jsonb
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id, status, attempts, true AS inserted
    )
    SELECT id, status, attempts, inserted FROM inserted
    UNION ALL
    SELECT id, status, attempts, false AS inserted
    FROM oms.webhook_inbox
    WHERE idempotency_key = ${input.idempotencyKey}
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
  `);

  const row = firstRow<WebhookInboxReceipt>(result);
  if (!row) {
    throw new Error(`Failed to record webhook inbox row for ${input.provider}/${input.topic}`);
  }

  return {
    id: Number(row.id),
    status: row.status,
    attempts: Number(row.attempts) || 0,
    inserted: Boolean(row.inserted),
  };
}

export async function markWebhookProcessing(db: any, inboxId: number): Promise<void> {
  await db.execute(sql`
    UPDATE oms.webhook_inbox
    SET status = 'processing',
        attempts = attempts + 1,
        last_attempt_at = NOW(),
        updated_at = NOW()
    WHERE id = ${inboxId}
  `);
}

export async function markWebhookSucceeded(db: any, inboxId: number): Promise<void> {
  await db.execute(sql`
    UPDATE oms.webhook_inbox
    SET status = 'succeeded',
        last_error = NULL,
        processed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${inboxId}
  `);
}

export async function markWebhookFailed(db: any, inboxId: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.execute(sql`
    UPDATE oms.webhook_inbox
    SET status = 'failed',
        last_error = ${message},
        updated_at = NOW()
    WHERE id = ${inboxId}
  `);
}

export async function enqueueWebhookInboxReplay(
  db: any,
  inboxId: number,
  operator: string,
): Promise<WebhookInboxReplayResult> {
  if (!Number.isInteger(inboxId) || inboxId <= 0) {
    throw new Error(`webhook inbox id must be a positive integer (got ${inboxId})`);
  }

  const inboxResult = await db.execute(sql`
    SELECT id, provider, topic, payload, status
    FROM oms.webhook_inbox
    WHERE id = ${inboxId}
    LIMIT 1
  `);
  const inbox = firstRow<{
    id: number;
    provider: string;
    topic: string;
    payload: unknown;
    status: WebhookInboxStatus;
  }>(inboxResult);

  if (!inbox) {
    throw new Error(`webhook inbox row ${inboxId} not found`);
  }
  if (!isReplayableWebhookInboxTopic(inbox.provider, inbox.topic)) {
    throw new Error(`webhook inbox row ${inboxId} is not a replayable OMS webhook topic`);
  }
  if (inbox.status === "succeeded") {
    throw new Error(`webhook inbox row ${inboxId} already succeeded`);
  }

  const runReplay = async (tx: any): Promise<{ id: number }> => {
    const reason = `manual replay from webhook_inbox ${inboxId} by ${operator || "unknown"}`;
    const retryResult = await tx.execute(sql`
      INSERT INTO oms.webhook_retry_queue (
        provider,
        topic,
        payload,
        attempts,
        last_error,
        next_retry_at,
        status
      )
      VALUES (
        ${inbox.provider},
        ${inbox.topic},
        ${JSON.stringify(inbox.payload)}::jsonb,
        0,
        ${reason},
        NOW(),
        'pending'
      )
      RETURNING id
    `);
    const retry = firstRow<{ id: number }>(retryResult);
    if (!retry) {
      throw new Error(`failed to enqueue replay for webhook inbox row ${inboxId}`);
    }

    await tx.execute(sql`
      UPDATE oms.webhook_inbox
      SET status = 'received',
          last_error = NULL,
          updated_at = NOW()
      WHERE id = ${inboxId}
    `);

    return retry;
  };

  const retry = typeof db.transaction === "function"
    ? await db.transaction(runReplay)
    : await runReplay(db);

  console.warn(
    `[OMS Webhook Inbox] queued replay retry=${retry.id} inbox=${inboxId} topic=${inbox.topic} operator=${operator || "unknown"}`,
  );

  return {
    inboxId,
    retryQueueId: Number(retry.id),
    provider: inbox.provider,
    topic: inbox.topic,
    previousStatus: inbox.status,
  };
}

export function buildEbayWebhookInboxInput(
  req: Request,
  payload: any,
): WebhookInboxInput {
  const topic = String(payload?.metadata?.topic || "unknown");
  const sourceDomain = "ebay";
  const notificationId = String(payload?.notification?.notificationId || "");
  const orderId = String(payload?.notification?.data?.orderId || "");
  const eventId = notificationId || (orderId ? `${topic}:${orderId}` : `payload:${sha256(stableJson(payload))}`);

  return {
    provider: "ebay",
    topic,
    eventId,
    idempotencyKey: buildWebhookIdempotencyKey({
      provider: "ebay",
      topic,
      sourceDomain,
      eventId,
    }),
    sourceDomain,
    payload,
    headers: {
      "user-agent": headerValue(req, "user-agent") || "",
      "x-ebay-signature": headerValue(req, "x-ebay-signature") || "",
      "x-ebay-transmission-id": headerValue(req, "x-ebay-transmission-id") || "",
    },
  };
}
