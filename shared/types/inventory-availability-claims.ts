import { z } from "zod";

import { claimPlanSchema } from "./inventory-availability-planner";

const positiveInteger = z.number().int().positive().max(2_147_483_647);
const nonblank = (maximum: number) => z.string().trim().min(1).max(maximum);
const positiveBigintString = z.string().regex(/^[1-9][0-9]*$/);
const nonnegativeBigintString = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const canonicalAvailabilityClaimCommandSchema = z.object({
  orderId: positiveInteger,
  idempotencyKey: nonblank(120),
  actor: nonblank(100),
  reason: nonblank(1000),
}).strict();

export const canonicalAvailabilityClaimReleaseCommandSchema = z.object({
  orderId: positiveInteger,
  disposition: z.enum(["release", "cancel"]),
  expectedClaimId: positiveBigintString.optional(),
  expectedWarehouseStatus: nonblank(30).optional(),
  requireNoClaimableDemand: z.literal(true).optional(),
  idempotencyKey: nonblank(120),
  actor: nonblank(100),
  reason: nonblank(1000),
}).strict().superRefine((command, context) => {
  if (command.requireNoClaimableDemand === true) {
    if (command.expectedClaimId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedClaimId"],
        message: "expectedClaimId is required when claimable demand must be absent",
      });
    }
    if (command.expectedWarehouseStatus == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedWarehouseStatus"],
        message: "expectedWarehouseStatus is required when claimable demand must be absent",
      });
    }
  }
});

export const canonicalAvailabilityClaimReplacementCommandSchema = z.object({
  orderId: positiveInteger,
  expectedClaimId: positiveBigintString,
  idempotencyKey: nonblank(120),
  actor: nonblank(100),
  reason: nonblank(1000),
}).strict();

export const canonicalAvailabilityClaimOperationExecutionCommandSchema = z.object({
  claimId: positiveBigintString,
  operationKey: nonblank(300),
  idempotencyKey: nonblank(120),
  actor: nonblank(100),
  reason: nonblank(1000),
}).strict();

export const canonicalAvailabilityClaimBuildHandoffCommandSchema = z.object({
  claimId: positiveBigintString,
  operationKey: nonblank(300),
  idempotencyKey: nonblank(120),
  actor: nonblank(100),
  reason: nonblank(1000),
}).strict();

const canonicalAvailabilityClaimPickCommandBaseSchema = z.object({
  claimId: positiveBigintString,
  orderItemId: positiveInteger,
  warehouseLocationId: positiveInteger,
  quantity: positiveBigintString,
  idempotencyKey: nonblank(120),
  actor: nonblank(100),
  reason: nonblank(1000),
});

export const canonicalAvailabilityClaimPickCommandSchema = z.discriminatedUnion("locationStrategy", [
  canonicalAvailabilityClaimPickCommandBaseSchema.extend({
    locationStrategy: z.literal("strict"),
  }).strict(),
  canonicalAvailabilityClaimPickCommandBaseSchema.extend({
    locationStrategy: z.literal("reconcile_recorded_stock"),
  }).strict(),
  canonicalAvailabilityClaimPickCommandBaseSchema.extend({
    locationStrategy: z.literal("reconcile_picker_observation"),
    observation: z.object({
      kind: z.enum(["validated_item_scan", "picker_confirmed_physical_stock"]),
      observedPhysicalQty: positiveBigintString,
      locationCode: nonblank(50),
      deviceType: nonblank(50).optional(),
      sessionId: nonblank(120).optional(),
    }).strict(),
  }).strict(),
]).superRefine((command, context) => {
  if (command.locationStrategy !== "reconcile_picker_observation") return;
  if (BigInt(command.observation.observedPhysicalQty) < BigInt(command.quantity)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observation", "observedPhysicalQty"],
      message: "Observed physical quantity must cover the requested pick quantity",
    });
  }
});

export const canonicalAvailabilityClaimUnpickCommandSchema = z.object({
  claimId: positiveBigintString,
  orderItemId: positiveInteger,
  quantity: positiveBigintString,
  idempotencyKey: nonblank(120),
  actor: nonblank(100),
  reason: nonblank(1000),
}).strict();

export const canonicalAvailabilityClaimPickResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("picked"),
    claimId: positiveBigintString,
    claimLineId: positiveBigintString,
    orderId: positiveInteger,
    orderItemId: positiveInteger,
    warehouseLocationIds: z.array(positiveInteger).min(1).max(1000),
    quantity: positiveBigintString,
    reconciledQuantity: nonnegativeBigintString,
    totalCostMills: nonnegativeBigintString,
    idempotentReplay: z.boolean(),
  }).strict(),
  z.object({
    outcome: z.literal("unpicked"),
    claimId: positiveBigintString,
    claimLineId: positiveBigintString,
    orderId: positiveInteger,
    orderItemId: positiveInteger,
    warehouseLocationIds: z.array(positiveInteger).min(1).max(1000),
    quantity: positiveBigintString,
    reservationRestored: z.boolean(),
    totalCostMills: nonnegativeBigintString,
    idempotentReplay: z.boolean(),
  }).strict(),
  z.object({
    outcome: z.literal("picked_with_observation"),
    claimId: positiveBigintString,
    claimLineId: positiveBigintString,
    orderId: positiveInteger,
    orderItemId: positiveInteger,
    warehouseLocationIds: z.array(positiveInteger).length(1),
    quantity: positiveBigintString,
    reconciledQuantity: positiveBigintString,
    recordedReconciledQuantity: nonnegativeBigintString,
    observedRelocatedQuantity: positiveBigintString,
    inventoryReviewId: positiveInteger,
    observationKind: z.enum(["validated_item_scan", "picker_confirmed_physical_stock"]),
    totalCostMills: nonnegativeBigintString,
    idempotentReplay: z.boolean(),
  }).strict(),
]);

