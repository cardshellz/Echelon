import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";
import { poAmendmentImpactSchema } from "./po-amendment-impact";
const money = z.number().int().safe().nullable();
export const supplierCreditCostPreviewSchema = z.object({
  creditId: z.number().int().positive().max(2_147_483_647),
  action: z.enum(["approve", "void", "reconcile_costs"]),
  previewVersion: costFingerprintSchema,
  impact: poAmendmentImpactSchema.pick({ lots: true, orderCosts: true, historicalCosts: true }),
  inventoryValues: z.array(z.object({
    lotId: z.number().int().positive().safe(), lotNumber: z.string(), onHandUnits: z.number().int().nonnegative().safe(),
    beforeMills: money, afterMills: money, reviewReason: z.string().nullable(),
  }).strict()),
  issues: z.array(z.string()),
  // Optional only for already-retained version-1 approvals. New reviews show
  // the billed receipt amounts as well as downstream stock/order values.
  receipts: z.array(z.object({ receivingLineId: z.number().int().positive().safe(), receiptNumber: z.string(),
    pieces: z.number().int().positive().safe(), beforeMills: money, afterMills: money }).strict()).optional(),
}).strict();
export type SupplierCreditCostPreview = z.infer<typeof supplierCreditCostPreviewSchema>;
export const supplierCreditCostApprovalSchema = z.object({
  eventId: z.number().int().positive().safe(), actorId: z.string(), actorName: z.string(), approvedAt: z.string().datetime(),
  reason: z.string(), preview: supplierCreditCostPreviewSchema,
}).strict();
