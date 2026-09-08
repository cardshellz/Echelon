import { z } from "zod";
import { apiRequest } from "./queryClient";

export const FULFILLMENT_REVIEW_RETRY_CODE = "CHANNEL_FULFILLMENT_REVIEW_RETRY";
export const FULFILLMENT_REVIEW_REASON_LIMIT = 2_000;
const endpoint = "/api/oms/ops/reconciliation/remediate";
const positiveId = z.number().int().positive().safe();
const scopeSchema = z.object({ commandId: positiveId, omsOrderId: positiveId });
export type FulfillmentReviewScope = z.infer<typeof scopeSchema>;

// Validate the fields this view consumes. Other owner evidence stays server-owned;
// notably the UI never submits an actor, quantities, eligibility or a new status.
const resultSchema = z.object({
  mode: z.enum(["preview", "execute"]),
  commandId: positiveId,
  omsOrderId: positiveId,
  eligibleForRecheck: z.boolean(),
  blockers: z.array(z.string().min(1)),
  stateFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  providerValidation: z.literal("not_performed"),
  replayed: z.boolean(),
  requeued: z.boolean(),
  snapshot: z.object({
    commandId: positiveId,
    omsOrderId: positiveId,
    orderNumber: z.string().nullable(),
    externalOrderId: z.string().min(1),
    provider: z.string().min(1),
    trackingNumber: z.string().min(1),
    carrier: z.string().min(1),
    providerPhysicalShipmentId: z.string().nullable(),
    status: z.string().min(1),
    lastErrorCode: z.string().nullable(),
    items: z.array(z.object({
      pushItemId: positiveId,
      channelOrderLineId: z.string().nullable(),
      sku: z.string().nullable(),
      quantity: positiveId,
    })).max(500),
  }),
});
export type FulfillmentReviewResult = z.infer<typeof resultSchema>;

function locatorId(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) return null;
  const parsed = positiveId.safeParse(Number(value));
  return parsed.success ? parsed.data : null;
}

export function fulfillmentReviewScopeForWorkItem(item: {
  domain: string;
  code: string;
  triageStatus: string;
  detailLocator: Record<string, unknown>;
}): FulfillmentReviewScope | null {
  if (item.domain !== "shipping" || item.code !== "channel_fulfillment_review"
    || item.triageStatus === "resolved"
    || item.detailLocator.sourceTable !== "oms.channel_fulfillment_pushes") return null;
  const commandId = locatorId(item.detailLocator.sourceId);
  const omsOrderId = locatorId(item.detailLocator.omsOrderId);
  return commandId === null || omsOrderId === null ? null : { commandId, omsOrderId };
}

export function buildFulfillmentReviewPreviewRequest(scope: FulfillmentReviewScope) {
  return { code: FULFILLMENT_REVIEW_RETRY_CODE, ...scopeSchema.parse(scope), previewOnly: true as const };
}

function assertResultScope(result: FulfillmentReviewResult, scope: FulfillmentReviewScope): void {
  if (result.commandId !== scope.commandId || result.omsOrderId !== scope.omsOrderId
    || result.snapshot.commandId !== scope.commandId || result.snapshot.omsOrderId !== scope.omsOrderId) {
    throw new Error("The preview belongs to a different shipment. Load a fresh preview.");
  }
}

export function buildFulfillmentReviewRetryRequest(
  scope: FulfillmentReviewScope,
  preview: FulfillmentReviewResult,
  reason: string,
) {
  const target = scopeSchema.parse(scope);
  const checked = resultSchema.parse(preview);
  assertResultScope(checked, target);
  if (checked.mode !== "preview" || !checked.eligibleForRecheck || checked.blockers.length > 0
    || checked.replayed || checked.requeued) {
    throw new Error("A fresh eligible preview is required before queuing a recheck.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason || normalizedReason.length > FULFILLMENT_REVIEW_REASON_LIMIT) {
    throw new Error(`Enter a reason of 1–${FULFILLMENT_REVIEW_REASON_LIMIT} characters.`);
  }
  return { code: FULFILLMENT_REVIEW_RETRY_CODE, ...target, previewOnly: false as const,
    expectedStateFingerprint: checked.stateFingerprint, reason: normalizedReason };
}

type ReviewRequest = ReturnType<typeof buildFulfillmentReviewPreviewRequest> | ReturnType<typeof buildFulfillmentReviewRetryRequest>;

export async function requestFulfillmentReviewRetry(
  body: ReviewRequest,
  send: typeof apiRequest = apiRequest,
): Promise<FulfillmentReviewResult> {
  const response = await send("POST", endpoint, body);
  const envelope = z.object({ code: z.literal(FULFILLMENT_REVIEW_RETRY_CODE), reviewRetry: resultSchema }).parse(await response.json());
  const result = envelope.reviewRetry;
  assertResultScope(result, body);
  if (result.mode !== (body.previewOnly ? "preview" : "execute")
    || (result.mode === "preview" && (result.replayed || result.requeued))
    || (result.mode === "execute" && result.replayed === result.requeued)
    || result.eligibleForRecheck !== (result.blockers.length === 0)) {
    throw new Error("The server returned an inconsistent recheck result. Load a fresh preview.");
  }
  return result;
}

export function fulfillmentReviewFailureMessage(error: unknown, mode: "preview" | "execute"): string {
  const message = error instanceof Error ? error.message : "";
  if (/^(401|403):/.test(message)) return "You do not have permission to recheck this shipment.";
  if (/^(404|409):/.test(message)) return "This command changed or is no longer eligible. Load a fresh preview.";
  if (mode === "preview") return "The preview could not be loaded. No recheck was requested. Try loading the preview again.";
  return "The recheck outcome could not be confirmed. Load a fresh preview before making another request.";
}

const blockerLabels: Readonly<Record<string, string>> = {
  COMMAND_NOT_IN_REVIEW: "This command is no longer in review.",
  COMMAND_HAS_ACTIVE_LEASE: "A worker is already processing this command.",
  ATTEMPTS_EXHAUSTED: "This command has reached its retry limit.",
  REVIEW_REASON_NOT_SUPPORTED: "This review reason is not supported by this recheck action.",
  COMMAND_HAS_NO_ITEMS: "The command has no item evidence.",
  DUPLICATE_COMMAND_ITEM: "The command contains duplicate item evidence.",
};
export function fulfillmentReviewBlockerLabel(code: string): string {
  return blockerLabels[code] ?? `Recheck blocked: ${code}`;
}
