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
/** Flattened operator view; this is recorded owner history, not a provider query. */
export const pendingQuantityPublicationRecoverySchema = z.object({
  activationRunId: bigintId, gateEpoch: epoch, suppressed: z.boolean(), capturedAt: z.string().datetime(),
  basis: z.literal("recorded_attempt_history"), providerWriteAttempted: z.literal(false),
  pendingCatchupCount: z.number().int().nonnegative().safe(),
  unresolvedAttempts: z.array(z.object({
    attemptId: bigintId, owner: z.enum(["legacy", "outbox"]), state: z.enum(["running", "uncertain"]),
    outboxId: bigintId.nullable(), destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
    connectionId: z.number().int().positive().max(2147483647), providerKey: z.enum(["shopify", "ebay"]),
    providerScopeType: z.enum(["account", "location"]), externalScopeId: text(240), externalInventoryItemId: text(240),
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
