import { z } from "zod";

const id = z.number().int().positive().safe();
const cents = z.number().int().nonnegative().safe();
const points = z.string().regex(/^\d{1,10}\.\d{2}$/);
export const cancellationRewardsSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    returnedPoints: points,
    deductedEarnedPoints: points,
    settled: z.boolean(),
  })
  .strict();
export const customerOrderCancellationInputSchema = z
  .object({
    connectionId: id,
    omsOrderId: id,
    expectedRevision: z.string().min(1).max(200),
    requestKey: z.string().uuid(),
  })
  .strict();
export const customerOrderCancellationReviewSchema = z
  .object({
    connectionId: id,
    omsOrderId: id,
    orderNumber: z.string().min(1),
    currency: z.literal("USD"),
    revision: z.string().min(1),
    orderRevision: z.string().min(1),
    refundCents: cents,
    rewards: cancellationRewardsSchema,
    eligibility: z
      .object({ allowed: z.boolean(), reasons: z.array(z.string().min(1)) })
      .strict(),
  })
  .strict();
export const customerOrderCancellationSchema = z
  .object({
    operationId: z.string().uuid(),
    requestKey: z.string().uuid(),
    omsOrderId: id,
    orderNumber: z.string(),
    currency: z.literal("USD"),
    status: z.enum([
      "submitting",
      "pending",
      "refunding",
      "synchronizing",
      "completed",
      "not_submitted",
      "review_required",
    ]),
    refundCents: cents,
    refundStatus: z.enum(["pending", "completed", "not_submitted"]),
    rewards: cancellationRewardsSchema,
    error: z
      .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict();

/** Cancellation shares durable order-mutation ownership and its append-only
 * audit with edits. It never fabricates an order-edit quote or calls editCommit. */
export const orderCancellationDocumentSchema = z
  .object({
    stage: z.enum([
      "acquiring",
      "submitting",
      "accepted",
      "uncertain",
      "settling",
    ]),
    jobId: z
      .string()
      .regex(/^gid:\/\/shopify\/(?:Job|OrderCancelJobResult)\/.+$/)
      .nullable(),
    refundCents: cents,
    rewards: cancellationRewardsSchema,
  })
  .strict();
export type CustomerOrderCancellationInput = z.infer<
  typeof customerOrderCancellationInputSchema
>;
export type CustomerOrderCancellationReview = z.infer<
  typeof customerOrderCancellationReviewSchema
>;
export type CustomerOrderCancellation = z.infer<
  typeof customerOrderCancellationSchema
>;
export type CancellationRewards = z.infer<typeof cancellationRewardsSchema>;
