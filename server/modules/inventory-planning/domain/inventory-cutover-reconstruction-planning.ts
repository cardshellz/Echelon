import { claimPlanSchema, claimPlanRequestSchema,
  type ClaimPlanDto, type ClaimPlanRequestDto, type ClaimSupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import type { CutoverReconstructionOrder, CutoverReconstructionPlan, CutoverLegacyPromiseRelease } from "@shared/types/inventory-cutover-reconstruction";
import { parseClaimSupplySnapshot, planCanonicalClaim, sealClaimSupplySnapshot } from "./inventory-availability-planner";
import { reconstructionHash } from "./inventory-cutover-reconstruction";
import type { OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { projectVerifiedOpeningClaimSupply } from "./inventory-opening-supply-projection";

export type PlannedCutoverOrder = { order: CutoverReconstructionOrder; request: ClaimPlanRequestDto; plan: ClaimPlanDto; freshPlan: ClaimPlanDto | null };
export type CutoverReconstructionPlanningResult = { orders: PlannedCutoverOrder[];
  freshReservationsByLevel: Array<{ inventoryLevelId: number; reservedQty: string }>;
  impactHash: string; inventoryPositions: ClaimSupplySnapshotDto["inventoryPositions"] };

/** Shared by demand and per-product publication preview; never edits raw stock. */
export function projectCutoverPromiseReservations(
  positions: ClaimSupplySnapshotDto["inventoryPositions"], releases: readonly CutoverLegacyPromiseRelease[],
): ClaimSupplySnapshotDto["inventoryPositions"] {
  const byLevel = new Map(releases.map((release) => [release.inventoryLevelId, release]));
  return positions.map((position) => {
    const release = byLevel.get(position.inventoryLevelId);
    if (!release) return { ...position };
    if (position.warehouseLocationId !== release.warehouseLocationId || position.productVariantId !== release.productVariantId
      || position.variantQty !== release.variantQty || position.reservedQty !== release.reservedQty
      || position.pickedQty !== release.pickedQty || position.packedQty !== release.packedQty) {
      throw Object.assign(new Error("The reviewed legacy promise position changed before projection."), {
        code: "CUTOVER_LEGACY_PROMISE_PROJECTION_CHANGED", context: { inventoryLevelId: position.inventoryLevelId } });
    }
    return { ...position, reservedQty: "0" };
  });
}

/** Same pure planning batch for preview and commit. Each order sees the previous
 * order's additional claims, never a fresh copy of the same free inventory. */
export function planFreshCutoverClaims(rawSnapshot: ClaimSupplySnapshotDto, reconstruction: CutoverReconstructionPlan,
  opening: OpeningVerification | null = null): CutoverReconstructionPlanningResult {
  if (!reconstruction.ready) throw new Error("CUTOVER_RECONSTRUCTION_BLOCKED");
  // Projection is permitted to reseal only an already verified original census.
  let snapshot = parseClaimSupplySnapshot(rawSnapshot);
  const capturedLevelIds = new Set(snapshot.inventoryPositions.map((position) => position.inventoryLevelId));
  if (reconstruction.legacyPromiseReleases.some((release) => !capturedLevelIds.has(release.inventoryLevelId))) {
    throw Object.assign(new Error("The claim snapshot does not contain every reviewed promise position."), {
      code: "CUTOVER_LEGACY_PROMISE_PROJECTION_CHANGED" });
  }
  if (reconstruction.legacyPromiseReleases.length > 0) {
    const { snapshotFingerprint: _beforeRelease, ...content } = snapshot;
    snapshot = sealClaimSupplySnapshot({ ...content,
      inventoryPositions: projectCutoverPromiseReservations(snapshot.inventoryPositions, reconstruction.legacyPromiseReleases) });
  }
  // Validate the promise against raw counters first. V2 then replaces those
  // counters with independently observed physical stock, without a second release.
  snapshot = projectVerifiedOpeningClaimSupply(snapshot, opening);
  const orders: PlannedCutoverOrder[] = [];
  const additional = new Map<number, bigint>();
  for (const order of [...reconstruction.orders].sort((a, b) => a.orderId - b.orderId)) {
    const request = claimPlanRequestSchema.parse({ requestKey: `cutover:${reconstruction.evidenceHash}:order:${order.orderId}`,
      scope: { kind: "warehouse", warehouseId: order.warehouseId }, lines: order.lines.map((line) => ({
        lineKey: `order-item:${line.orderItemId}`, targetVariantId: line.targetVariantId, requestedQty: line.requestedQty })) });
    const freshLines = order.lines.filter((line) => BigInt(line.freshDemandQty) > BigInt(0)).map((line) => ({
      lineKey: `order-item:${line.orderItemId}`, targetVariantId: line.targetVariantId, requestedQty: line.freshDemandQty }));
    const freshPlan = freshLines.length === 0 ? null : planCanonicalClaim(snapshot, { ...request, lines: freshLines });
    if (freshPlan?.status === "blocked") throw Object.assign(new Error("Canonical planner blocked cutover demand."), {
      code: "CUTOVER_FRESH_DEMAND_BLOCKED", context: { orderId: order.orderId, blockers: freshPlan.blockers } });
    const resourceClaims = (freshPlan?.resourceClaims ?? []).map((resource) => ({ ...resource }));
    for (const line of order.lines) for (const allocation of line.allocations) {
      const quantity = BigInt(allocation.reservedQty) + BigInt(allocation.pickedQty);
      if (quantity === BigInt(0)) continue;
      const existing = resourceClaims.find((resource) => resource.lineKey === `order-item:${line.orderItemId}`
        && resource.consumerOperationKey === null && resource.inventoryLevelId === allocation.inventoryLevelId);
      if (existing) existing.claimedQty = (BigInt(existing.claimedQty) + quantity).toString();
      else resourceClaims.push({ lineKey: `order-item:${line.orderItemId}`, consumerOperationKey: null,
        warehouseId: allocation.warehouseId, warehouseLocationId: allocation.warehouseLocationId,
        inventoryLevelId: allocation.inventoryLevelId, sourceVariantId: allocation.productVariantId, claimedQty: quantity.toString() });
    }
    const plannedLines = order.lines.map((line) => {
      const fresh = freshPlan?.lines.find((row) => row.lineKey === `order-item:${line.orderItemId}`);
      const plannedQty = BigInt(line.reservedQty) + BigInt(line.pickedQty) + BigInt(fresh?.plannedQty ?? "0");
      return { lineKey: `order-item:${line.orderItemId}`, targetVariantId: line.targetVariantId,
        requestedQty: line.requestedQty, plannedQty: plannedQty.toString(), shortfallQty: (BigInt(line.requestedQty) - plannedQty).toString() };
    });
    const plan = claimPlanSchema.parse({ requestKey: request.requestKey, scope: request.scope,
      status: plannedLines.some((line) => BigInt(line.shortfallQty) > BigInt(0)) ? "partial" : "satisfied", lines: plannedLines,
      resourceClaims, operations: freshPlan?.operations ?? [], blockers: [], snapshotFingerprint: snapshot.snapshotFingerprint,
      modelEvidence: snapshot.transformationModels.map((model) => ({ productId: model.productId, modelId: model.modelId,
        version: model.version, definitionHash: model.definitionHash, lifecycleSelection: model.lifecycleSelection })),
      fulfillmentGroups: plannedLines.some((line) => BigInt(line.plannedQty) > BigInt(0)) ? [{ groupKey: `warehouse:${order.warehouseId}`,
        warehouseId: order.warehouseId, lineAllocations: plannedLines.filter((line) => BigInt(line.plannedQty) > BigInt(0)).map((line) => ({
          lineKey: line.lineKey, targetVariantId: line.targetVariantId, plannedQty: line.plannedQty })) }] : [] });
    orders.push({ order, request, plan, freshPlan });
    const batch = new Map<number, bigint>();
    for (const resource of freshPlan?.resourceClaims ?? []) {
      batch.set(resource.inventoryLevelId, (batch.get(resource.inventoryLevelId) ?? BigInt(0)) + BigInt(resource.claimedQty));
      additional.set(resource.inventoryLevelId, (additional.get(resource.inventoryLevelId) ?? BigInt(0)) + BigInt(resource.claimedQty));
    }
    const inventoryPositions = snapshot.inventoryPositions.map((position) => ({ ...position,
      reservedQty: (BigInt(position.reservedQty) + (batch.get(position.inventoryLevelId) ?? BigInt(0))).toString() }));
    const { snapshotFingerprint: _oldFingerprint, ...content } = snapshot;
    snapshot = sealClaimSupplySnapshot({ ...content, inventoryPositions });
  }
  const freshReservationsByLevel = [...additional].sort(([a], [b]) => a - b).map(([inventoryLevelId, qty]) => ({ inventoryLevelId, reservedQty: qty.toString() }));
  // Definition IDs/hashes and resulting quantities are review evidence; capture
  // time and draft-to-active lifecycle labels change during the approved commit.
  const impactHash = reconstructionHash({ evidenceHash: reconstruction.evidenceHash, freshReservationsByLevel,
    // Keep old no-handoff impact payloads stable for already reviewed evidence.
    ...(reconstruction.legacyPromiseReleases.length > 0 ? { legacyPromiseReleases: reconstruction.legacyPromiseReleases } : {}),
    orders: orders.map(({ order, plan }) => ({ orderId: order.orderId, lines: plan.lines,
      resourceClaims: plan.resourceClaims, operations: plan.operations,
      modelEvidence: plan.modelEvidence.map(({ lifecycleSelection: _selection, ...definition }) => definition) })) });
  return { orders, freshReservationsByLevel, impactHash, inventoryPositions: snapshot.inventoryPositions };
}
