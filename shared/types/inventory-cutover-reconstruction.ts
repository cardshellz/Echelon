import { z } from "zod";
import { wmsCutoverDemandOrderSchema, wmsCutoverDemandItemSchema,
  wmsCutoverSourceItemSchema, wmsCutoverPhysicalItemSchema } from "./inventory-cutover-demand";
import { inventoryCutoverBuildReservationSchema, inventoryCutoverCanonicalResourceSchema } from "./inventory-cutover-encumbrance";

const id = z.number().int().positive().max(2_147_483_647);
const raw = z.string().regex(/^-?(0|[1-9][0-9]*)$/).max(80);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const nullableId = id.nullable();
export const cutoverReconstructionLevelSchema = z.object({
  id, warehouseLocationId: id, warehouseId: nullableId, productVariantId: id,
  variantQty: raw, reservedQty: raw, pickedQty: raw, packedQty: raw,
}).strict();
export const cutoverReconstructionLotSchema = z.object({
  id, warehouseLocationId: nullableId, productVariantId: id,
  onHandQty: raw, reservedQty: raw, pickedQty: raw, status: z.string(),
  unitCostMills: raw, poUnitCostMills: raw, packagingUnitCostMills: raw, landedUnitCostMills: raw,
}).strict();
/** Raw signed journal evidence, including unattributed/terminal residuals. Never clamp. */
export const cutoverReconstructionJournalSchema = z.object({
  orderId: nullableId, orderItemId: nullableId, productVariantId: nullableId,
  warehouseLocationId: nullableId, reservedQty: raw, pickedQty: raw,
  shippedQty: raw, unknownCount: raw, journalCount: raw, journalHash: hash,
}).strict();
export const cutoverReconstructionCostSchema = z.object({
  id, orderId: id, orderItemId: id, inventoryLotId: id, productVariantId: id,
  quantity: raw, unitCostMills: raw, totalCostMills: raw,
  occurredAt: z.string().datetime(),
}).strict();
export const cutoverReconstructionVariantSchema = z.object({
  id, productId: id, sku: z.string(), isActive: z.boolean(), requiresShipping: z.boolean(),
  trackInventory: z.boolean(), salesEligibility: z.string(),
}).strict();
export const cutoverReconstructionBuildDemandSchema = z.object({
  id, orderId: nullableId, orderItemId: nullableId, targetVariantId: nullableId,
  rootBuildOrderId: nullableId, status: z.string(), requestedQty: raw, promisedQty: raw,
}).strict();
export const cutoverReconstructionEvidenceSchema = z.object({
  schemaVersion: z.literal("inventory_cutover_reconstruction_v1"),
  orders: z.array(wmsCutoverDemandOrderSchema), items: z.array(wmsCutoverDemandItemSchema),
  sourceItems: z.array(wmsCutoverSourceItemSchema), physicalItems: z.array(wmsCutoverPhysicalItemSchema),
  buildDemands: z.array(cutoverReconstructionBuildDemandSchema),
  levels: z.array(cutoverReconstructionLevelSchema), lots: z.array(cutoverReconstructionLotSchema),
  journals: z.array(cutoverReconstructionJournalSchema), costs: z.array(cutoverReconstructionCostSchema),
  variants: z.array(cutoverReconstructionVariantSchema),
  buildReservations: z.array(inventoryCutoverBuildReservationSchema),
  canonicalResources: z.array(inventoryCutoverCanonicalResourceSchema),
  /** Hash of every canonical header, including empty active claims. */
  canonicalClaimCount: raw,
  canonicalClaimHash: hash,
  acceptedOmsDemand: z.array(z.object({
    lineId: z.string().regex(/^[1-9][0-9]*$/), orderId: z.string().regex(/^[1-9][0-9]*$/),
    productVariantId: nullableId, sku: z.string().nullable(), authorizedQty: raw,
    materializedQty: raw, authorizationStatus: z.string(),
  }).strict()),
  shipmentReviewEvidence: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), evidenceHash: hash }).strict()),
}).strict();
export type CutoverReconstructionEvidence = z.infer<typeof cutoverReconstructionEvidenceSchema>;
export type CutoverReconstructionLot = z.infer<typeof cutoverReconstructionLotSchema>;
export type CutoverReconstructionCost = z.infer<typeof cutoverReconstructionCostSchema>;
export type CutoverReconstructionBlocker = { code: string; subject: string; message: string };
export type CutoverReconstructionAllocation = {
  inventoryLevelId: number; warehouseId: number; warehouseLocationId: number; productVariantId: number;
  reservedQty: string; pickedQty: string;
  lots: Array<{ inventoryLotId: number; reservedQty: string; pickedQty: string;
    cost: CutoverReconstructionLot; originalCosts: CutoverReconstructionCost[] }>;
};
export type CutoverReconstructionLine = {
  orderItemId: number; targetVariantId: number; productId: number; requestedQty: string;
  reservedQty: string; pickedQty: string; freshDemandQty: string;
  allocations: CutoverReconstructionAllocation[];
};
export type CutoverReconstructionOrder = {
  orderId: number; warehouseId: number; lines: CutoverReconstructionLine[];
};
export type CutoverReconstructionPlan = {
  evidenceHash: string; ready: boolean; blockers: CutoverReconstructionBlocker[];
  orders: CutoverReconstructionOrder[]; retainedIndependentBuildReservationIds: number[];
};
export const cutoverReconstructionCommitSchema = z.object({
  expectedEvidenceHash: hash, activationRunId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  runtimeAuthorityRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  actor: z.string().trim().min(1).max(100), reason: z.string().trim().min(1).max(1000),
  occurredAt: z.string().datetime(),
}).strict();
export type CutoverReconstructionCommit = z.infer<typeof cutoverReconstructionCommitSchema>;
export const cutoverReconstructionReceiptSchema = z.object({
  evidenceHash: hash, claimIds: z.array(z.string().regex(/^[1-9][0-9]{0,18}$/)), orderIds: z.array(id),
  retainedIndependentBuildReservationIds: z.array(id),
}).strict().refine((receipt) => receipt.claimIds.length===receipt.orderIds.length
  && new Set(receipt.claimIds).size===receipt.claimIds.length && new Set(receipt.orderIds).size===receipt.orderIds.length
  && new Set(receipt.retainedIndependentBuildReservationIds).size===receipt.retainedIndependentBuildReservationIds.length,
  "Reconstruction receipt identities must be unique and each order must have exactly one claim");
export type CutoverReconstructionReceipt = z.infer<typeof cutoverReconstructionReceiptSchema>;
