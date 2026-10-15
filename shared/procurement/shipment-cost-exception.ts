import { z } from "zod";
import { costCurrencySchema, costFingerprintSchema, costIssueSchema } from "./cost-source-contracts";

export const shipmentExceptionIdSchema = z.number().int().positive().max(2_147_483_647);
const sequence = z.number().int().positive().safe();
const amount = z.number().int().nonnegative().safe();
export const shipmentExceptionDecisionSchema = z.object({
  id: sequence,
  action: z.enum(["accept", "reopen"]),
  fingerprint: costFingerprintSchema,
  reason: z.string().trim().min(10).max(2_000),
  actorId: z.string().trim().min(1).max(200),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

/** Acceptance resolves the review task, not the underlying stock history or
 * attribution of the retained cost. The application result remains immutable. */
export const shipmentCostExceptionSchema = z.object({
  state: z.enum(["open", "accepted"]),
  fingerprint: costFingerprintSchema,
  kind: z.enum(["missing_receipt_history", "unexplained_quantity"]),
  currency: costCurrencySchema,
  allocatedMills: amount,
  amountMills: amount,
  lotsUpdated: amount,
  cogsRowsUpdated: amount,
  issues: z.array(costIssueSchema).min(1),
  decision: shipmentExceptionDecisionSchema.nullable(),
}).strict();
export type ShipmentCostException = z.infer<typeof shipmentCostExceptionSchema>;
export type ShipmentExceptionDecision = z.infer<typeof shipmentExceptionDecisionSchema>;

export const shipmentExceptionContextSchema = z.object({
  shipmentId: shipmentExceptionIdSchema,
  lineId: shipmentExceptionIdSchema,
  sku: z.string().nullable(),
  sourceVersion: costFingerprintSchema,
  canApprove: z.boolean(),
  blockedReason: z.string().nullable(),
  review: shipmentCostExceptionSchema.nullable(),
}).strict();
export type ShipmentExceptionContext = z.infer<typeof shipmentExceptionContextSchema>;
export const shipmentExceptionRequestSchema = z.object({
  sourceVersion: costFingerprintSchema,
  action: z.enum(["accept", "reopen"]),
  reason: shipmentExceptionDecisionSchema.shape.reason,
}).strict();
export type ShipmentExceptionRequest = z.infer<typeof shipmentExceptionRequestSchema>;
export const shipmentExceptionResultSchema = z.object({
  shipmentId: shipmentExceptionIdSchema,
  lineId: shipmentExceptionIdSchema,
  decision: shipmentExceptionDecisionSchema,
}).strict();

/** Exact sub-cent display: inventory mills are 1/100 of a cent. */
export function formatShipmentExceptionAmount(mills: number, currency: string): string {
  amount.parse(mills);
  costCurrencySchema.parse(currency);
  const value = BigInt(mills);
  const fraction = (value % BigInt(10_000)).toString().padStart(4, "0");
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency,
    minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return formatter.formatToParts(value / BigInt(10_000))
    .map(part => part.type === "fraction" ? fraction : part.value).join("");
}
