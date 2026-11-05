import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

const snapshotSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  identity_key: z.string(),
  identity: z.unknown(),
  source_identity: z.unknown(),
  source_revision: z.string(),
  product_id: z.number().int().positive(),
  product_variant_id: z.number().int().positive(),
  state: z.enum(["pending", "retiring", "retired", "failed", "superseded"]),
  code: z.string().nullable(),
  dispatch_status: z.enum(["none", "unknown", "accepted", "authorized"]).optional(),
  dispatch_key: z.string().uuid().nullable().optional(),
  verification_attempts: z.number().int().nonnegative().optional(),
  recovery_required: z.boolean().optional(),
}).passthrough();
const eventsSchema = z.array(z.object({ version: z.number().int().positive(), afterState: snapshotSchema }).strict());

export interface ListingMemberDispatchHead {
  id: string;
  version: number;
  identityKey: string;
  identity: unknown;
  sourceIdentity: unknown;
  sourceRevision: string;
  productId: number;
  productVariantId: number;
  state: string;
  code: string | null;
  dispatchStatus: string;
  dispatchKey: string | null;
}

/** Current readback and request finality are different facts. Each unknown
 * dispatch is closed only by a later acceptance of that same dispatch key.
 * Historical markers without a key and incomplete audit streams are unknown. */
export function assessListingMemberDispatchHistory(head: ListingMemberDispatchHead, rawEvents: unknown): {
  unconfirmed: boolean; hadRetiringEvent: boolean;
} {
  const parsed = eventsSchema.safeParse(rawEvents);
  if (!parsed.success || parsed.data.length !== head.version)
    return { unconfirmed: true, hadRetiringEvent: true };

  const pendingKeys = new Set<string>();
  let unkeyedMarker = false;
  let hadRetiringEvent = false;
  try {
    const identity = canonicalJson(head.identity);
    const sourceIdentity = canonicalJson(head.sourceIdentity);
    for (const [index, event] of parsed.data.entries()) {
      const snapshot = event.afterState;
      if (event.version !== index + 1 || snapshot.version !== event.version || snapshot.id !== head.id
        || snapshot.identity_key !== head.identityKey || snapshot.source_revision !== head.sourceRevision
        || snapshot.product_id !== head.productId || snapshot.product_variant_id !== head.productVariantId
        || canonicalJson(snapshot.identity) !== identity || canonicalJson(snapshot.source_identity) !== sourceIdentity)
        return { unconfirmed: true, hadRetiringEvent: true };
      const status = snapshot.dispatch_status ?? "none";
      const key = snapshot.dispatch_key ?? null;
      if (snapshot.state === "retiring") hadRetiringEvent = true;
      if (snapshot.state === "retiring" && status === "none") unkeyedMarker = true;
      if (status === "none" && (snapshot.recovery_required === true || (snapshot.verification_attempts ?? 0) > 0)) unkeyedMarker = true;
      if (status === "unknown") {
        if (key) pendingKeys.add(key);
        else unkeyedMarker = true;
      } else if (status === "accepted" && key) pendingKeys.delete(key);
    }
    const latest = parsed.data.at(-1)?.afterState;
    if (!latest || latest.state !== head.state || latest.code !== head.code || (latest.dispatch_status ?? "none") !== head.dispatchStatus
      || (latest.dispatch_key ?? null) !== head.dispatchKey)
      return { unconfirmed: true, hadRetiringEvent: true };
  } catch {
    return { unconfirmed: true, hadRetiringEvent: true };
  }
  return { unconfirmed: unkeyedMarker || pendingKeys.size > 0, hadRetiringEvent };
}
