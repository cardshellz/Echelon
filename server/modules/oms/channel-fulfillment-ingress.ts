import { createHash } from "node:crypto";

import { z } from "zod";

const identifier = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const optionalIdentifier = (maxLength: number) => identifier(maxLength).nullable().optional();

const ingressLineSchema = z.object({
  channelOrderLineId: identifier(200),
  sourceFulfillmentLineId: optionalIdentifier(200),
  quantity: z.number().int().positive(),
}).strict();

const ingressSchema = z.object({
  sourceProvider: identifier(40).transform((value) => value.toLowerCase()),
  sourceChannelId: z.number().int().positive().nullable().optional(),
  sourceOrderId: identifier(200),
  sourceFulfillmentId: identifier(200),
  sourceEventId: optionalIdentifier(200),
  sourceInboxId: z.number().int().positive().nullable().optional(),
  eventKind: z.enum(["created", "updated", "reconciled"]),
  source: identifier(80),
  trackingNumber: optionalIdentifier(200),
  carrier: optionalIdentifier(100),
  trackingUrl: z.string().trim().url().max(2_000).nullable().optional(),
  shippedAt: z.coerce.date().nullable().optional(),
  correlationId: optionalIdentifier(100),
  causationId: optionalIdentifier(100),
  rawPayload: z.unknown().optional(),
  lineItems: z.array(ingressLineSchema).min(1),
}).strict();

export type ChannelFulfillmentIngressInput = z.input<typeof ingressSchema>;

export interface NormalizedChannelFulfillmentIngressLine {
  readonly channelOrderLineId: string;
  readonly sourceFulfillmentLineId: string | null;
  readonly quantity: number;
}

export interface NormalizedChannelFulfillmentIngress {
  readonly receiptKey: string;
  readonly requestHash: string;
  readonly sourceProvider: string;
  readonly sourceChannelId: number | null;
  readonly sourceOrderId: string;
  readonly sourceFulfillmentId: string;
  readonly sourceEventId: string | null;
  readonly sourceInboxId: number | null;
  readonly eventKind: "created" | "updated" | "reconciled";
  readonly source: string;
  readonly trackingNumber: string | null;
  readonly carrier: string | null;
  readonly trackingUrl: string | null;
  readonly shippedAt: Date | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly rawPayload: unknown;
  readonly lineItems: readonly NormalizedChannelFulfillmentIngressLine[];
}

export type ChannelFulfillmentIngressErrorCode =
  | "INVALID_INPUT"
  | "TRACKING_REQUIRED"
  | "SOURCE_ORDER_NOT_FOUND"
  | "SOURCE_ORDER_AMBIGUOUS"
  | "SOURCE_CHANNEL_MISMATCH"
  | "CHANNEL_LINE_NOT_FOUND"
  | "CHANNEL_LINE_AMBIGUOUS"
  | "WMS_LINEAGE_MISSING"
  | "WMS_LINEAGE_AMBIGUOUS"
  | "FULFILLMENT_AUTHORITY_EXCEEDED"
  | "PACKAGE_ITEM_CONFLICT"
  | "ECHO_COMMAND_CONFLICT"
  | "CANONICAL_PACKAGE_CONFLICT"
  | "RECEIPT_ALREADY_PROCESSING"
  | "RECEIPT_RETRY_NOT_DUE"
  | "RECEIPT_LEASE_RETRY_EXHAUSTED"
  | "RECEIPT_LEASE_OWNERSHIP_LOST"
  | "INVENTORY_RECORD_FAILED"
  | "ENGINE_CANCEL_FAILED";

export class ChannelFulfillmentIngressError extends Error {
  readonly code: ChannelFulfillmentIngressErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  readonly reviewRequired: boolean;

