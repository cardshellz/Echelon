import { z } from "zod";
import { canonicalJson } from "../utils/canonical-json";
import { rfqCreateIntentSchema, rfqCreateReceiptSchema, rfqCreateRejectionDetailsSchema } from "./rfq-create-command";
import {
  rfqConversionResultSchema, rfqConvertSchema, rfqQuoteCaptureSchema,
  rfqReleaseSchema, rfqResourceIdSchema, rfqWorkflowDetailSchema,
} from "./rfq-workflow";

export const RFQ_RECEIPT_VERSION_HEADER = "X-RFQ-Receipt-Version";
export const rfqCommandIntentSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("capture_quote"), rfqId: rfqResourceIdSchema,
    lineId: rfqResourceIdSchema, payload: rfqQuoteCaptureSchema }).strict(),
  z.object({ operation: z.literal("release"), rfqId: rfqResourceIdSchema,
    payload: rfqReleaseSchema }).strict(),
  z.object({ operation: z.literal("convert"), rfqId: rfqResourceIdSchema,
    payload: rfqConvertSchema }).strict(),
]);
export type RfqCommandIntent = z.infer<typeof rfqCommandIntentSchema>;

const actorId = z.string().min(1).max(200).refine(value => value.trim() === value);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/);
const receipt = z.object({
  version: z.literal(1), actorId, idempotencyKey, intent: rfqCommandIntentSchema,
  result: z.union([rfqWorkflowDetailSchema, rfqConversionResultSchema]),
}).strict();

/** The saved result must prove the exact submitted effect, not merely resemble
 * a valid RFQ or purchase. Later reads never replace this immutable receipt. */
export const rfqCommandReceiptSchema = receipt.superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom,
    message: "The RFQ command receipt does not prove the submitted operation" });
  const { intent, result } = value;
  if (intent.operation === "convert") {
    const parsed = rfqConversionResultSchema.safeParse(result);
    if (!parsed.success || parsed.data.rfqId !== intent.rfqId) { invalid(); return; }
    const actual = parsed.data.lines;
    const expected = intent.payload.lines;
    if (actual.length !== expected.length
        || new Set(actual.map(line => line.rfqLineId)).size !== actual.length
        || new Set(actual.map(line => line.purchaseOrderLineId)).size !== actual.length
        || expected.some(line => !actual.some(saved => saved.rfqLineId === line.rfqLineId
          && saved.quoteRevisionId === line.quoteRevisionId))) invalid();
    return;
  }
  const parsed = rfqWorkflowDetailSchema.safeParse(result);
  if (!parsed.success || parsed.data.id !== intent.rfqId
      || parsed.data.version === intent.payload.expectedVersion) { invalid(); return; }
  const workflow = parsed.data;
  if (intent.operation === "capture_quote") {
    const line = workflow.lines.find(row => row.id === intent.lineId);
    if (!line || line.status !== "quoted" || line.purchaseOrder !== null
        || !line.latestQuote || line.latestQuote.rfqLineId !== intent.lineId
        || line.latestQuote.createdBy !== value.actorId
        || line.latestQuote.currency !== workflow.currency
        || canonicalJson(line.latestQuote.quote) !== canonicalJson(intent.payload.quote)) invalid();
    return;
  }
  if (workflow.status !== "cancelled"
      || !workflow.lines.some(line => line.status === "cancelled" && line.purchaseOrder === null)
      || workflow.lines.some(line => line.purchaseOrder === null
        && ["draft", "sent", "quoted", "accepted", "ordered"].includes(line.status))) invalid();
});
export type RfqCommandReceipt = z.infer<typeof rfqCommandReceiptSchema>;

export const rfqCommandRejectionDetailsSchema = z.object({
  rfqCommandOutcome: z.literal("rejected"), actorId, idempotencyKey,
  intent: rfqCommandIntentSchema,
}).strict();

export function matchesRfqCommandReceipt(
  value: unknown,
  expected: { actorId: string; idempotencyKey: string; intent: RfqCommandIntent },
): value is RfqCommandReceipt {
  const parsed = rfqCommandReceiptSchema.safeParse(value);
  return parsed.success && parsed.data.actorId === expected.actorId
    && parsed.data.idempotencyKey === expected.idempotencyKey
    && canonicalJson(parsed.data.intent) === canonicalJson(expected.intent);
}

// Keep the existing workflow command contract unchanged for server owners while
// making the same v1 browser recovery record readable for initial creation.
export const rfqRecoverableIntentSchema = z.union([rfqCommandIntentSchema, rfqCreateIntentSchema]);
export const rfqRecoverableReceiptSchema = z.union([rfqCommandReceiptSchema, rfqCreateReceiptSchema]);
export const rfqRecoverableRejectionDetailsSchema = z.union([rfqCommandRejectionDetailsSchema, rfqCreateRejectionDetailsSchema]);
export type RfqRecoverableIntent = z.infer<typeof rfqRecoverableIntentSchema>;
export type RfqRecoverableReceipt = z.infer<typeof rfqRecoverableReceiptSchema>;
