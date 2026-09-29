import { z } from "zod";

const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value =>
  /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const epoch = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value =>
  /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const text = (maximum: number) => z.string().trim().min(1).max(maximum);

export const quantityPublicationRecoverySchema = z.object({
  attemptId: bigintId,
  idempotencyKey: text(200),
  reason: z.string().trim().min(10).max(2000),
  evidenceKind: z.enum(["provider_terminal_request_record", "owner_process_and_request_termination_record"]),
  terminalOutcome: z.enum(["completed", "not_sent"]),
  evidenceReference: text(2000),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type QuantityPublicationRecovery = z.infer<typeof quantityPublicationRecoverySchema>;

export const pendingQuantityPublicationRecoveryRequestSchema = z.object({ activationRunId: bigintId.optional() }).strict();
/** The provider's stored final answer to an uncertain attempt: every request has a receipt and the last is a 4xx refusal with the provider's codes. */
export const quantityPublicationProviderAnswerSchema = z.object({
  requestId: bigintId, method: z.enum(["POST", "PUT", "DELETE"]), path: text(1024),
  // The code bound mirrors the writer (quantityProviderResponseEvidenceSchema); stored receipts are immutable, so nothing on file falls outside it.
  httpStatus: z.number().int().min(400).max(499), errorCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(25),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/), recordedAt: z.string().datetime(),
}).strict();
export type QuantityPublicationProviderAnswer = z.infer<typeof quantityPublicationProviderAnswerSchema>;
/** Nothing of the attempt can still reach the provider: its last stored activity lies further back than the request deadline plus a wide margin. */
export const quantityPublicationRequestTerminationSchema = z.object({
  requestCount: z.number().int().nonnegative().max(10000), lastActivityAt: z.string().datetime(), quiescentSince: z.string().datetime(),
  providerRequestTimeoutSeconds: z.number().int().positive().max(3600), quiescenceMarginMinutes: z.number().int().positive().max(1440),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type QuantityPublicationRequestTermination = z.infer<typeof quantityPublicationRequestTerminationSchema>;
/** One click confirms every listed attempt whose stored evidence the operator saw; the hash pins what was on screen. */
export const quantityPublicationProviderAnswerRecoverySchema = z.object({
  activationRunId: bigintId.optional(),
  confirmations: z.array(z.object({ attemptId: bigintId, evidenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.confirmations.map(row => row.attemptId)).size !== value.confirmations.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmations"], message: "Each attempt may be confirmed once per request." });
  }
});
export type QuantityPublicationProviderAnswerRecovery = z.infer<typeof quantityPublicationProviderAnswerRecoverySchema>;
/** Why a listed attempt was not confirmed: it left the list, has no evidence on file, its record changed since it was shown, or another operator resolved it first. */
export const quantityPublicationProviderAnswerSkipReasonSchema = z.enum(["not_pending", "no_evidence", "evidence_changed", "owner_conflict"]);
export type QuantityPublicationProviderAnswerSkipReason = z.infer<typeof quantityPublicationProviderAnswerSkipReasonSchema>;
export const quantityPublicationProviderAnswerRecoveryResultSchema = z.object({
  basis: z.literal("operator_attestation"), providerWriteAttempted: z.literal(false),
  confirmed: z.array(z.object({ attemptId: bigintId, replay: z.boolean() }).strict()).max(1000),
  skipped: z.array(z.object({ attemptId: bigintId, reason: quantityPublicationProviderAnswerSkipReasonSchema }).strict()).max(1000),
}).strict();
export type QuantityPublicationProviderAnswerRecoveryResult = z.infer<typeof quantityPublicationProviderAnswerRecoveryResultSchema>;
/** Flattened operator view; this is recorded owner history, not a provider query. */
export const pendingQuantityPublicationRecoverySchema = z.object({
  activationRunId: bigintId, gateEpoch: epoch, suppressed: z.boolean(), capturedAt: z.string().datetime(),
  basis: z.literal("recorded_attempt_history"), providerWriteAttempted: z.literal(false),
  pendingCatchupCount: z.number().int().nonnegative().safe(),
  unresolvedAttempts: z.array(z.object({
    attemptId: bigintId, owner: z.enum(["legacy", "outbox", "listing_setup_zero"]), state: z.enum(["running", "uncertain"]),
    outboxId: bigintId.nullable(), destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
    connectionId: z.number().int().positive().max(2147483647), providerKey: z.enum(["shopify", "ebay", "walmart"]),
    providerScopeType: z.enum(["account", "location"]), externalScopeId: text(240), externalInventoryItemId: text(240),
    /** Optional so a client one release ahead of its server still parses; absent and null both mean no answer on file. */
    providerAnswer: quantityPublicationProviderAnswerSchema.nullable().optional(),
    requestTermination: quantityPublicationRequestTerminationSchema.nullable().optional(),
  }).strict()).max(1000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.unresolvedAttempts.map(row => row.attemptId)).size !== value.unresolvedAttempts.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unresolvedAttempts"], message: "Unresolved attempts must have unique immutable IDs." });
  }
});
export const quantityPublicationRecoveryResultSchema = z.object({
  attemptId: bigintId, basis: z.literal("operator_attestation"), replay: z.boolean(), providerWriteAttempted: z.literal(false),
}).strict();
export type PendingQuantityPublicationRecovery = z.infer<typeof pendingQuantityPublicationRecoverySchema>;
export type QuantityPublicationRecoveryResult = z.infer<typeof quantityPublicationRecoveryResultSchema>;
