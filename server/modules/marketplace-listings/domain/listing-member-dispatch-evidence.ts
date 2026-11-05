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
  dispatch_status: z.enum(["none", "unknown", "accepted", "authorized"]).nullable().optional(),
  dispatch_key: z.string().uuid().nullable().optional(),
  dispatch_finality: z.enum(["pending", "terminal"]).nullable().optional(),
  verification_attempts: z.number().int().nonnegative().nullable().optional(),
  recovery_required: z.boolean().nullable().optional(),
}).passthrough();
const eventSchema = z.object({ version: z.number().int().positive(), afterState: snapshotSchema }).strict();

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
  dispatchFinality: string | null;
}

/** Current readback and request finality are different facts. Each unknown
 * dispatch is closed only by an explicitly terminal receipt for that same key.
 * Historical acceptances without finality evidence remain unconfirmed. */
export class ListingMemberDispatchHistoryAssessment {
  private readonly pendingKeys = new Set<string>();
  private readonly observedKeys = new Set<string>();
  private readonly expectedIdentity: string;
  private readonly expectedSourceIdentity: string;
  private invalid = false;
  private unkeyedMarker = false;
  private hadRetiringEvent = false;
  private count = 0;
  private latest: z.infer<typeof snapshotSchema> | null = null;

  constructor(private readonly head: ListingMemberDispatchHead) {
    try {
      this.expectedIdentity = canonicalJson(head.identity);
      this.expectedSourceIdentity = canonicalJson(head.sourceIdentity);
    } catch {
      this.expectedIdentity = "";
      this.expectedSourceIdentity = "";
      this.invalid = true;
    }
  }

  append(raw: unknown): void {
    if (this.invalid) return;
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) { this.invalid = true; return; }
    const { version, afterState: snapshot } = parsed.data;
    try {
      if (version !== this.count + 1 || snapshot.version !== version || snapshot.id !== this.head.id
        || snapshot.identity_key !== this.head.identityKey || snapshot.source_revision !== this.head.sourceRevision
        || snapshot.product_id !== this.head.productId || snapshot.product_variant_id !== this.head.productVariantId
        || canonicalJson(snapshot.identity) !== this.expectedIdentity || canonicalJson(snapshot.source_identity) !== this.expectedSourceIdentity) {
        this.invalid = true;
        return;
      }
    } catch { this.invalid = true; return; }
    this.count++;
    this.latest = snapshot;
    const status = snapshot.dispatch_status ?? "none";
    const key = snapshot.dispatch_key ?? null;
    const finality = snapshot.dispatch_finality ?? null;
    if (finality !== null && status !== "accepted") { this.invalid = true; return; }
    if (snapshot.state === "retiring") this.hadRetiringEvent = true;
    if (status === "none" && (snapshot.state === "retiring" || snapshot.recovery_required === true
      || (snapshot.verification_attempts ?? 0) > 0)) this.unkeyedMarker = true;
    if (status === "unknown") {
      if (key) { this.observedKeys.add(key); this.pendingKeys.add(key); }
      else this.unkeyedMarker = true;
    } else if (status === "accepted") {
      if (!key) this.unkeyedMarker = true;
      else if (finality === "terminal" && this.observedKeys.has(key)) this.pendingKeys.delete(key);
      else if (finality === "terminal") this.unkeyedMarker = true;
      else this.pendingKeys.add(key);
    }
  }

  result(): { unconfirmed: boolean; hadRetiringEvent: boolean } {
    const latest = this.latest;
    if (this.invalid || this.count !== this.head.version || !latest || latest.state !== this.head.state
      || latest.code !== this.head.code || (latest.dispatch_status ?? "none") !== this.head.dispatchStatus
      || (latest.dispatch_key ?? null) !== this.head.dispatchKey
      || (latest.dispatch_finality ?? null) !== this.head.dispatchFinality)
      return { unconfirmed: true, hadRetiringEvent: true };
    return { unconfirmed: this.unkeyedMarker || this.pendingKeys.size > 0, hadRetiringEvent: this.hadRetiringEvent };
  }
}

export function assessListingMemberDispatchHistory(head: ListingMemberDispatchHead, rawEvents: unknown): {
  unconfirmed: boolean; hadRetiringEvent: boolean;
} {
  const assessment = new ListingMemberDispatchHistoryAssessment(head);
  if (!Array.isArray(rawEvents)) return { unconfirmed: true, hadRetiringEvent: true };
  for (const event of rawEvents) assessment.append(event);
  return assessment.result();
}