export const canonicalAvailabilityClaimBuildHandoffResultSchema = z.object({
  outcome: z.literal("build_handed_off"),
  claimId: positiveBigintString,
  claimOperationId: positiveBigintString,
  operationKey: nonblank(300),
  buildOrderId: positiveInteger,
  buildSystemNumber: nonblank(40),
  adoptedReservationQty: positiveBigintString,
  idempotentReplay: z.boolean(),
}).strict();

export const canonicalAvailabilityClaimOperationExecutionResultSchema = z.object({
  outcome: z.literal("executed"),
  claimId: positiveBigintString,
  claimOperationId: positiveBigintString,
  operationKey: nonblank(300),
  outputResourceId: positiveBigintString,
  producedQty: positiveBigintString,
  committedQty: positiveBigintString,
  surplusQty: nonnegativeBigintString,
  totalInputCostMills: nonnegativeBigintString,
  idempotentReplay: z.boolean(),
}).strict();

export const canonicalAvailabilityClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("no_claim_required"),
    orderId: positiveInteger,
    idempotentReplay: z.boolean(),
  }).strict(),
  z.object({
    outcome: z.literal("claimed"),
    claimId: z.string().regex(/^[1-9][0-9]*$/),
    claimKey: nonblank(200),
    orderId: positiveInteger,
    revision: positiveInteger,
    runtimeAuthorityRevision: z.string().regex(/^[1-9][0-9]*$/),
    plan: claimPlanSchema,
    idempotentReplay: z.boolean(),
  }).strict(),
  z.object({
    outcome: z.literal("released"),
    claimId: z.string().regex(/^[1-9][0-9]*$/),
    claimKey: nonblank(200),
    orderId: positiveInteger,
    status: z.enum(["released", "cancelled"]),
    releasedResourceQty: z.string().regex(/^(0|[1-9][0-9]*)$/),
    releasedLotQty: z.string().regex(/^(0|[1-9][0-9]*)$/),
    idempotentReplay: z.boolean(),
  }).strict(),
]);

export const canonicalAvailabilityClaimReplacementResultSchema = z.object({
  outcome: z.literal("replaced"),
  orderId: positiveInteger,
  supersededClaimId: positiveBigintString,
  supersededClaimKey: nonblank(200),
  supersededRevision: positiveInteger,
  replacementClaim: z.object({
    claimId: positiveBigintString,
    claimKey: nonblank(200),
    revision: positiveInteger,
    runtimeAuthorityRevision: positiveBigintString,
    plan: claimPlanSchema,
  }).strict(),
  releasedResourceQty: nonnegativeBigintString,
  releasedLotQty: nonnegativeBigintString,
  idempotentReplay: z.boolean(),
}).strict();

export type CanonicalAvailabilityClaimCommand = z.infer<
  typeof canonicalAvailabilityClaimCommandSchema
>;
export type CanonicalAvailabilityClaimResult = z.infer<
  typeof canonicalAvailabilityClaimResultSchema
>;
export type CanonicalAvailabilityClaimReleaseCommand = z.infer<
  typeof canonicalAvailabilityClaimReleaseCommandSchema
>;
export type CanonicalAvailabilityClaimReplacementCommand = z.infer<
  typeof canonicalAvailabilityClaimReplacementCommandSchema
>;
export type CanonicalAvailabilityClaimReplacementResult = z.infer<
  typeof canonicalAvailabilityClaimReplacementResultSchema
>;
export type CanonicalAvailabilityClaimOperationExecutionCommand = z.infer<
  typeof canonicalAvailabilityClaimOperationExecutionCommandSchema
>;
export type CanonicalAvailabilityClaimOperationExecutionResult = z.infer<
  typeof canonicalAvailabilityClaimOperationExecutionResultSchema
>;
export type CanonicalAvailabilityClaimBuildHandoffCommand = z.infer<
  typeof canonicalAvailabilityClaimBuildHandoffCommandSchema
>;
export type CanonicalAvailabilityClaimBuildHandoffResult = z.infer<
  typeof canonicalAvailabilityClaimBuildHandoffResultSchema
>;
export type CanonicalAvailabilityClaimPickCommand = z.infer<
  typeof canonicalAvailabilityClaimPickCommandSchema
>;
export type CanonicalAvailabilityClaimUnpickCommand = z.infer<
  typeof canonicalAvailabilityClaimUnpickCommandSchema
>;
export type CanonicalAvailabilityClaimPickResult = z.infer<
  typeof canonicalAvailabilityClaimPickResultSchema
>;
