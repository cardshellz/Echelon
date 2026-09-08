import { z } from "zod";
import type { InventoryCutoverReview } from "@shared/types/inventory-cutover-commit";

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine((value) =>
  /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= POSTGRES_BIGINT_MAX);
const positiveQuantity = quantity.refine((value) => value !== "0");
const identityText = z.string().min(1).max(240).refine((value) => value.trim().length > 0);
const timestamp = z.union([z.date(), z.string().datetime({ offset: true })]);

export const inventoryCutoverPublicationIdentitySchema = z.object({
  externalInventoryItemId: identityText,
  publicationTargetRevision: positiveQuantity,
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  channelConnectionId: id.nullable(),
  dropshipStoreConnectionId: id.nullable(),
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: identityText,
}).strict().superRefine((identity, context) => {
  const validOwner = identity.destinationKind === "channel_connection"
    ? identity.channelConnectionId !== null && identity.dropshipStoreConnectionId === null
    : identity.dropshipStoreConnectionId !== null && identity.channelConnectionId === null;
  if (!validOwner) context.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationKind"],
    message: "Exactly the declared publication destination owner is required." });
});

export const inventoryCutoverPublicationExpectationSchema = z.object({
  publicationTargetId: id,
  productVariantId: id,
  desiredQuantity: quantity,
}).strict();

export const inventoryCutoverConservativePublicationEvidenceSchema = z.object({
  publicationId: positiveQuantity,
  publicationTargetId: id,
  productVariantId: id,
  state: z.string().min(1),
  conservativeQuantity: quantity,
  acknowledgedAt: timestamp.nullable(),
  observedQuantity: quantity.nullable(),
  observedAt: timestamp.nullable(),
  expectedIdentity: inventoryCutoverPublicationIdentitySchema,
  observedIdentity: inventoryCutoverPublicationIdentitySchema.nullable(),
}).strict();

export type InventoryCutoverPublicationIdentity = z.infer<typeof inventoryCutoverPublicationIdentitySchema>;
export type InventoryCutoverPublicationExpectation = z.infer<typeof inventoryCutoverPublicationExpectationSchema>;
export type InventoryCutoverConservativePublicationEvidence = z.infer<typeof inventoryCutoverConservativePublicationEvidenceSchema>;
export type InventoryCutoverPublicationProofBlocker = InventoryCutoverReview["blockers"][number];

const inputSchema = z.object({
  quantities: z.array(z.unknown()).max(100_000),
  evidence: z.array(z.unknown()).max(100_000),
  occurredAt: z.date(),
  maxReadbackAgeMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const evidenceKeySchema = z.object({ publicationTargetId: id, productVariantId: id });

/**
 * Pure validation of recorded evidence, not a live provider query or a claim
 * that an external writer cannot change inventory after the observation.
 */
export function validateInventoryCutoverPublicationProof(input: unknown): {
  blockers: InventoryCutoverPublicationProofBlocker[];
} {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { blockers: [{ code: "CUTOVER_PROVIDER_PROOF_INPUT_INVALID", subject: "publications",
    message: "Publication proof requires a valid review time, freshness policy and bounded evidence arrays." }] };
  const blockers: InventoryCutoverPublicationProofBlocker[] = [];
  const quantities = parsed.data.quantities.map((row) => inventoryCutoverPublicationExpectationSchema.safeParse(row));
  if (quantities.some((row) => !row.success)) return { blockers: [{ code: "CUTOVER_PUBLICATION_PLAN_INVALID", subject: "publications",
    message: "Every planned publication must have exact target/SKU identities and a bounded nonnegative integer quantity." }] };
  const expectations = quantities.flatMap((row) => row.success ? [row.data] : []);
  const expectationKeys = new Set(expectations.map(key));
  const byKey = new Map<string, unknown[]>();
  let invalidEvidenceKey = false;
  for (const evidence of parsed.data.evidence) {
    const identity = evidenceKeySchema.safeParse(evidence);
    if (!identity.success) { invalidEvidenceKey = true; continue; }
    const identityKey = key(identity.data);
    const existing = byKey.get(identityKey);
    if (existing) existing.push(evidence);
    else byKey.set(identityKey, [evidence]);
  }
  if (invalidEvidenceKey || expectationKeys.size !== expectations.length
    || parsed.data.evidence.length !== expectations.length || byKey.size !== expectationKeys.size
    || [...byKey].some(([identity, rows]) => !expectationKeys.has(identity) || rows.length !== 1)) {
    blockers.push({ code: "CUTOVER_CONSERVATIVE_COVERAGE_INVALID", subject: "publications",
      message: "Every intended target/SKU needs exactly one conservative publication, with no duplicate or extra identities." });
  }
  const now = parsed.data.occurredAt.getTime();
  for (const expected of expectations) {
    const subject = `target:${expected.publicationTargetId}:variant:${expected.productVariantId}`;
    const rows = byKey.get(key(expected));
    const evidence = inventoryCutoverConservativePublicationEvidenceSchema.safeParse(rows?.length === 1 ? rows[0] : undefined);
    if (!evidence.success || !isCurrentProof(evidence.data, now, parsed.data.maxReadbackAgeMs)) {
      blockers.push({ code: "CUTOVER_PROVIDER_PROOF_INCOMPLETE", subject,
        message: "A verified publication, exact-identity acknowledgement and fresh readback at or after that acknowledgement are required." });
      continue;
    }
    // Both values crossed the bounded decimal-string schemas before BigInt.
    if (BigInt(evidence.data.observedQuantity!) > BigInt(expected.desiredQuantity)) {
      blockers.push({ code: "CUTOVER_PROVIDER_EXPOSURE_ABOVE_PLAN", subject,
        message: "Provider exposure exceeds the current post-reconstruction plan; refresh conservative publication before switching authority." });
    }
  }
  return { blockers };
}

function isCurrentProof(evidence: InventoryCutoverConservativePublicationEvidence, now: number, maxReadbackAgeMs: number): boolean {
  if (evidence.state !== "verified" || evidence.acknowledgedAt === null || evidence.observedAt === null
    || evidence.observedQuantity === null || evidence.observedIdentity === null) return false;
  const acknowledgedAt = milliseconds(evidence.acknowledgedAt);
  const observedAt = milliseconds(evidence.observedAt);
  if (!Number.isFinite(acknowledgedAt) || !Number.isFinite(observedAt) || acknowledgedAt > now
    || observedAt < acknowledgedAt || observedAt > now || now - observedAt > maxReadbackAgeMs) return false;
  // A fresh provider observation may reconfirm an older successful write; the
  // age limit belongs to readback, not the original acknowledgement timestamp.
  const expected = evidence.expectedIdentity;
  const observed = evidence.observedIdentity;
  return expected.externalInventoryItemId === observed.externalInventoryItemId
    && expected.publicationTargetRevision === observed.publicationTargetRevision
    && expected.destinationKind === observed.destinationKind
    && expected.channelConnectionId === observed.channelConnectionId
    && expected.dropshipStoreConnectionId === observed.dropshipStoreConnectionId
    && expected.providerScopeType === observed.providerScopeType
    && expected.externalScopeId === observed.externalScopeId;
}

function milliseconds(value: Date | string): number { return value instanceof Date ? value.getTime() : Date.parse(value); }
function key(value: { publicationTargetId: number; productVariantId: number }): string {
  return `${value.publicationTargetId}:${value.productVariantId}`;
}
