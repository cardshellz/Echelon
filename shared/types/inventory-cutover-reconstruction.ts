import { z } from "zod";
import { wmsCutoverDemandOrderSchema, wmsCutoverDemandItemSchema,
  wmsCutoverSourceItemSchema, wmsCutoverPhysicalItemSchema } from "./inventory-cutover-demand";
import { inventoryCutoverBuildReservationSchema, inventoryCutoverCanonicalResourceSchema } from "./inventory-cutover-encumbrance";

const id = z.number().int().positive().max(2_147_483_647);
const raw = z.string().regex(/^-?(0|[1-9][0-9]*)$/).max(80);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const cutoverOpeningProvenanceSchema = z.object({ sourceEvidenceHash: hash, verificationHash: hash,
  historicalExceptionHash: hash, historicalExceptionCount: z.number().int().nonnegative(),
  snapshotId: z.string().regex(/^[1-9][0-9]{0,18}$/).optional() }).strict();
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
export const cutoverJournalIssueCodeSchema = z.enum([
  "RESERVATION_DELTA_MISSING", "PHYSICAL_DELTA_MISSING", "SHIPMENT_BUCKET_SPLIT_UNRECORDED",
  "RESERVATION_TRANSFER_OWNER_UNRECORDED", "OWNER_FOREIGN_KEY_MISSING", "OWNER_FOREIGN_KEY_CONFLICT",
  "SOURCE_PURPOSE_UNSUPPORTED", "SOURCE_LIFECYCLE_UNSAFE", "LOCATION_IDENTITY_UNRESOLVED",
]);
export type CutoverJournalIssueCode = z.infer<typeof cutoverJournalIssueCodeSchema>;
/** Raw signed journal evidence, including unattributed/terminal residuals. Never clamp. */
export const cutoverReconstructionJournalSchema = z.object({
  orderId: nullableId, orderItemId: nullableId, productVariantId: nullableId,
  warehouseLocationId: nullableId, reservedQty: raw, pickedQty: raw,
  shippedQty: raw, unknownCount: raw, journalCount: raw, journalHash: hash,
  // Optional only for older persisted evidence. New captures retain bounded,
  // exact row examples; the hash and transaction count cover every row.
  identityCompletedCount: raw.optional(),
  issues: z.array(z.object({ code: cutoverJournalIssueCodeSchema,
    transactionCount: z.string().regex(/^[1-9][0-9]*$/), transactionIds: z.array(id).min(1).max(10),
  }).strict()).optional(),
}).strict().superRefine((journal, context) => {
  if (journal.identityCompletedCount !== undefined && (BigInt(journal.identityCompletedCount) < BigInt(0)
    || BigInt(journal.identityCompletedCount) > BigInt(journal.journalCount))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Completed identities must be within the journal row count" });
  }
  if (journal.issues !== undefined && ((journal.issues.length === 0) !== (BigInt(journal.unknownCount) === BigInt(0))
    || new Set(journal.issues.map((issue) => issue.code)).size !== journal.issues.length
    || BigInt(journal.unknownCount) > BigInt(journal.journalCount)
    || journal.issues.some((issue) => BigInt(issue.transactionCount) > BigInt(journal.unknownCount)
      || BigInt(issue.transactionIds.length) > BigInt(issue.transactionCount)
      || new Set(issue.transactionIds).size !== issue.transactionIds.length))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown diagnostics must reconcile to exact journal row counts and distinct examples" });
  }
});
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
const positiveQuantity = z.string().regex(/^[1-9][0-9]*$/).max(10)
  .refine((value) => BigInt(value) <= BigInt(2_147_483_647), "Quantity exceeds the inventory counter range");
