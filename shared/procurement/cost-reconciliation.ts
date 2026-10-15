import { z } from "zod";
import { costFingerprintSchema, costIssueSchema } from "./cost-source-contracts";

const integer = z.number().int().safe();
const amount = integer.nonnegative();
const id = integer.positive();
export const reconciliationDestinationSchema = z.enum(["historical_cogs", "inventory_variance"]);
export type ReconciliationDestination = z.infer<typeof reconciliationDestinationSchema>;
export const reconciliationDestinations: Record<ReconciliationDestination, string> = {
  historical_cogs: "Cost of goods already sold",
  inventory_variance: "Historical inventory cost adjustment",
};
export const reconciliationBalanceSchema = z.object({ historical_cogs: amount, inventory_variance: amount }).strict();
export type ReconciliationBalance = z.infer<typeof reconciliationBalanceSchema>;
export const reconciliationStateSchema = z
  .object({
    status: z.enum(["unresolved", "posted", "review_required"]),
    postedMills: amount,
    unassignedMills: integer,
    destination: reconciliationDestinationSchema.nullable(),
  })
  .strict()
  .refine((value) => value.status !== "posted" || (value.destination !== null && value.unassignedMills === 0), {
    message: "Posted costs require an approved destination and zero unassigned balance",
  });
export type ReconciliationState = z.infer<typeof reconciliationStateSchema>;
export const reconciliationPostingSchema = z
  .object({
    id,
    approvalId: id,
    destination: reconciliationDestinationSchema,
    beforeMills: amount,
    afterMills: amount,
    deltaMills: integer,
  })
  .strict()
  .refine(
    (value) =>
      [value.afterMills, value.beforeMills, value.deltaMills].every(Number.isSafeInteger) &&
      BigInt(value.afterMills) - BigInt(value.beforeMills) === BigInt(value.deltaMills),
    { message: "The posting must equal its exact before/after difference" },
  );
export type ReconciliationPosting = z.infer<typeof reconciliationPostingSchema>;
export const reconciliationRecordSchema = z
  .object({
    lotId: id,
    lotNumber: z.string(),
    originalQuantity: amount,
    onHandQuantity: amount,
    receiptId: id.nullable(),
    receiptLineId: id.nullable(),
    quantityWithoutHistory: amount.nullable(),
    explanation: z.string(),
  })
  .strict();
export const reconciliationHistorySchema = z
  .object({
    id,
    destination: reconciliationDestinationSchema,
    beforeMills: amount,
    afterMills: amount,
    deltaMills: integer,
    actorName: z.string(),
    reason: z.string(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const reconciliationContextSchema = z
  .object({
    lineId: id,
    shipmentId: id,
    sku: z.string().nullable(),
    currency: z.literal("USD"),
    sourceVersion: costFingerprintSchema,
    sourceAmountMills: amount,
    historicalAmountMills: amount,
    balances: reconciliationBalanceSchema,
    state: reconciliationStateSchema,
    records: z.array(reconciliationRecordSchema).max(1000),
    issues: z.array(costIssueSchema),
    canApprove: z.boolean(),
    blockedReason: z.string().nullable(),
    history: z.array(reconciliationHistorySchema).max(50),
  })
  .strict();
export type ReconciliationContext = z.infer<typeof reconciliationContextSchema>;
export const reconciliationRequestSchema = z
  .object({
    sourceVersion: costFingerprintSchema,
    destination: reconciliationDestinationSchema,
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();
export type ReconciliationRequest = z.infer<typeof reconciliationRequestSchema>;
export const reconciliationResultSchema = z
  .object({ lineId: id, shipmentId: id, applicationId: id, state: reconciliationStateSchema })
  .strict();
export const reconciliationReportSchema = z
  .object({
    currency: z.literal("USD"),
    balances: reconciliationBalanceSchema,
    entries: z
      .array(
        reconciliationHistorySchema
          .extend({ lineId: id, shipmentId: id, purchaseOrderId: id, poNumber: z.string(), sku: z.string().nullable() })
          .strict(),
      )
      .max(100),
    truncated: z.boolean(),
  })
  .strict();

/** Shared preview arithmetic; all economic values stay integer 1/10,000 USD. */
export function reconciliationPreview(
  context: Pick<ReconciliationContext, "sourceAmountMills" | "historicalAmountMills" | "balances">,
  destination: ReconciliationDestination,
) {
  amount.parse(context.sourceAmountMills);
  amount.parse(context.historicalAmountMills);
  reconciliationBalanceSchema.parse(context.balances);
  reconciliationDestinationSchema.parse(destination);
  const safe = (value: bigint) => integer.parse(Number(value));
  const assigned = safe(BigInt(context.sourceAmountMills) - BigInt(context.historicalAmountMills));
  if (assigned < 0) throw new Error("Unassigned costs exceed the shipment charge");
  const after: ReconciliationBalance = {
    historical_cogs: 0,
    inventory_variance: 0,
    [destination]: context.historicalAmountMills,
  };
  return {
    assignedMills: assigned,
    before: {
      ...context.balances,
      unassignedMills: safe(
        BigInt(context.historicalAmountMills) -
          BigInt(context.balances.historical_cogs) -
          BigInt(context.balances.inventory_variance),
      ),
    },
    after: { ...after, unassignedMills: 0 },
  };
}
