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

export type CanonicalAvailabilityClaimCommand = z.infer<
  typeof canonicalAvailabilityClaimCommandSchema
>;
export type CanonicalAvailabilityClaimResult = z.infer<
  typeof canonicalAvailabilityClaimResultSchema
>;
export type CanonicalAvailabilityClaimReleaseCommand = z.infer<
  typeof canonicalAvailabilityClaimReleaseCommandSchema
>;
export type CanonicalAvailabilityClaimOperationExecutionCommand = z.infer<
  typeof canonicalAvailabilityClaimOperationExecutionCommandSchema
>;
export type CanonicalAvailabilityClaimOperationExecutionResult = z.infer<
  typeof canonicalAvailabilityClaimOperationExecutionResultSchema
>;
