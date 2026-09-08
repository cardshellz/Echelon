import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { cutoverReconstructionEvidenceSchema, type CutoverReconstructionEvidence,
  type CutoverReconstructionPlan, type CutoverReconstructionLine,
  type CutoverReconstructionAllocation } from "@shared/types/inventory-cutover-reconstruction";

export function reconstructionHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Stable census: time of capture and database row delivery order are not business evidence. */
function sortedEvidence(raw: CutoverReconstructionEvidence): CutoverReconstructionEvidence {
  const evidence = cutoverReconstructionEvidenceSchema.parse(raw);
  const sorted = Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key,
    Array.isArray(value) ? value.map((row) => ({ row, key: canonicalJson(row) }))
      .sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({ row }) => row) : value]));
  return cutoverReconstructionEvidenceSchema.parse(sorted);
}
export function reconstructionEvidenceHash(raw: CutoverReconstructionEvidence): string {
  return reconstructionHash(sortedEvidence(raw));
}
function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const row of rows) { const identity = key(row); const group = result.get(identity) ?? []; group.push(row); result.set(identity,group); }
  return result;
}

/**
 * Adoption is a proof of CURRENT ownership, not a historical FIFO guess. Multiple
 * orders over multiple unowned reserved lots have multiple valid assignments and
 * therefore require review. Picked custody additionally requires exact extant
 * order/lot COGS and a matching signed physical journal at that same location.
 */
