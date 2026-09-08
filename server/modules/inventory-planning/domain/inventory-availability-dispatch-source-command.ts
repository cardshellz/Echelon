import { z } from "zod";
import type { CanonicalClaimDispatchCommand, CanonicalClaimDispatchEvidence } from "@shared/types/inventory-availability-dispatch";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"),
  "Quantity exceeds PostgreSQL bigint");
export const canonicalClaimDispatchSourceRequestSchema = z.object({
  orderId: id, orderItemId: id, outboundShipmentId: id, sourceShipmentItemId: id,
  productVariantId: id, quantity, actor: z.string().trim().min(1).max(100), reason: z.string().trim().min(1).max(1_000),
}).strict();
type CanonicalClaimDispatchSourceRequest = z.infer<typeof canonicalClaimDispatchSourceRequestSchema>;
type CanonicalClaimDispatchPreparedSource = Omit<CanonicalClaimDispatchEvidence["source"], "dispatchedQuantity" | "warehouseLocationId">
  & { warehouseLocationId: number | null };

export class CanonicalClaimDispatchSourceCommandError extends Error {
  readonly classification = "permanent";
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message); this.name = "CanonicalClaimDispatchSourceCommandError";
  }
}

/** Source identity is immutable across retries and either physical materialization ordering. */
export function canonicalClaimDispatchSourceKey(sourceShipmentItemId: number): string {
  return `canonical-dispatch:source:${id.parse(sourceShipmentItemId)}:v1`;
}

/** Actor/reason are not replay identity: return the original audited command unchanged. */
export function assertCanonicalClaimDispatchSourceIdentity(
  request: z.infer<typeof canonicalClaimDispatchSourceRequestSchema>, command: CanonicalClaimDispatchCommand,
): void {
  for (const key of ["orderId", "orderItemId", "outboundShipmentId", "sourceShipmentItemId", "productVariantId", "quantity"] as const) {
    if (request[key] !== command[key]) throw new CanonicalClaimDispatchSourceCommandError(
      "CLAIM_DISPATCH_SOURCE_REPLAY_CONFLICT", "Committed dispatch belongs to different source identity or quantity", { field: key });
  }
}

const bigintId = quantity;
const counter = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(
  (value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"),
  "Counter exceeds PostgreSQL bigint");
const ownershipSchema = z.object({
  claims: z.array(z.object({ id: bigintId, orderId: id, status: z.enum(["active", "released", "cancelled", "superseded", "failed"]) }).strict()).max(1_000),
  lines: z.array(z.object({ id: bigintId, claimId: bigintId, orderItemId: id, targetVariantId: id, pickedQty: counter }).strict()).max(10_000),
  resources: z.array(z.object({ id: bigintId, claimId: bigintId, claimLineId: bigintId, warehouseId: id,
    warehouseLocationId: id, sourceVariantId: id, pickedQty: counter }).strict()).max(10_000),
  lots: z.array(z.object({ id: bigintId, claimId: bigintId, claimResourceId: bigintId, pickedQty: counter }).strict()).max(10_000),
  picks: z.array(z.object({ id: bigintId, claimId: bigintId, claimLineId: bigintId, claimResourceId: bigintId,
    claimLotAllocationId: bigintId, quantity, reversedQuantity: counter, dispatchedQuantity: counter }).strict()).max(10_000),
}).strict();

function requireEvidence(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new CanonicalClaimDispatchSourceCommandError(code, message);
}
function uniqueById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const result = new Map(rows.map((row) => [row.id, row]));
  requireEvidence(result.size === rows.length, "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Duplicate ownership evidence cannot choose a dispatch claim");
  return result;
}
function add(total: Map<string, bigint>, key: string, value: bigint): void { total.set(key, (total.get(key) ?? BigInt(0)) + value); }

/**
 * Select from reconciled remaining immutable pick lineage, not creation time or
 * a historical bin. The dispatcher subsequently verifies full claim/lot/COGS
 * balances. More than one surviving claim/bin is a reviewable ambiguity even if
 * only one could individually satisfy the source quantity.
 */
