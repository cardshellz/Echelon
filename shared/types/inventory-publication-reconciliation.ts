import { z } from "zod";

const databaseId = z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const epoch = z.string().refine(value => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const integerId = z.number().int().positive().max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Recovery selects destinations already owned by the prepared cutover, never caller-supplied accounts or quantities. */
export const publicationReconciliationReviewRequestSchema = z.object({ activationRunId: databaseId }).strict();
export const publicationReconciliationRequestSchema = publicationReconciliationReviewRequestSchema.extend({
  expectedReviewHash: hash,
  acceptUnknownRemoteOutcomes: z.literal(true),
  reason: z.string().trim().min(10).max(2000),
  idempotencyKey: text(200),
}).strict();
export const publicationReconciliationDestinationSchema = z.object({
  publicationTargetId: integerId, targetRevision: databaseId,
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  connectionId: integerId, providerKey: z.enum(["shopify", "ebay"]),
  providerScopeType: z.enum(["account", "location"]), externalScopeId: text(240),
}).strict();
export const publicationReconciliationAttemptSchema = z.object({
  attemptId: databaseId, state: z.enum(["running", "uncertain"]), gateEpoch: epoch,
  startedAt: z.string().datetime(), evidenceHash: hash,
  publicationTargetIds: z.array(integerId).min(1).max(1000).refine(values => new Set(values).size === values.length),
}).strict();
export const publicationReconciliationEvidenceSchema = z.object({
  activationRunId: databaseId, gateEpoch: epoch,
  destinations: z.array(publicationReconciliationDestinationSchema).min(1).max(1000),
  attempts: z.array(z.object({ id: databaseId, owner: text(30), state: text(30), gateEpoch: epoch,
    startedAt: z.string().datetime(), scope: z.unknown(), affectedScopes: z.unknown(), evidenceHash: hash }).strict()).max(1000),
  publicationRows: z.number().int().positive().max(100000), publicationManifestHash: hash,
}).strict();
export const publicationReconciliationReviewSchema = z.object({
  activationRunId: databaseId, gateEpoch: epoch, capturedAt: z.string().datetime(), reviewHash: hash,
  destinations: z.array(publicationReconciliationDestinationSchema).min(1).max(1000),
  attempts: z.array(publicationReconciliationAttemptSchema).max(1000),
  publicationRows: z.number().int().positive().max(100000), publicationManifestHash: hash,
  ready: z.boolean(), providerWriteAttempted: z.literal(false),
  historicalOutcome: z.literal("unknown"), requiredNextStep: z.literal("publish_and_verify_current_quantities"),
}).strict();
export const publicationReconciliationResultSchema = z.object({
  reconciliationId: databaseId, activationRunId: databaseId, reviewHash: hash,
  supersededAttemptIds: z.array(databaseId).min(1).max(1000).refine(values => new Set(values).size === values.length),
  historicalOutcome: z.literal("unknown"), requiredNextStep: z.literal("publish_and_verify_current_quantities"),
  providerWriteAttempted: z.literal(false), runtimeAuthorityChanged: z.literal(false), replay: z.boolean(),
}).strict();
export type PublicationReconciliationRequest = z.infer<typeof publicationReconciliationRequestSchema>;
export type PublicationReconciliationReview = z.infer<typeof publicationReconciliationReviewSchema>;
export type PublicationReconciliationDestination = z.infer<typeof publicationReconciliationDestinationSchema>;
export type PublicationReconciliationResult = z.infer<typeof publicationReconciliationResultSchema>;
