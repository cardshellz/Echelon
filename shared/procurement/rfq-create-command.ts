import { z } from "zod";
import { canonicalJson } from "../utils/canonical-json";
import { rfqResourceIdSchema } from "./rfq-workflow";

const optionalText = (maximum: number) => z.string().trim().max(maximum).transform(value => value || null).nullish();
export const rfqCreatePayloadSchema = z.object({
  requestNote: optionalText(20_000),
  responseDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Response due date must be a calendar date").nullish(),
  lines: z.array(z.object({
    recommendationLineId: rfqResourceIdSchema, vendorId: rfqResourceIdSchema,
    vendorProductId: rfqResourceIdSchema.optional(), vendorSku: optionalText(100),
    requestedPieces: rfqResourceIdSchema, quantityOverrideReason: optionalText(2_000),
    allocationOverrideApproved: z.boolean().optional(),
  }).strict()).min(1).max(500),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  value.lines.forEach((line, index) => {
    const key = `${line.vendorId}:${line.recommendationLineId}`;
    if (keys.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines", index], message: "A recommendation may appear only once for each supplier" });
    keys.add(key);
  });
});
export type RfqCreatePayload = z.infer<typeof rfqCreatePayloadSchema>;
export const rfqCreateIntentSchema = z.object({ operation: z.literal("create_batch"), rfqId: z.null(), payload: rfqCreatePayloadSchema }).strict();
export type RfqCreateIntent = z.infer<typeof rfqCreateIntentSchema>;

// These are persisted creation fields. Status/quotes may advance before a
// legacy key is recovered, so later workflow state is not creation evidence.
export const rfqCreateResultSchema = z.object({
  rfqs: z.array(z.object({
    id: rfqResourceIdSchema, rfqNumber: z.string().min(1), vendorId: rfqResourceIdSchema,
    idempotencyKey: z.string().min(1).max(160), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdBy: z.string().min(1), requestNote: z.string().nullable(), responseDueDate: z.string().nullable(),
  }).passthrough()).min(1).max(500),
  lines: z.array(z.object({
    id: rfqResourceIdSchema, rfqId: rfqResourceIdSchema, recommendationLineId: rfqResourceIdSchema,
    vendorProductId: rfqResourceIdSchema, requestedPieces: rfqResourceIdSchema,
    quantityOverrideReason: z.string().nullable(), allocationOverrideApprovedBy: z.string().nullable(),
  }).passthrough()).min(1).max(500),
  reused: z.boolean(),
}).strict();
export type RfqCreateResult = z.infer<typeof rfqCreateResultSchema>;
const actorId = z.string().min(1).max(200).refine(value => value.trim() === value);
export const rfqCreateKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,159}$/);

export function rfqCreateResultMatchesRequest(result: RfqCreateResult, intent: RfqCreateIntent, actor: string, key: string): boolean {
  const vendors = new Set(intent.payload.lines.map(line => line.vendorId));
  if (result.rfqs.length !== vendors.size || result.lines.length !== intent.payload.lines.length
    || new Set(result.rfqs.map(row => row.id)).size !== result.rfqs.length
    || new Set(result.rfqs.map(row => row.vendorId)).size !== result.rfqs.length
    || new Set(result.lines.map(row => row.id)).size !== result.lines.length
    || result.rfqs.some(row => !vendors.has(row.vendorId) || row.createdBy !== actor || row.idempotencyKey !== key
      || row.requestNote !== (intent.payload.requestNote ?? null) || row.responseDueDate !== (intent.payload.responseDueDate ?? null))) return false;
  return intent.payload.lines.every(line => {
    const rfq = result.rfqs.find(row => row.vendorId === line.vendorId)!;
    const matches = result.lines.filter(row => row.rfqId === rfq.id && row.recommendationLineId === line.recommendationLineId);
    return matches.length === 1 && matches[0].requestedPieces === line.requestedPieces
      && (line.vendorProductId === undefined || matches[0].vendorProductId === line.vendorProductId)
      && matches[0].quantityOverrideReason === (line.quantityOverrideReason ?? null)
      && matches[0].allocationOverrideApprovedBy === (line.allocationOverrideApproved ? actor : null);
  });
}

export const rfqCreateReceiptSchema = z.object({
  version: z.literal(1), actorId, idempotencyKey: rfqCreateKeySchema,
  intent: rfqCreateIntentSchema, result: rfqCreateResultSchema,
}).strict().superRefine((receipt, context) => {
  if (!rfqCreateResultMatchesRequest(receipt.result, receipt.intent, receipt.actorId, receipt.idempotencyKey)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The RFQ creation receipt does not prove the saved batch" });
  }
});
export type RfqCreateReceipt = z.infer<typeof rfqCreateReceiptSchema>;
export const rfqCreateRejectionDetailsSchema = z.object({
  rfqCommandOutcome: z.literal("rejected"), actorId, idempotencyKey: rfqCreateKeySchema,
  intent: rfqCreateIntentSchema,
}).strict();
export function matchesRfqCreateReceipt(value: unknown, expected: { actorId: string; idempotencyKey: string; intent: RfqCreateIntent }): value is RfqCreateReceipt {
  const parsed = rfqCreateReceiptSchema.safeParse(value);
  return parsed.success && parsed.data.actorId === expected.actorId && parsed.data.idempotencyKey === expected.idempotencyKey
    && canonicalJson(parsed.data.intent) === canonicalJson(expected.intent);
}
