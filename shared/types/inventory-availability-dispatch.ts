import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).pipe(z.string().refine(
  (value) => BigInt(value) <= BigInt("9223372036854775807"), "Quantity exceeds PostgreSQL bigint"));
const positive = quantity.refine((value) => value !== "0", "Positive quantity required");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (length: number) => z.string().trim().min(1).max(length);
const MAX_RESOURCES = 1_000;
const MAX_MOVEMENTS = 10_000;

const sourceIdentity = {
  orderId: id, orderItemId: id, warehouseId: id, warehouseLocationId: id, productVariantId: id,
  outboundShipmentId: id, sourceShipmentItemId: id,
  physicalShipmentId: positive.nullable(), physicalShipmentItemId: positive.nullable(),
};
function physicalPair(value: { physicalShipmentId: string | null; physicalShipmentItemId: string | null }, context: z.RefinementCtx): void {
  if ((value.physicalShipmentId === null) !== (value.physicalShipmentItemId === null)) {
    context.addIssue({ code: "custom", path: ["physicalShipmentItemId"], message: "Physical shipment and item IDs must both be present or both absent" });
  }
}

export const canonicalClaimDispatchCommandSchema = z.object({
  ...sourceIdentity, claimId: positive, quantity: positive,
  idempotencyKey: text(120), actor: text(100), reason: text(1_000),
}).strict().superRefine(physicalPair);

const sourceSchema = z.object({
  ...sourceIdentity, quantity: positive, dispatchedQuantity: quantity,
  physicalShipmentItemQuantity: positive.nullable(),
  // Published WMS owner evidence, never client-supplied authorization.
  readiness: z.enum(["authorized", "held", "unverified"]), orderStatus: text(30),
}).strict().superRefine((source, context) => {
  physicalPair(source, context);
  if ((source.physicalShipmentItemId === null) !== (source.physicalShipmentItemQuantity === null)) {
    context.addIssue({ code: "custom", path: ["physicalShipmentItemQuantity"], message: "Exact physical item quantity is required only with physical item identity" });
  }
});
const counters = { claimedQty: positive, releasedQty: quantity, consumedQty: quantity, pickedQty: quantity };
const lotSchema = z.object({
  id: positive, claimId: positive, claimResourceId: positive, inventoryLotId: id, ...counters,
}).strict();
const resourceSchema = z.object({
  id: positive, claimId: positive, claimLineId: positive, warehouseId: id, warehouseLocationId: id,
  inventoryLevelId: id, sourceVariantId: id, consumerOperationKey: text(300).nullable(), producerOperationKey: text(300).nullable(),
  ...counters, lots: z.array(lotSchema).max(MAX_MOVEMENTS),
}).strict();
const pickSchema = z.object({
  id: positive, claimId: positive, claimLineId: positive, claimResourceId: positive,
  claimLotAllocationId: positive, inventoryLotId: id, quantity: positive,
  reversedQuantity: quantity, dispatchedQuantity: quantity,
  cost: z.object({ id, orderId: id, orderItemId: id, productVariantId: id, inventoryLotId: id,
    quantity: positive, unitCostMills: quantity, totalCostMills: quantity }).strict(),
}).strict();

export const canonicalClaimDispatchEvidenceSchema = z.object({
  coverage: z.literal("complete_final_target_line"), source: sourceSchema,
  claim: z.object({ id: positive, orderId: id, status: z.enum(["active", "released", "cancelled", "superseded", "failed"]) }).strict(),
  line: z.object({ id: positive, claimId: positive, orderItemId: id, targetVariantId: id,
    plannedQty: quantity, releasedTargetQty: quantity, consumedTargetQty: quantity, pickedTargetQty: quantity }).strict(),
  resources: z.array(resourceSchema).max(MAX_RESOURCES),
  // Owner-aggregated reversal/dispatch quantities reference immutable movements.
  // Their remaining totals must reconcile to EVERY supplied lot/resource counter.
  pickMovements: z.array(pickSchema).max(MAX_MOVEMENTS),
}).strict();