export function selectCanonicalClaimDispatchPickedOwner(
  rawRequest: CanonicalClaimDispatchSourceRequest, source: CanonicalClaimDispatchPreparedSource, rawEvidence: unknown,
): { claimId: string; warehouseId: number; warehouseLocationId: number } {
  const request = canonicalClaimDispatchSourceRequestSchema.parse(rawRequest);
  const parsed = ownershipSchema.safeParse(rawEvidence);
  if (!parsed.success) throw new CanonicalClaimDispatchSourceCommandError("CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID",
    "Picked ownership evidence violates its strict contract", { issues: parsed.error.issues });
  const evidence = parsed.data;
  for (const key of ["orderId", "orderItemId", "outboundShipmentId", "sourceShipmentItemId", "productVariantId", "quantity"] as const) {
    requireEvidence(source[key] === request[key], "CLAIM_DISPATCH_SOURCE_IDENTITY_MISMATCH", "WMS prepared source differs from the exact ingress request");
  }
  const claims = uniqueById(evidence.claims);
  const lines = uniqueById(evidence.lines);
  const resources = uniqueById(evidence.resources);
  const lots = uniqueById(evidence.lots);
  uniqueById(evidence.picks);
  const resourcePicked = new Map<string, bigint>();
  const linePicked = new Map<string, bigint>();
  const lotPicked = new Map<string, bigint>();
  const candidates = new Map<string, { claimId: string; warehouseId: number; warehouseLocationId: number; quantity: bigint }>();
  for (const claim of claims.values()) requireEvidence(claim.orderId === request.orderId,
    "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Candidate claim belongs to another order");
  for (const line of lines.values()) requireEvidence(claims.has(line.claimId) && line.orderItemId === request.orderItemId,
    "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Candidate claim line belongs to another owner");
  for (const resource of resources.values()) {
    const line = lines.get(resource.claimLineId);
    requireEvidence(line !== undefined && line.claimId === resource.claimId && resource.sourceVariantId === line.targetVariantId,
      "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Final-target resource does not belong to its exact claim line and variant");
  }
  for (const lot of lots.values()) requireEvidence(resources.get(lot.claimResourceId)?.claimId === lot.claimId,
    "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Picked lot allocation belongs to another claim resource");
  for (const pick of evidence.picks) {
    const resource = resources.get(pick.claimResourceId);
    const lot = lots.get(pick.claimLotAllocationId);
    requireEvidence(resource !== undefined && resource.claimId === pick.claimId && resource.claimLineId === pick.claimLineId
      && lot !== undefined && lot.claimResourceId === resource.id && lot.claimId === pick.claimId,
    "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Original picked movement does not match its exact claim, line, resource and lot");
    const remaining = BigInt(pick.quantity) - BigInt(pick.reversedQuantity) - BigInt(pick.dispatchedQuantity);
    requireEvidence(remaining >= BigInt(0), "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Original pick has been reversed or dispatched beyond its quantity");
    add(lotPicked, lot.id, remaining);
  }
  for (const lot of lots.values()) {
    requireEvidence((lotPicked.get(lot.id) ?? BigInt(0)) === BigInt(lot.pickedQty),
      "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Remaining original picks do not reconcile to picked lot custody");
    add(resourcePicked, lot.claimResourceId, BigInt(lot.pickedQty));
  }
  for (const resource of resources.values()) {
    requireEvidence((resourcePicked.get(resource.id) ?? BigInt(0)) === BigInt(resource.pickedQty),
      "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Picked lot custody does not reconcile to the final target resource");
    add(linePicked, resource.claimLineId, BigInt(resource.pickedQty));
    if (resource.pickedQty === "0") continue;
    const claim = claims.get(resource.claimId)!;
    requireEvidence(!["cancelled", "failed"].includes(claim.status) && resource.sourceVariantId === request.productVariantId,
      "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Remaining picked custody belongs to a terminal claim or different target variant");
    const key = `${resource.claimId}:${resource.warehouseId}:${resource.warehouseLocationId}`;
    const candidate = candidates.get(key) ?? { claimId: resource.claimId, warehouseId: resource.warehouseId,
      warehouseLocationId: resource.warehouseLocationId, quantity: BigInt(0) };
    candidates.set(key, { ...candidate, quantity: candidate.quantity + BigInt(resource.pickedQty) });
  }
  for (const line of lines.values()) requireEvidence((linePicked.get(line.id) ?? BigInt(0)) === BigInt(line.pickedQty),
    "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID", "Final target resources do not reconcile to picked claim line custody");
  requireEvidence(candidates.size !== 0, "CLAIM_DISPATCH_SOURCE_PICKED_MISSING", "No exact remaining picked claim custody owns this source");
  requireEvidence(candidates.size === 1, "CLAIM_DISPATCH_SOURCE_PICKED_AMBIGUOUS", "Multiple picked claim or bin owners require explicit source reconciliation");
  const candidate = [...candidates.values()][0];
  requireEvidence(candidate.warehouseId === source.warehouseId, "CLAIM_DISPATCH_SOURCE_WAREHOUSE_MISMATCH", "Picked claim custody belongs to another warehouse");
  requireEvidence(source.warehouseLocationId === null || source.warehouseLocationId === candidate.warehouseLocationId,
    "CLAIM_DISPATCH_SOURCE_BIN_MISMATCH", "Persisted source bin differs from the remaining exact picked custody; historical identity cannot be overwritten");
  requireEvidence(candidate.quantity >= BigInt(request.quantity), "CLAIM_DISPATCH_SOURCE_PICKED_SHORTFALL", "Exact picked owner cannot satisfy the complete source quantity");
  return { claimId: candidate.claimId, warehouseId: candidate.warehouseId, warehouseLocationId: candidate.warehouseLocationId };
}
