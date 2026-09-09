import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";

const databaseId = z.string().regex(/^[1-9][0-9]{0,18}$/);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema),
]));
// PostgreSQL JSONB evidence must be present and complete. Undefined values or
// non-JSON values must not disappear silently when computing a reviewed digest.
const receiptRowSchema = z.object({ id: databaseId, status: z.string(), evidence: z.record(jsonValueSchema) }).passthrough();
const acknowledgementSchema = z.object({
  status: z.literal("ignored"), errorCode: z.null(),
  attemptOutcome: z.literal("ignored"), attemptErrorCode: z.null(), sourceEcho: z.literal(true),
  attemptCount: z.number().int().positive(), attemptNumber: z.number().int().positive(),
  sourceProvider: z.string().min(1).max(50), sourceChannelId: databaseId,
  sourceOrderId: z.string().min(1).max(200), sourceFulfillmentId: z.string().min(1).max(200),
  omsOrderId: databaseId, physicalShipmentId: databaseId,
}).refine((row) => row.attemptCount === row.attemptNumber);

type ReviewEvidence = CutoverReconstructionEvidence["shipmentReviewEvidence"][number];
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Consolidates repeated recorded acknowledgments, never grants inventory or
 * package authority. Every group remains a cutover blocker. Full immutable
 * attempts and receipt state remain in its digest, so review cannot silently
 * survive changed membership, errors, identity, or inventory-relevant metadata.
 */
export function groupCutoverReceiptEvidence(rawRows: readonly unknown[]): ReviewEvidence[] {
  const rows = z.array(receiptRowSchema).parse(rawRows);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("OMS_CUTOVER_DUPLICATE_RECEIPT_IDENTITY");
  }
  const individual: ReviewEvidence[] = [];
  const groups = new Map<string, Array<{ id: string; evidence: unknown }>>();
  for (const row of rows) {
    const acknowledgement = acknowledgementSchema.safeParse(row);
    if (!acknowledgement.success) {
      individual.push({ id: row.id, kind: "channel_fulfillment_receipt", status: row.status,
        evidenceHash: hash(row.evidence) });
      continue;
    }
    const identity = acknowledgement.data;
    // Provider identities can be long or contain delimiters. Keep the blocker
    // subject bounded without truncating or aliasing any identity component.
    const scopeHash = hash([identity.sourceProvider, identity.sourceChannelId, identity.sourceOrderId,
      identity.sourceFulfillmentId, identity.omsOrderId, identity.physicalShipmentId]);
    const groupId = `package:${identity.physicalShipmentId}:scope:${scopeHash}`;
    const group = groups.get(groupId) ?? [];
    group.push({ id: row.id, evidence: row.evidence });
    groups.set(groupId, group);
  }
  for (const [id, receipts] of groups) {
    receipts.sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0);
    individual.push({ id, kind: "channel_fulfillment_acknowledgment", status: "ignored",
      evidenceHash: hash({ identity: id, receipts }) });
  }
  return individual.sort((left, right) => {
    const a = `${left.kind}:${left.id}`, b = `${right.kind}:${right.id}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