const selectedPickSchema = z.object({
  pickMovementId: positive, orderItemCostId: id, quantity: positive,
  unitCostMills: quantity,
}).strict();
const selectedLotSchema = z.object({
  claimLotAllocationId: positive, inventoryLotId: id, quantity: positive,
  pickedQtyBefore: quantity, pickedQtyAfter: quantity, consumedQtyBefore: quantity, consumedQtyAfter: quantity,
  picks: z.array(selectedPickSchema).min(1).max(MAX_MOVEMENTS),
}).strict();
const selectedResourceSchema = z.object({
  claimResourceId: positive, warehouseId: id, warehouseLocationId: id, inventoryLevelId: id, sourceVariantId: id,
  quantity: positive, pickedQtyBefore: quantity, pickedQtyAfter: quantity, consumedQtyBefore: quantity, consumedQtyAfter: quantity,
  lots: z.array(selectedLotSchema).min(1).max(MAX_MOVEMENTS),
}).strict();
const dispatchPlanShapeSchema = z.object({
  contractVersion: z.literal("canonical_claim_dispatch_plan_v1"),
  commandHash: hash, command: canonicalClaimDispatchCommandSchema,
  claimLineId: positive, quantity: positive,
  pickedTargetQtyBefore: quantity, pickedTargetQtyAfter: quantity,
  consumedTargetQtyBefore: quantity, consumedTargetQtyAfter: quantity,
  sourceRemainingQuantity: z.literal("0"), sourceDispositionAfter: z.literal("fully_dispatched"),
  resources: z.array(selectedResourceSchema).min(1).max(MAX_RESOURCES),
  physicalOnHandDelta: z.literal("0"), reservedQuantityDelta: z.literal("0"),
  createsPick: z.literal(false), createsCogs: z.literal(false),
}).strict();
export const canonicalClaimDispatchPlanSchema = dispatchPlanShapeSchema.superRefine((plan, context) => {
  // Zod refinements can run after a child regex fails. Never parse malformed
  // decimal input with BigInt; outbound validation must return issues, not throw.
  if (!dispatchPlanShapeSchema.safeParse(plan).success) return;
  const zero = BigInt(0);
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  const movement = (value: { quantity: string; pickedQtyBefore: string; pickedQtyAfter: string; consumedQtyBefore: string; consumedQtyAfter: string }) =>
    BigInt(value.pickedQtyBefore) - BigInt(value.pickedQtyAfter) === BigInt(value.quantity)
      && BigInt(value.consumedQtyAfter) - BigInt(value.consumedQtyBefore) === BigInt(value.quantity);
  if (plan.command.quantity !== plan.quantity
    || BigInt(plan.pickedTargetQtyBefore) - BigInt(plan.pickedTargetQtyAfter) !== BigInt(plan.quantity)
    || BigInt(plan.consumedTargetQtyAfter) - BigInt(plan.consumedTargetQtyBefore) !== BigInt(plan.quantity)
    || (plan.sourceRemainingQuantity === "0") !== (plan.sourceDispositionAfter === "fully_dispatched")) fail("Dispatch plan quantities or source disposition disagree");
  const resources = new Set<string>(); const lots = new Set<string>(); const picks = new Set<string>();
  let resourceTotal = zero;
  for (const resource of plan.resources) {
    if (resources.has(resource.claimResourceId) || resource.warehouseId !== plan.command.warehouseId
      || resource.warehouseLocationId !== plan.command.warehouseLocationId || resource.sourceVariantId !== plan.command.productVariantId
      || !movement(resource)) fail("Selected resource identity or quantity is invalid");
    resources.add(resource.claimResourceId); resourceTotal += BigInt(resource.quantity);
    let lotTotal = zero;
    for (const lot of resource.lots) {
      if (lots.has(lot.claimLotAllocationId) || !movement(lot)) fail("Selected lot identity or quantity is invalid");
      lots.add(lot.claimLotAllocationId); lotTotal += BigInt(lot.quantity);
      let pickTotal = zero;
      for (const pick of lot.picks) {
        if (picks.has(pick.pickMovementId)) fail("A picked movement cannot be consumed twice in one plan");
        picks.add(pick.pickMovementId); pickTotal += BigInt(pick.quantity);
      }
      if (pickTotal !== BigInt(lot.quantity)) fail("Selected pick quantities do not reconcile to the lot");
    }
    if (lotTotal !== BigInt(resource.quantity)) fail("Selected lot quantities do not reconcile to the resource");
  }
  if (resourceTotal !== BigInt(plan.quantity)) fail("Selected resource quantities do not reconcile to the command");
});
export const canonicalClaimDispatchReceiptSchema = z.object({
  contractVersion: z.literal("canonical_claim_dispatch_receipt_v1"),
  commandHash: hash, planHash: hash, plan: canonicalClaimDispatchPlanSchema,
  occurredAt: z.string().datetime(),
}).strict();

export type CanonicalClaimDispatchCommand = z.infer<typeof canonicalClaimDispatchCommandSchema>;
export type CanonicalClaimDispatchEvidence = z.infer<typeof canonicalClaimDispatchEvidenceSchema>;
export type CanonicalClaimDispatchPlan = z.infer<typeof canonicalClaimDispatchPlanSchema>;
export type CanonicalClaimDispatchReceipt = z.infer<typeof canonicalClaimDispatchReceiptSchema>;
