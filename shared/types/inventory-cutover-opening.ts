import { z } from "zod";
import { isTerminalWmsDemandStatus } from "../enums/order-status";
import { cutoverOpeningProvenanceSchema, cutoverReconstructionEvidenceSchema, cutoverReconstructionLevelSchema, cutoverReconstructionLotSchema,
  cutoverReconstructionCostSchema, cutoverLegacyPromiseReleaseSchema, type CutoverReconstructionEvidence } from "./inventory-cutover-reconstruction";

const id = z.number().int().positive().max(2_147_483_647);
const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= BigInt("9223372036854775807"));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const quantity = z.string().regex(/^(0|[1-9][0-9]*)$/).max(10).refine(value => BigInt(value) <= BigInt(2_147_483_647));
const text = (max: number) => z.string().trim().min(1).max(max);
export const openingBlockerSchema = z.object({ code: text(100), subject: text(300), message: text(2000) }).strict();
const lotAllocation = z.object({ inventoryLotId: id, reservedQty: quantity, pickedQty: quantity,
  originalCostIds: z.array(id).max(100_000) }).strict();
export const openingOwnerSchema = z.object({ orderId: id, orderItemId: id,
  remainingQty: quantity, reservedQty: quantity, pickedQty: quantity,
  allocations: z.array(z.object({ inventoryLevelId: id, lots: z.array(lotAllocation).max(50_000) }).strict()).max(50_000),
}).strict();

/** Independent verification, not an instruction to overwrite recorded counters. */
export const openingVerificationSchema = z.object({
  contractVersion: z.literal("inventory_cutover_opening_v1"),
  expectedEvidenceHash: hash, expectedAuthorityRevision: bigintId, expectedConfigurationRunId: bigintId.nullable(),
  verificationReference: text(1000), verificationEvidenceHash: hash, verifiedAt: z.string().datetime(),
  historicalDisposition: z.literal("preserve_unresolved"),
  levels: z.array(cutoverReconstructionLevelSchema).max(50_000),
  lots: z.array(cutoverReconstructionLotSchema).max(50_000), owners: z.array(openingOwnerSchema).max(50_000),
}).strict();
export type OpeningVerification = z.infer<typeof openingVerificationSchema>;

const allocation = z.object({ inventoryLevelId: id, warehouseId: id, warehouseLocationId: id, productVariantId: id,
  reservedQty: quantity, pickedQty: quantity, lots: z.array(z.object({ inventoryLotId: id, reservedQty: quantity,
    pickedQty: quantity, cost: cutoverReconstructionLotSchema, originalCosts: z.array(cutoverReconstructionCostSchema) }).strict()) }).strict();
export const openingProvenanceSchema = cutoverOpeningProvenanceSchema;
const plan = z.object({ evidenceHash: hash, ready: z.boolean(), blockers: z.array(openingBlockerSchema),
  orders: z.array(z.object({ orderId: id, warehouseId: id, lines: z.array(z.object({ orderItemId: id,
    targetVariantId: id, productId: id, requestedQty: quantity, reservedQty: quantity, pickedQty: quantity,
    freshDemandQty: quantity, allocations: z.array(allocation) }).strict()) }).strict()),
  retainedIndependentBuildReservationIds: z.array(id), legacyPromiseReleases: z.array(cutoverLegacyPromiseReleaseSchema),
  openingBalance: openingProvenanceSchema.optional(),
}).strict();
export const openingAssessmentSchema = z.object({ sourceEvidenceHash: hash, verificationHash: hash,
  ready: z.boolean(), blockers: z.array(openingBlockerSchema), historicalExceptions: z.array(openingBlockerSchema),
  historicalExceptionHash: hash, plan,
}).strict().superRefine((result, context) => {
  if (result.ready !== (result.blockers.length === 0) || result.plan.ready !== result.ready) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Opening readiness must match complete validation" });
  }
});
export type OpeningAssessment = z.infer<typeof openingAssessmentSchema>;
export const openingSaveRequestSchema = z.object({ verification: openingVerificationSchema,
  reason: text(1000), idempotencyKey: text(120) }).strict();
export const saveOpeningRequestSchema = openingSaveRequestSchema;
export type OpeningSaveRequest = z.infer<typeof openingSaveRequestSchema>;
export const openingSavedSchema = z.object({ id: bigintId, sourceEvidenceHash: hash, verificationHash: hash,
  authorityRevision: bigintId, historicalExceptionHash: hash, historicalExceptionCount: z.number().int().nonnegative(),
  verifiedAt: z.string().datetime(), actor: text(100), reason: text(1000), alreadyApplied: z.boolean(),
  stockChanged: z.literal(false), authorityChanged: z.literal(false),
}).strict();
export type OpeningSaved = z.infer<typeof openingSavedSchema>;
export const openingSourceSchema = z.object({ contractVersion: z.literal("inventory_cutover_opening_source_v1"),
  capturedAt: z.string().datetime(), runtimeAuthority: z.enum(["legacy", "canonical"]), authorityRevision: bigintId,
  configurationRunId: bigintId.nullable(), evidenceHash: hash, evidence: cutoverReconstructionEvidenceSchema,
  labels: z.array(z.object({ kind: z.enum(["order", "variant", "warehouse", "location"]), id: bigintId, label: text(1000) }).strict()),
  latestVerification: openingSavedSchema.nullable(),
}).strict();
export type OpeningSource = z.infer<typeof openingSourceSchema>;

/** A missing/ambiguous physical identity stays in the worksheet and blocks validation. */
export function requiredOpeningItems(evidence: CutoverReconstructionEvidence): CutoverReconstructionEvidence["items"] {
  const orders = new Map(evidence.orders.map(order => [order.id, order]));
  const variants = new Map<string, CutoverReconstructionEvidence["variants"]>();
  for (const variant of evidence.variants) if (variant.isActive) {
    const key = variant.sku.toUpperCase(); const rows = variants.get(key) ?? []; rows.push(variant); variants.set(key, rows);
  }
  return evidence.items.filter(item => {
    if (isTerminalWmsDemandStatus(orders.get(item.orderId)?.status ?? null) || item.requiresShipping === 0) return false;
    const matches = variants.get(item.sku.toUpperCase()) ?? [];
    return matches.length !== 1 || (matches[0].requiresShipping && matches[0].trackInventory);
  }).sort((a, b) => a.id - b.id);
}
