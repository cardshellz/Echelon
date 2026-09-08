import { z } from "zod";

const identifier = z.string().trim().min(1).max(240);
const databaseInt = z.number().int().positive().max(2147483647);
const databaseBigInt = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const nonnegativeBigInt = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
export const quantityPublicationScopeSchema = z.object({
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  connectionId: databaseInt,
  providerKey: z.enum(["shopify", "ebay"]),
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: identifier,
  externalInventoryItemId: identifier,
  productId: databaseInt.nullable(),
  productVariantId: databaseInt.nullable(),
}).strict();
export type QuantityPublicationScope = z.infer<typeof quantityPublicationScopeSchema>;

export { quantityPublicationRecoverySchema, type QuantityPublicationRecovery } from "@shared/types/inventory-publication-recovery";

export class QuantityPublicationAdmissionError extends Error {
  readonly retryable = true;
  constructor(readonly code: string, message: string,
    readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "QuantityPublicationAdmissionError";
  }
}

export interface QuantityPublicationDrainProof {
  contractVersion: 1;
  activationRunId: string;
  gateEpoch: string;
  suppressed: boolean;
  latestAttemptId: string;
  unresolvedAttempts: Array<{
    attemptId: string;
    owner: "legacy" | "outbox";
    state: "running" | "uncertain";
    scope: QuantityPublicationScope;
    outboxId: string | null;
  }>;
  latestAttemptsByScope: Array<{
    scope: QuantityPublicationScope;
    attemptId: string;
    outboxId: string | null;
    gateEpoch: string;
    owner: "legacy" | "outbox";
    completedAt: string | null;
    resolutionBasis: "owner_completion" | "operator_attestation" | null;
  }>;
  pendingCatchupCount: number;
}

export const quantityPublicationDrainProofSchema: z.ZodType<QuantityPublicationDrainProof> = z.object({
  contractVersion: z.literal(1), activationRunId: databaseBigInt, gateEpoch: nonnegativeBigInt,
  suppressed: z.boolean(), latestAttemptId: nonnegativeBigInt,
  unresolvedAttempts: z.array(z.object({ attemptId: databaseBigInt, owner: z.enum(["legacy","outbox"]),
    state: z.enum(["running","uncertain"]), scope: quantityPublicationScopeSchema, outboxId: databaseBigInt.nullable() }).strict()).max(1000),
  latestAttemptsByScope: z.array(z.object({ scope: quantityPublicationScopeSchema, attemptId: databaseBigInt,
    outboxId: databaseBigInt.nullable(), gateEpoch: nonnegativeBigInt,
    owner: z.enum(["legacy","outbox"]), completedAt: z.string().datetime().nullable(),
    resolutionBasis: z.enum(["owner_completion","operator_attestation"]).nullable() }).strict()).max(10000),
  pendingCatchupCount: z.number().int().nonnegative().safe(),
}).strict();