  constructor(
    code: ChannelFulfillmentIngressErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    options: { reviewRequired?: boolean } = {},
  ) {
    super(message);
    this.name = "ChannelFulfillmentIngressError";
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.reviewRequired = options.reviewRequired ?? true;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function normalizeLines(
  lines: readonly z.infer<typeof ingressLineSchema>[],
): readonly NormalizedChannelFulfillmentIngressLine[] {
  const grouped = new Map<string, { quantity: number; sourceIds: Set<string> }>();
  for (const line of lines) {
    const current = grouped.get(line.channelOrderLineId) ?? {
      quantity: 0,
      sourceIds: new Set<string>(),
    };
    const quantity = current.quantity + line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new ChannelFulfillmentIngressError(
        "INVALID_INPUT",
        `Fulfillment quantity is invalid for channel line ${line.channelOrderLineId}`,
        { channelOrderLineId: line.channelOrderLineId, quantity },
      );
    }
    current.quantity = quantity;
    if (line.sourceFulfillmentLineId) {
      current.sourceIds.add(line.sourceFulfillmentLineId);
    }
    grouped.set(line.channelOrderLineId, current);
  }

  return Object.freeze([...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([channelOrderLineId, item]) => Object.freeze({
      channelOrderLineId,
      sourceFulfillmentLineId: item.sourceIds.size === 1
        ? [...item.sourceIds][0]
        : null,
      quantity: item.quantity,
    })));
}

export function normalizeChannelFulfillmentIngress(
  input: ChannelFulfillmentIngressInput,
): NormalizedChannelFulfillmentIngress {
  const parsed = ingressSchema.safeParse(input);
  if (!parsed.success) {
    throw new ChannelFulfillmentIngressError(
      "INVALID_INPUT",
      "Channel fulfillment receipt is invalid",
      { issues: parsed.error.issues },
    );
  }

  const lineItems = normalizeLines(parsed.data.lineItems);
  const requestSnapshot = {
    sourceProvider: parsed.data.sourceProvider,
    sourceChannelId: parsed.data.sourceChannelId ?? null,
    sourceOrderId: parsed.data.sourceOrderId,
    sourceFulfillmentId: parsed.data.sourceFulfillmentId,
    eventKind: parsed.data.eventKind,
    trackingNumber: parsed.data.trackingNumber ?? null,
    carrier: parsed.data.carrier ?? null,
    trackingUrl: parsed.data.trackingUrl ?? null,
    shippedAt: parsed.data.shippedAt?.toISOString() ?? null,
    lineItems,
  };
  const requestHash = hash(stableJson(requestSnapshot));
  const eventIdentity = parsed.data.sourceEventId ?? requestHash;
  const receiptKey = [
    "channel-fulfillment-receipt:v1",
    parsed.data.sourceProvider,
    String(parsed.data.sourceChannelId ?? 0),
    parsed.data.sourceOrderId,
    parsed.data.sourceFulfillmentId,
    parsed.data.eventKind,
    eventIdentity,
  ].join(":");
  if (receiptKey.length > 500) {
    throw new ChannelFulfillmentIngressError(
      "INVALID_INPUT",
      "Channel fulfillment receipt identity exceeds the persistence limit",
      { receiptKeyLength: receiptKey.length, maxLength: 500 },
    );
  }

  return Object.freeze({
    receiptKey,
    requestHash,
    sourceProvider: parsed.data.sourceProvider,
    sourceChannelId: parsed.data.sourceChannelId ?? null,
    sourceOrderId: parsed.data.sourceOrderId,
    sourceFulfillmentId: parsed.data.sourceFulfillmentId,
    sourceEventId: parsed.data.sourceEventId ?? null,
    sourceInboxId: parsed.data.sourceInboxId ?? null,
    eventKind: parsed.data.eventKind,
    source: parsed.data.source,
    trackingNumber: parsed.data.trackingNumber ?? null,
    carrier: parsed.data.carrier ?? null,
    trackingUrl: parsed.data.trackingUrl ?? null,
    shippedAt: parsed.data.shippedAt ?? null,
    correlationId: parsed.data.correlationId ?? null,
    causationId: parsed.data.causationId ?? null,
    rawPayload: parsed.data.rawPayload ?? {},
    lineItems,
  });
}