export function planCutoverReconstruction(raw: CutoverReconstructionEvidence): CutoverReconstructionPlan {
  const evidence = sortedEvidence(raw);
  const result: CutoverReconstructionPlan = { evidenceHash: reconstructionEvidenceHash(evidence), ready: false,
    blockers: [], orders: [], retainedIndependentBuildReservationIds: [] };
  const block = (code: string, subject: string, message: string) => result.blockers.push({ code, subject, message });
  const sum = (values: readonly string[]) => values.reduce((total, value) => total + BigInt(value), BigInt(0));
  const levels = new Map(evidence.levels.map((row) => [row.id, row]));
  const lots = new Map(evidence.lots.map((row) => [row.id, row]));
  const orders = new Map(evidence.orders.map((row) => [row.id, row]));
  const items = new Map(evidence.items.map((row) => [row.id, row]));
  const journalsByItem = groupBy(evidence.journals,(row) => row.orderItemId);
  const variantsBySku = groupBy(evidence.variants.filter((row) => row.isActive),(row) => row.sku.toUpperCase());
  const costsByItem = groupBy(evidence.costs,(row) => row.orderItemId);
  const itemsByOmsLine = groupBy(evidence.items,(row) => row.omsOrderLineId);
  const positionKey = (locationId: number | null, variantId: number | null) => `${locationId}:${variantId}`;
  const levelsByPosition = groupBy(evidence.levels,(row) => positionKey(row.warehouseLocationId,row.productVariantId));
  const lotsByPosition = groupBy(evidence.lots,(row) => positionKey(row.warehouseLocationId,row.productVariantId));
  const plannedOrders = new Map<number,CutoverReconstructionPlan["orders"][number]>();
  const retainedByLot = new Map<number, bigint>();
  const lines = new Map<number, CutoverReconstructionLine>();
  const allocatedPicked = new Map<number, bigint>();
  const allocatedCostIds = new Set<number>();
  const add = (map: Map<number, bigint>, key: number, quantity: bigint) => map.set(key, (map.get(key) ?? BigInt(0)) + quantity);
  for (const collection of [evidence.orders, evidence.items, evidence.levels, evidence.lots, evidence.costs]) {
    if (new Set(collection.map((row) => row.id)).size !== collection.length) block("DUPLICATE_IDENTITY", "census", "Owner census contains duplicate primary identities.");
  }
  for (const [position, grouped] of levelsByPosition) if (grouped.length !== 1) {
    block("DUPLICATE_INVENTORY_POSITION", position, "One warehouse location/SKU must identify exactly one level.");
  }
  const journalOwners = groupBy(evidence.journals,(row) => `${row.orderId}:${row.orderItemId}:${positionKey(row.warehouseLocationId,row.productVariantId)}`);
  for (const [owner, grouped] of journalOwners) if (grouped.length !== 1) {
    block("DUPLICATE_JOURNAL_OWNER_GROUP", owner, "Raw journal owner groups must be unique; do not overwrite or net duplicate groups.");
  }
  if (BigInt(evidence.canonicalClaimCount) !== BigInt(0) || evidence.canonicalResources.length !== 0) {
    block("EXISTING_CANONICAL_LINEAGE_REQUIRES_REVIEW", "canonical_claims", "First cutover cannot reinterpret or double-adopt existing canonical claims.");
  }
  for (const reservation of evidence.buildReservations) {
    const subject = `build-reservation:${reservation.reservationId}`;
    const open = BigInt(reservation.reservedQty) - BigInt(reservation.consumedQty) - BigInt(reservation.releasedQty);
    const lot = lots.get(reservation.inventoryLotId);
    const lotLevels = lot ? levelsByPosition.get(positionKey(lot.warehouseLocationId,lot.productVariantId)) ?? [] : [];
    if (open < BigInt(0) || !lot || reservation.buildOrderId == null || reservation.warehouseId == null
      || lot.productVariantId !== reservation.componentVariantId || lot.warehouseLocationId !== reservation.sourceLocationId
      || lotLevels.length !== 1 || lotLevels[0].warehouseId !== reservation.warehouseId) {
      block("BUILD_HOLD_IDENTITY_INVALID", subject, "Outstanding build hold lacks a matching exact component/warehouse/lot owner."); continue;
    }
    if (reservation.reservationOwner === "availability_claim") {
      // It is a projection of a claim allocation, NEVER a second independent hold.
      if (reservation.claimLotInventoryLotId !== lot.id || reservation.claimLotOpenQty == null
        || BigInt(reservation.claimLotOpenQty) !== open) block("BUILD_CLAIM_OVERLAP_INVALID", subject, "Claim-owned build reservation does not reconcile to its exact claim allocation.");
      continue;
    }
    if (reservation.reservationOwner !== "build_order" || reservation.availabilityClaimId !== null
      || reservation.availabilityClaimLotAllocationId !== null) {
      block("BUILD_HOLD_OWNER_UNKNOWN", subject, "Build reservation ownership is neither independent nor a proven claim projection."); continue;
    }
    add(retainedByLot, lot.id, open);
    result.retainedIndependentBuildReservationIds.push(reservation.reservationId);
    if (["completed", "cancelled", "failed"].includes(reservation.buildOrderStatus ?? "")) {
      block("TERMINAL_BUILD_HOLD_REQUIRES_REVIEW", subject, "Terminal build retains exact component stock; retain it and resolve its lifecycle before activation.");
    } else if (!["draft","released","in_progress"].includes(reservation.buildOrderStatus ?? "")) {
      block("BUILD_HOLD_LIFECYCLE_UNKNOWN", subject, "Independent component hold has an unknown build lifecycle.");
    }
  }
  for (const demand of evidence.acceptedOmsDemand) {
    const materialized = itemsByOmsLine.get(demand.lineId) ?? [];
    const actual = materialized.reduce((total,item) => total + BigInt(item.quantity),BigInt(0));
    if (demand.authorizationStatus !== "authorized" || BigInt(demand.authorizedQty) <= BigInt(0)
      || BigInt(demand.materializedQty) !== actual || BigInt(demand.authorizedQty) !== actual
      || materialized.some((item) => demand.sku === null || item.sku.toUpperCase() !== demand.sku.toUpperCase()
        || (demand.productVariantId !== null && !evidence.variants.some((variant) => variant.id === demand.productVariantId && variant.sku.toUpperCase() === item.sku.toUpperCase())))) {
      block("OMS_ACCEPTED_DEMAND_NOT_COVERED", `oms-line:${demand.lineId}`, "Accepted physical OMS demand is not exactly covered by captured WMS demand; missing/external projection needs explicit owner reconciliation.");
    }
  }
  for (const review of evidence.shipmentReviewEvidence) block("SHIPMENT_RECEIPT_REQUIRES_REVIEW", `${review.kind}:${review.id}`,
    "Pending, ignored or review shipment authority evidence must be resolved before inventory authority changes.");
  for (const demand of evidence.buildDemands) {
    if (["planning", "awaiting_build"].includes(demand.status)) block("LEGACY_BUILD_DEMAND_REQUIRES_HANDOFF", `build-demand:${demand.id}`,
      "Existing build promise needs an explicit canonical operation handoff; its independent component holds cannot be freed or promised again.");
  }
  for (const item of evidence.items) {
    const subject = `order-item:${item.id}`;
    const order = orders.get(item.orderId);
    const journals = journalsByItem.get(item.id) ?? [];
    const reservation = sum(journals.map((row) => row.reservedQty));
    const picked = sum(journals.map((row) => row.pickedQty));
    const residual = reservation !== BigInt(0) || picked !== BigInt(0);
    if (!order) { block("DEMAND_OWNER_MISSING", subject, "Demand has no owning WMS order."); continue; }
    const terminal = ["shipped", "cancelled"].includes(order.status ?? "");
    if (terminal) {
      if (residual) block("TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW", subject, "Terminal order still owns signed reservation or picked custody. It is not free supply.");
      continue;
    }
    if (item.quantity < 0 || item.pickedQuantity < 0 || item.fulfilledQuantity < 0
      || item.pickedQuantity > item.quantity || item.fulfilledQuantity > item.quantity) {
      block("DEMAND_QUANTITY_INVALID", subject, "Order progress quantities are inconsistent."); continue;
    }
    const variants = variantsBySku.get(item.sku.toUpperCase()) ?? [];
    if (item.requiresShipping === 0) {
      if (residual) block("NONINVENTORY_ITEM_ENCUMBERED", subject, "Non-shipping line retains physical inventory evidence.");
      continue;
    }
    if (item.requiresShipping !== 1 || variants.length !== 1) { block("DEMAND_VARIANT_AMBIGUOUS", subject, "Physical SKU must resolve to exactly one active variant."); continue; }
    const variant = variants[0];
    if (!variant.requiresShipping || !variant.trackInventory) {
      if (residual) block("NONINVENTORY_ITEM_ENCUMBERED", subject, "Untracked/digital variant retains physical inventory evidence.");
      continue;
    }
    if (variant.salesEligibility !== "sellable" || (item.productId !== null && item.productId !== variant.id && item.productId !== variant.productId)
      || order.warehouseId === null) { block("DEMAND_IDENTITY_INVALID", subject, "Demand variant/product or warehouse ownership cannot be established."); continue; }
    if (item.fulfilledQuantity !== 0 || journals.some((row) => BigInt(row.shippedQty) !== BigInt(0))) {
      block("PARTIAL_SHIPMENT_CUSTODY_REQUIRES_REVIEW", subject, "Legacy costs survive shipping; mixed shipped/unshipped lot custody requires explicit provenance."); continue;
    }
    if (reservation < BigInt(0) || picked < BigInt(0) || reservation + picked > BigInt(item.quantity) || picked !== BigInt(item.pickedQuantity)) {
      block("DEMAND_CUSTODY_BALANCE_MISMATCH", subject, "Exact journal custody and WMS progress do not reconcile without changing stock."); continue;
    }
    if (item.shortReason === "refund_after_pick") {
      block("REFUND_AFTER_PICK_CUSTODY_REQUIRES_REVIEW", subject, "Refund authority reduced accepted demand while historic picked quantity was preserved; never recreate refunded demand."); continue;
    }
    if (item.status === "cancelled" || (item.status === "completed" && item.pickedQuantity !== item.quantity)) {
      if (residual || item.quantity > item.fulfilledQuantity) block("TERMINAL_LINE_RESIDUAL_REQUIRES_REVIEW", subject, "Terminal line retains demand or custody.");
      continue;
    }
    if (item.quantity === 0) continue;
    const line: CutoverReconstructionLine = { orderItemId: item.id, targetVariantId: variant.id, productId: variant.productId,
      requestedQty: String(item.quantity), reservedQty: reservation.toString(), pickedQty: picked.toString(),
      freshDemandQty: (BigInt(item.quantity) - reservation - picked).toString(), allocations: [] };
    lines.set(item.id, line);
    let plannedOrder = plannedOrders.get(order.id);
    if (!plannedOrder) { plannedOrder = { orderId: order.id, warehouseId: order.warehouseId, lines: [] }; result.orders.push(plannedOrder); plannedOrders.set(order.id,plannedOrder); }
    plannedOrder.lines.push(line);
  }
  const allocationFor = (line: CutoverReconstructionLine, levelId: number): CutoverReconstructionAllocation | null => {
    const level = levels.get(levelId);
    if (!level || !level.warehouseId) return null;
    let allocation = line.allocations.find((row) => row.inventoryLevelId === levelId);
    if (!allocation) { allocation = { inventoryLevelId: level.id, warehouseId: level.warehouseId,
      warehouseLocationId: level.warehouseLocationId, productVariantId: level.productVariantId,
      reservedQty: "0", pickedQty: "0", lots: [] }; line.allocations.push(allocation); }
    return allocation;
  };
  const lotFor = (allocation: CutoverReconstructionAllocation, lotId: number) => {
    let allocationLot = allocation.lots.find((row) => row.inventoryLotId === lotId);
    if (!allocationLot) { allocationLot = { inventoryLotId: lotId, reservedQty: "0", pickedQty: "0", cost: lots.get(lotId)!, originalCosts: [] }; allocation.lots.push(allocationLot); }
    return allocationLot;
  };
  for (const journal of evidence.journals) {
    const subject = `journal:${journal.orderId}:${journal.orderItemId}:${journal.warehouseLocationId}:${journal.productVariantId}`;
    const item = journal.orderItemId == null ? undefined : items.get(journal.orderItemId);
    if (BigInt(journal.unknownCount) > BigInt(0) && (item !== undefined || BigInt(journal.reservedQty) !== BigInt(0) || BigInt(journal.pickedQty) !== BigInt(0))) {
      block("JOURNAL_CUSTODY_UNKNOWN", subject, "Missing quantity/state or mixed shipment custody cannot establish exact ownership.");
    }
    if (BigInt(journal.reservedQty) === BigInt(0) && BigInt(journal.pickedQty) === BigInt(0)) continue;
    const matched = levelsByPosition.get(positionKey(journal.warehouseLocationId,journal.productVariantId)) ?? [];
    if (!item || item.orderId !== journal.orderId || matched.length !== 1 || !lines.has(item.id)) {
      block("ENCUMBRANCE_OWNER_UNRESOLVED", subject, "Residual journal must belong to a captured, claimable order line and one exact level."); continue;
    }
    const line = lines.get(item.id)!;
    if (line.targetVariantId !== journal.productVariantId || orders.get(item.orderId)!.warehouseId !== matched[0].warehouseId) {
      block("ENCUMBRANCE_IDENTITY_CONFLICT", subject, "Residual journal belongs to a different SKU or warehouse than its demand."); continue;
    }
    const allocation = allocationFor(line, matched[0].id)!;
    allocation.reservedQty = journal.reservedQty;
    allocation.pickedQty = journal.pickedQty;
    if (BigInt(allocation.reservedQty) < BigInt(0) || BigInt(allocation.pickedQty) < BigInt(0)) block("NEGATIVE_OWNER_BALANCE", subject, "Signed owner balance is negative; do not net it against another owner/location.");
    const costs = (costsByItem.get(item.id) ?? []).filter((cost) => cost.orderId === item.orderId
      && lots.get(cost.inventoryLotId)?.warehouseLocationId === journal.warehouseLocationId);
    if (sum(costs.map((cost) => cost.quantity)) !== BigInt(journal.pickedQty)) block("PICK_COST_CUSTODY_MISMATCH", subject, "Original current COGS lots do not exactly equal outstanding picked custody.");
    for (const cost of costs) {
      const lot = lots.get(cost.inventoryLotId)!;
      if (cost.productVariantId !== line.targetVariantId || lot.productVariantId !== line.targetVariantId
        || BigInt(cost.quantity) <= BigInt(0) || BigInt(cost.unitCostMills) < BigInt(0)
        || BigInt(cost.totalCostMills) !== BigInt(cost.quantity) * BigInt(cost.unitCostMills)) {
        block("PICK_COST_IDENTITY_INVALID", `cost:${cost.id}`, "Original picked lot/cost evidence is malformed."); continue;
      }
      const allocationLot = lotFor(allocation, lot.id);
      allocationLot.pickedQty = (BigInt(allocationLot.pickedQty) + BigInt(cost.quantity)).toString();
      allocationLot.originalCosts.push(cost);
      allocatedCostIds.add(cost.id);
      add(allocatedPicked, lot.id, BigInt(cost.quantity));
    }
  }
  const allocationsByLevel = groupBy([...lines.values()].flatMap((line) => line.allocations),(row) => row.inventoryLevelId);
  for (const level of evidence.levels) {
    const subject = `level:${level.id}`;
    const levelLots = lotsByPosition.get(positionKey(level.warehouseLocationId,level.productVariantId)) ?? [];
    const allocations = allocationsByLevel.get(level.id) ?? [];
    const holdOwners = allocations.filter((row) => BigInt(row.reservedQty) > BigInt(0));
    const residualLots = levelLots.map((lot) => ({ lot, qty: BigInt(lot.reservedQty) - (retainedByLot.get(lot.id) ?? BigInt(0)) })).filter((row) => row.qty !== BigInt(0));
    const independentlyHeld = levelLots.reduce((total, lot) => total + (retainedByLot.get(lot.id) ?? BigInt(0)), BigInt(0));
    if ([level.variantQty, level.reservedQty, level.pickedQty, level.packedQty].some((qty) => BigInt(qty) < BigInt(0))
      || BigInt(level.reservedQty) > BigInt(level.variantQty)) block("LEVEL_BALANCE_INVALID", subject, "Physical/reserved counters are invalid.");
    if (BigInt(level.packedQty) !== BigInt(0)) block("PACKED_CUSTODY_UNATTRIBUTED", subject, "Legacy packed custody has no exact lot/owner lineage in this importer.");
    if (sum(levelLots.map((lot) => lot.onHandQty)) !== BigInt(level.variantQty)
      || sum(levelLots.map((lot) => lot.reservedQty)) !== BigInt(level.reservedQty)
      || sum(levelLots.map((lot) => lot.pickedQty)) !== BigInt(level.pickedQty)
      || sum(allocations.map((row) => row.reservedQty)) + independentlyHeld !== BigInt(level.reservedQty)
      || sum(allocations.map((row) => row.pickedQty)) !== BigInt(level.pickedQty)) {
      block("LEVEL_ENCUMBRANCE_UNEXPLAINED", subject, "Exact order/build ownership and lot counters must exhaust every reserved/picked unit without excess.");
    }
    if (holdOwners.length > 1 && residualLots.length > 1) { block("RESERVED_LOT_OWNERSHIP_AMBIGUOUS", subject, "Multiple order owners over multiple reserved lots have no persisted unique assignment."); continue; }
    if (residualLots.some((row) => row.qty < BigInt(0))) { block("BUILD_HOLD_EXCEEDS_LOT", subject, "Independent build ownership exceeds the lot reserved counter."); continue; }
    if (holdOwners.length === 1) {
      for (const { lot, qty } of residualLots) lotFor(holdOwners[0], lot.id).reservedQty = qty.toString();
    } else if (residualLots.length === 1) {
      for (const allocation of holdOwners) lotFor(allocation, residualLots[0].lot.id).reservedQty = allocation.reservedQty;
    }
  }
  for (const lot of evidence.lots) {
    if ([lot.onHandQty, lot.reservedQty, lot.pickedQty, lot.unitCostMills, lot.poUnitCostMills, lot.packagingUnitCostMills, lot.landedUnitCostMills].some((value) => BigInt(value) < BigInt(0))
      || BigInt(lot.reservedQty) > BigInt(lot.onHandQty)
      || BigInt(lot.unitCostMills) !== BigInt(lot.poUnitCostMills) + BigInt(lot.packagingUnitCostMills) + BigInt(lot.landedUnitCostMills)) {
      block("LOT_BALANCE_OR_COST_INVALID", `lot:${lot.id}`, "Exact lot quantities/cost components are invalid; never repair them during adoption.");
    }
    if ((BigInt(lot.reservedQty) !== BigInt(0) || BigInt(lot.pickedQty) !== BigInt(0))
      && !levelsByPosition.has(positionKey(lot.warehouseLocationId,lot.productVariantId))) {
      block("LOT_LEVEL_OWNER_MISSING", `lot:${lot.id}`, "Encumbered lot has no matching inventory level.");
    }
    if ((allocatedPicked.get(lot.id) ?? BigInt(0)) !== BigInt(lot.pickedQty)) block("LOT_PICKED_OWNER_UNEXPLAINED", `lot:${lot.id}`, "Picked lot units are not exactly exhausted by current original order cost ownership.");
  }
  for (const cost of evidence.costs) if (!allocatedCostIds.has(cost.id) && lines.has(cost.orderItemId)) {
    block("ORIGINAL_PICK_COST_UNATTRIBUTED", `cost:${cost.id}`, "Extant order COGS cannot be attributed to the exact outstanding picked level/lot.");
  }
  // Outbound review is an orthogonal flag, captured by the WMS owner census;
  // it is not a value in wms.shipment_status. Keep that evidence separate from
  // OMS receipt processing states and physical-package lifecycle states.
  const reviewedShipmentIds = new Set(evidence.shipmentReviewEvidence
    .filter((review) => review.kind === "outbound_shipment_review").map((review) => review.id));
  for (const source of evidence.sourceItems) {
    const item = source.orderItemId == null ? undefined : items.get(source.orderItemId);
    const hasResidual = source.orderItemId != null && lines.has(source.orderItemId);
    const requiresReview = reviewedShipmentIds.has(String(source.shipmentId));
    const cleanIntention = item && !requiresReview && source.headerOrderId === item.orderId && source.purpose === "customer_fulfillment"
      && source.quantity > 0 && ["planned", "queued", "labeled"].includes(source.shipmentStatus ?? "")
      && source.replacementForOrderItemId == null && source.correctionForShipmentItemId == null
      && source.productVariantId === lines.get(item.id)?.targetVariantId;
    if (cleanIntention && item && source.quantity > item.quantity) {
      block("SHIPMENT_SOURCE_EXCEEDS_DEMAND", `source:${source.id}`, "An unshipped source cannot exceed its accepted order line.");
    }
    if (cleanIntention && item && source.fromLocationId !== null && BigInt(lines.get(item.id)!.pickedQty) > BigInt(0)
      && !lines.get(item.id)!.allocations.some((allocation) => allocation.warehouseLocationId === source.fromLocationId && BigInt(allocation.pickedQty) > BigInt(0))) {
      block("SHIPMENT_SOURCE_PICKED_BIN_CONFLICT", `source:${source.id}`, "Persisted source bin does not match original picked custody; do not overwrite immutable shipment evidence at cutover.");
    }
    if (!cleanIntention && (hasResidual || !item || requiresReview)) {
      block("SHIPMENT_SOURCE_REQUIRES_REVIEW", `source:${source.id}`, "Shipment membership/status/purpose cannot be treated as an ordinary unshipped intention.");
    }
  }
  for (const physical of evidence.physicalItems) {
    if (physical.orderItemId === null || lines.has(physical.orderItemId)
      || physical.packageStatus === "review") {
      block("PHYSICAL_SHIPMENT_REQUIRES_REVIEW", `physical:${physical.id}`, "Physical shipment/adjustment evidence must be reconciled before adopting remaining picked custody.");
    }
  }
  result.orders.sort((a, b) => a.orderId - b.orderId);
  for (const order of result.orders) order.lines.sort((a, b) => a.orderItemId - b.orderItemId);
  result.retainedIndependentBuildReservationIds.sort((a, b) => a - b);
  result.blockers.sort((a, b) => a.subject.localeCompare(b.subject) || a.code.localeCompare(b.code));
  result.ready = result.blockers.length === 0;
  return result;
}
