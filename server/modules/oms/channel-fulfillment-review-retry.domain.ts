import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

export const CHANNEL_FULFILLMENT_REVIEW_RETRY = "CHANNEL_FULFILLMENT_REVIEW_RETRY";
const positiveId = z.number().int().positive().safe();
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const nullableText = z.string().nullable();

export class ChannelFulfillmentReviewRetryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ChannelFulfillmentReviewRetryError";
  }
}

export const reviewRetryScopeSchema = z.object({
  commandId: positiveId,
  omsOrderId: positiveId,
}).strict();

export const reviewRetryInputSchema = reviewRetryScopeSchema.extend({
  previewOnly: z.boolean().default(true),
  expectedStateFingerprint: fingerprintSchema.optional(),
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strict().superRefine((input, context) => {
  if (!input.previewOnly && (!input.expectedStateFingerprint || !input.reason)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Execution requires the preview fingerprint and an operator reason",
    });
  }
});

export const reviewRetrySnapshotSchema = z.object({
  commandId: positiveId,
  omsOrderId: positiveId,
  orderNumber: nullableText,
  externalOrderId: z.string().min(1),
  channelId: positiveId,
  provider: z.string().min(1),
  physicalShipmentId: positiveId,
  providerPhysicalShipmentId: nullableText,
  trackingNumber: z.string().min(1),
  carrier: z.string().min(1),
  trackingUrl: nullableText,
  shippedAt: nullableText,
  channelFulfillmentScopeKey: z.string().min(1),
  metadata: z.record(z.unknown()),
  commandKey: z.string().min(1),
  requestHash: fingerprintSchema,
  status: z.string().min(1),
  attemptCount: z.number().int().nonnegative().safe(),
  maxAttempts: positiveId,
  lastErrorCode: nullableText,
  lastError: nullableText,
  leaseToken: nullableText,
  items: z.array(z.object({
    pushItemId: positiveId,
    physicalShipmentItemId: positiveId.nullable(),
    omsOrderLineId: positiveId,
    channelOrderLineId: nullableText,
    quantity: positiveId,
    sku: nullableText,
  }).strict()).max(500),
}).strict();

export type ChannelFulfillmentReviewRetrySnapshot = z.infer<typeof reviewRetrySnapshotSchema>;
export type ChannelFulfillmentReviewRetryScope = z.infer<typeof reviewRetryScopeSchema>;
export interface ChannelFulfillmentReviewRetryPreview {
  readonly commandId: number;
  readonly omsOrderId: number;
  readonly eligibleForRecheck: boolean;
  readonly blockers: readonly string[];
  readonly stateFingerprint: string;
  readonly snapshot: ChannelFulfillmentReviewRetrySnapshot;
  readonly providerValidation: "not_performed";
}
export interface ChannelFulfillmentReviewRetryResult extends ChannelFulfillmentReviewRetryPreview {
  readonly mode: "preview" | "execute";
  readonly replayed: boolean;
  readonly requeued: boolean;
}

export interface ChannelFulfillmentReviewRetryExecution extends ChannelFulfillmentReviewRetryScope {
  readonly expectedStateFingerprint: string;
  readonly actor: string;
  readonly reason: string;
  readonly requeuedAt: Date;
}

export const reviewRetryExecutionSchema = reviewRetryScopeSchema.extend({
  expectedStateFingerprint: fingerprintSchema,
  actor: z.string().trim().min(1).max(200).refine((value) => value !== "unknown"),
  reason: z.string().trim().min(1).max(2_000),
  requeuedAt: z.date(),
}).strict();

export function previewChannelFulfillmentReviewRetry(
  rawSnapshot: ChannelFulfillmentReviewRetrySnapshot,
): ChannelFulfillmentReviewRetryPreview {
  const snapshot = reviewRetrySnapshotSchema.parse(rawSnapshot);
  snapshot.items.sort((left, right) => left.pushItemId - right.pushItemId);
  const blockers: string[] = [];
  if (snapshot.status !== "review") blockers.push("COMMAND_NOT_IN_REVIEW");
  if (snapshot.leaseToken !== null) blockers.push("COMMAND_HAS_ACTIVE_LEASE");
  if (snapshot.attemptCount >= snapshot.maxAttempts) blockers.push("ATTEMPTS_EXHAUSTED");
  const supportedFailure = (
    snapshot.provider === "shopify"
    && snapshot.lastErrorCode === "channel_fulfillment_lineage_mismatch"
  ) || (
    snapshot.provider === "ebay"
    && snapshot.lastErrorCode === "ebay_fulfillment_idempotency_conflict"
  );
  if (!supportedFailure) blockers.push("REVIEW_REASON_NOT_SUPPORTED");
  if (snapshot.items.length === 0) blockers.push("COMMAND_HAS_NO_ITEMS");
  if (new Set(snapshot.items.map((item) => item.pushItemId)).size !== snapshot.items.length) {
    blockers.push("DUPLICATE_COMMAND_ITEM");
  }
  // Eligibility grants a new check, never package authority. The normal worker
  // still verifies immutable allocation lineage and live provider state in full.
  return Object.freeze({
    commandId: snapshot.commandId,
    omsOrderId: snapshot.omsOrderId,
    eligibleForRecheck: blockers.length === 0,
    blockers: Object.freeze(blockers),
    stateFingerprint: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    snapshot,
    providerValidation: "not_performed" as const,
  });
}

export function reviewRetryIdempotencyKey(input: ChannelFulfillmentReviewRetryExecution): string {
  // A later failed worker attempt changes the state fingerprint and therefore
  // requires a fresh explicit action. Repeating this exact action cannot reset it.
  const hash = createHash("sha256").update(canonicalJson({
    commandId: input.commandId,
    omsOrderId: input.omsOrderId,
    expectedStateFingerprint: input.expectedStateFingerprint,
    actor: input.actor,
    reason: input.reason,
  })).digest("hex");
  return `reviewed-provider-retry:v1:${hash}`;
}
