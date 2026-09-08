import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InventoryCutoverVerification } from "@shared/types/inventory-cutover-completion";
import { inventoryCutoverConservativePublicationEvidenceSchema, inventoryCutoverPublicationIdentitySchema,
  validateInventoryCutoverPublicationProof } from "./inventory-cutover-publication-proof";

const positive = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value =>
  /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value =>
  /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
export const committedInventoryPublicationManifestSchema = z.array(z.object({
  id: positive, publication_target_id: id, product_variant_id: id,
  desired_revision: positive, desired_quantity: quantity,
  publication_target_revision_snapshot: positive,
}).strict()).max(100_000).superRefine((rows, ctx) => {
  const keys = rows.map(row => `${row.publication_target_id}:${row.product_variant_id}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Committed publication pairs must be unique." });
  if (new Set(rows.map(row => row.id)).size !== rows.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Committed publication rows must have distinct immutable IDs." });
});

export const fullInventoryPublicationEvidenceSchema = inventoryCutoverConservativePublicationEvidenceSchema.extend({
  desiredRevision: positive,
  phase: z.literal("full"),
  targetState: z.literal("live"),
  mappingLifecycle: z.literal("sealed"),
  outboxIdentity: inventoryCutoverPublicationIdentitySchema,
}).strict();

const fullProofInputSchema = z.object({
  manifest: z.unknown(), evidence: z.array(z.unknown()).max(100_000),
  occurredAt: z.date(), maxReadbackAgeMs: z.number().int().positive().safe(),
}).strict();

/** Verifies the latest persisted desired revision, not an estimate of current ATP.
 * Gate/drain ownership is an additional repository precondition; this pure
 * function does not claim that external provider writes have been excluded.
 */
export function validateInventoryCutoverFullPublicationProof(rawInput: unknown): Pick<InventoryCutoverVerification, "blockers" | "publicationRows" | "verifiedPublicationRows"> {
  const blockers: InventoryCutoverVerification["blockers"] = [];
  const publicationRows: InventoryCutoverVerification["publicationRows"] = [];
  let verifiedPublicationRows = 0;
  const parsedInput = fullProofInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return { blockers: [{ code: "CUTOVER_FULL_PUBLICATION_PROOF_INPUT_INVALID", subject: "publications",
    message: "Full publication proof requires a valid review time, freshness policy and bounded evidence arrays." }], publicationRows, verifiedPublicationRows };
  const input = parsedInput.data;
  const manifest = committedInventoryPublicationManifestSchema.safeParse(input.manifest);
  if (!manifest.success) return { blockers: [{ code: "CUTOVER_COMMIT_PUBLICATION_MANIFEST_INVALID", subject: "publications",
    message: "The immutable commit publication manifest failed validation." }], publicationRows, verifiedPublicationRows };
  const expectedKeys = new Set(manifest.data.map(row => `${row.publication_target_id}:${row.product_variant_id}`));
  const byKey = new Map<string, unknown[]>();
  for (const candidate of input.evidence) {
    const key = z.object({ publicationTargetId: id, productVariantId: id }).safeParse(candidate);
    if (!key.success) {
      blockers.push({ code: "CUTOVER_FULL_PUBLICATION_EVIDENCE_INVALID", subject: "publications", message: "Publication evidence contains an invalid identity." });
      continue;
    }
    const identity = `${key.data.publicationTargetId}:${key.data.productVariantId}`;
    const existing = byKey.get(identity);
    if (existing) existing.push(candidate);
    else byKey.set(identity, [candidate]);
    if (!expectedKeys.has(identity)) blockers.push({ code: "CUTOVER_FULL_PUBLICATION_COVERAGE_CHANGED", subject: identity,
      message: "A publication pair is absent from the immutable cutover manifest." });
  }
  for (const expected of manifest.data) {
    const subject = `${expected.publication_target_id}:${expected.product_variant_id}`;
    const candidates = byKey.get(subject);
    const parsed = fullInventoryPublicationEvidenceSchema.safeParse(candidates?.length === 1 ? candidates[0] : null);
    if (!parsed.success) {
      blockers.push({ code: "CUTOVER_FULL_PUBLICATION_INCOMPLETE", subject,
        message: "Exactly one current full publication and sealed live destination mapping are required." });
      continue;
    }
    const row = parsed.data;
    publicationRows.push({ publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId,
      desiredRevision: row.desiredRevision, desiredQuantity: row.conservativeQuantity,
      observedQuantity: row.observedQuantity, state: row.state });
    const { desiredRevision, phase: _phase, targetState: _state, mappingLifecycle: _mapping, outboxIdentity, ...proof } = row;
    const found = validateInventoryCutoverPublicationProof({
      quantities: [{ publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId, desiredQuantity: row.conservativeQuantity }],
      evidence: [proof], occurredAt: input.occurredAt, maxReadbackAgeMs: input.maxReadbackAgeMs,
    }).blockers;
    if (BigInt(desiredRevision) < BigInt(expected.desired_revision)
      || canonicalJson(outboxIdentity) !== canonicalJson(row.expectedIdentity)
      || outboxIdentity.publicationTargetRevision !== expected.publication_target_revision_snapshot
      // An unchanged revision must still identify the immutable row committed
      // at cutover. Successor quantities may legitimately differ as orders move.
      || (desiredRevision === expected.desired_revision
        ? row.publicationId !== expected.id || row.conservativeQuantity !== expected.desired_quantity
        : row.publicationId === expected.id)
      || row.observedQuantity !== row.conservativeQuantity) {
      found.push({ code: "CUTOVER_FULL_PUBLICATION_NOT_CONFIRMED", subject,
        message: "The latest desired revision must match its exact current destination and observed quantity." });
    }
    blockers.push(...found);
    if (found.length === 0) verifiedPublicationRows += 1;
  }
  publicationRows.sort((a, b) => a.publicationTargetId - b.publicationTargetId || a.productVariantId - b.productVariantId);
  return { blockers, publicationRows, verifiedPublicationRows };
}