/** A whole empty position, never an arbitrary subset of its customer promises. */
export const cutoverLegacyPromiseReleaseSchema = z.object({
  inventoryLevelId: id, warehouseLocationId: id, warehouseId: id, productVariantId: id,
  variantQty: z.literal("0"), reservedQty: positiveQuantity, pickedQty: raw, packedQty: z.literal("0"),
  owners: z.array(z.object({ orderId: id, orderItemId: id, reservedQty: positiveQuantity,
    journalCount: positiveQuantity, journalHash: hash }).strict()).min(1),
}).strict().refine((release) => BigInt(release.pickedQty) >= BigInt(0)
  && new Set(release.owners.map((owner) => owner.orderItemId)).size === release.owners.length
  && release.owners.reduce((total, owner) => total + BigInt(owner.reservedQty), BigInt(0)) === BigInt(release.reservedQty),
"Every promise must have one distinct owner and exhaust the complete level reservation");
export type CutoverLegacyPromiseRelease = z.infer<typeof cutoverLegacyPromiseReleaseSchema>;
const counter = z.string().regex(/^(0|[1-9][0-9]*)$/).max(10)
  .refine(value => BigInt(value) <= BigInt(2_147_483_647));
/** Explicit verified-opening counter translation, not a historical owner release. */
export const openingReservationRebaseSchema = z.object({
  inventoryLevelId: id, warehouseId: id, warehouseLocationId: id, productVariantId: id,
  variantQty: counter, reservedQty: counter, pickedQty: counter, packedQty: z.literal("0"),
  physicalReservedQty: counter,
}).strict().refine(row => BigInt(row.reservedQty) > BigInt(row.physicalReservedQty)
  && BigInt(row.physicalReservedQty) <= BigInt(row.variantQty), "Only excess nonphysical counters can be translated");
export type OpeningReservationRebase = z.infer<typeof openingReservationRebaseSchema>;
export type CutoverReconstructionPlan = {
  evidenceHash: string; ready: boolean; blockers: CutoverReconstructionBlocker[];
  orders: CutoverReconstructionOrder[]; retainedIndependentBuildReservationIds: number[];
  legacyPromiseReleases: CutoverLegacyPromiseRelease[];
  openingReservationRebases?: OpeningReservationRebase[];
  openingBalance?: z.infer<typeof cutoverOpeningProvenanceSchema>;
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
  // Missing on older immutable receipts means no promise handoff was performed.
  legacyPromiseReleases: z.array(cutoverLegacyPromiseReleaseSchema).optional(),
  legacyPromiseReleaseTransactionIds: z.array(id).optional(),
  openingReservationRebases: z.array(openingReservationRebaseSchema).min(1).max(50_000).optional(),
  openingReservationRebaseTransactionIds: z.array(id).min(1).max(50_000).optional(),
  openingBalance: cutoverOpeningProvenanceSchema.optional(),
}).strict().refine((receipt) => receipt.claimIds.length===receipt.orderIds.length
  && new Set(receipt.claimIds).size===receipt.claimIds.length && new Set(receipt.orderIds).size===receipt.orderIds.length
  && new Set(receipt.retainedIndependentBuildReservationIds).size===receipt.retainedIndependentBuildReservationIds.length,
  "Reconstruction receipt identities must be unique and each order must have exactly one claim")
  .refine((receipt) => {
    if (receipt.legacyPromiseReleases === undefined && receipt.legacyPromiseReleaseTransactionIds === undefined) return true;
    if (!receipt.legacyPromiseReleases || !receipt.legacyPromiseReleaseTransactionIds) return false;
    const owners = receipt.legacyPromiseReleases.flatMap((release) => release.owners.map((owner) => owner.orderItemId));
    return new Set(receipt.legacyPromiseReleases.map((release) => release.inventoryLevelId)).size === receipt.legacyPromiseReleases.length
      && new Set(owners).size === owners.length && receipt.legacyPromiseReleaseTransactionIds.length === owners.length
      && new Set(receipt.legacyPromiseReleaseTransactionIds).size === owners.length;
  }, "Every handed-off promise must have exactly one distinct audit transaction")
  .refine(receipt => {
    const rows = receipt.openingReservationRebases, ids = receipt.openingReservationRebaseTransactionIds;
    if (!rows && !ids) return true;
    return !!rows && !!ids && !!receipt.openingBalance?.snapshotId && ids.length === rows.length
      && new Set(ids).size === ids.length && new Set(rows.map(row => row.inventoryLevelId)).size === rows.length
      && !rows.some(row => receipt.legacyPromiseReleases?.some(release => release.inventoryLevelId === row.inventoryLevelId));
  }, "Every verified counter translation requires an opening snapshot and one distinct audit transaction");
export type CutoverReconstructionReceipt = z.infer<typeof cutoverReconstructionReceiptSchema>;
