import { canonicalJson } from "@shared/utils/canonical-json";
import { openingAssessmentSchema, openingVerificationSchema, requiredOpeningItems,
  type OpeningAssessment, type OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { cutoverReconstructionEvidenceSchema, type CutoverReconstructionEvidence, type CutoverReconstructionPlan,
  type CutoverReconstructionAllocation, type CutoverReconstructionBlocker } from "@shared/types/inventory-cutover-reconstruction";
import { planCutoverReconstruction, reconstructionHash } from "./inventory-cutover-reconstruction";

/** Order-independent verification identity. Never mutate an uploaded observation. */
export function normalizeOpeningVerification(input: OpeningVerification): OpeningVerification {
  const verification = openingVerificationSchema.parse(input);
  return { ...verification, levels: [...verification.levels].sort((a,b) => a.id-b.id),
    lots: [...verification.lots].sort((a,b) => a.id-b.id),
    owners: verification.owners.map(owner => ({ ...owner, allocations: owner.allocations.map(allocation => ({ ...allocation,
      lots: allocation.lots.map(lot => ({ ...lot, originalCostIds: [...lot.originalCostIds].sort((a,b) => a-b) }))
        .sort((a,b) => a.inventoryLotId-b.inventoryLotId) })).sort((a,b) => a.inventoryLevelId-b.inventoryLevelId) }))
      .sort((a,b) => a.orderItemId-b.orderItemId) };
}

/**
 * A new, independently verified current-custody basis, NOT repaired history.
 * Physical counters and valuation must already match. The only counter handoff
 * allowed is a complete nonphysical promise already proven by raw journals;
 * verification itself never writes stock or releases those promises.
 */
export function evaluateCutoverOpening(rawEvidence: unknown, input: OpeningVerification): OpeningAssessment {
  const evidence = cutoverReconstructionEvidenceSchema.parse(rawEvidence);
  const verification = normalizeOpeningVerification(input);
  // The strict planner returns the canonical hash of the exact validated census.
  // Reuse it rather than parsing and sorting another complete copy for hashing.
  const strict = planCutoverReconstruction(evidence);
  // Reuse the original journal-backed proof, never infer a promise from a
  // counter discrepancy or from uploaded verification alone. These actions are
  // executed only by the inventory owner during the final atomic handoff.
  const promiseReleases = strict.legacyPromiseReleases;
  const promisesByLevel = new Map(promiseReleases.map(release => [release.inventoryLevelId, release]));
  const promiseOwners = new Map(promiseReleases.flatMap(release => release.owners.map(owner => [owner.orderItemId, owner] as const)));
  const sourceEvidenceHash = strict.evidenceHash;
  const verificationHash = reconstructionHash(verification);
  const blockers: CutoverReconstructionBlocker[] = [];
  const block = (code: string, subject: string, message: string) => blockers.push({ code, subject, message });
  const finish = (plan: CutoverReconstructionPlan): OpeningAssessment => {
    const unique = [...new Map([...blockers, ...plan.blockers].map(row => [`${row.code}:${row.subject}`, row])).values()]
      .sort((a,b) => compare(`${a.subject}:${a.code}`, `${b.subject}:${b.code}`));
    const retainedKeys = new Set(unique.map(row => `${row.code}:${row.subject}`));
    // Keep every displaced historical finding as an unresolved exception, covered
    // by the immutable snapshot. Displacement is NOT a repair/closure decision.
    const historicalExceptions = strict.blockers.filter(row => !retainedKeys.has(`${row.code}:${row.subject}`));
    const historicalExceptionHash = reconstructionHash(historicalExceptions);
    const provenance = { sourceEvidenceHash, verificationHash, historicalExceptionHash,
      historicalExceptionCount: historicalExceptions.length };
    const result: CutoverReconstructionPlan = { ...plan, evidenceHash: reconstructionHash({
      contractVersion: "inventory_cutover_opening_v1", ...provenance }),
      ready: unique.length === 0, blockers: unique,
      legacyPromiseReleases: unique.length === 0 ? promiseReleases : [], openingBalance: provenance };
    // No blocked partial adoption is consumable by the claim planner.
    if (!result.ready) result.orders = [];
    return openingAssessmentSchema.parse({ sourceEvidenceHash, verificationHash, ready: result.ready,
      blockers: unique, historicalExceptions, historicalExceptionHash, plan: result });
  };
  if (verification.expectedEvidenceHash !== sourceEvidenceHash) block("OPENING_SOURCE_CHANGED", "snapshot", "Stock, orders or historical evidence changed. Capture and independently verify the complete current snapshot again.");
  for (const [kind, rows] of Object.entries({ order: evidence.orders, item: evidence.items, level: evidence.levels, lot: evidence.lots, cost: evidence.costs })) {
    if (new Set(rows.map(row => row.id)).size !== rows.length) block("OPENING_DUPLICATE_SOURCE", kind, "A source identity occurs more than once; no opening allocation can be established.");
  }
  const sameRows = (left: readonly { id: number }[], right: readonly { id: number }[]) =>
    canonicalJson([...left].sort((a,b) => a.id-b.id)) === canonicalJson([...right].sort((a,b) => a.id-b.id));
  if (!sameRows(verification.levels, evidence.levels)) block("OPENING_LEVEL_VERIFICATION_MISMATCH", "levels", "Independent verification must cover every exact current level and counter. Correct discrepancies through the inventory owner first.");
  if (!sameRows(verification.lots, evidence.lots)) block("OPENING_LOT_VERIFICATION_MISMATCH", "lots", "Independent verification must cover every exact lot quantity and cost component; no missing lot or new valuation is inferred.");
  const required = requiredOpeningItems(evidence);
  if (new Set(verification.owners.map(owner => owner.orderItemId)).size !== verification.owners.length
    || canonicalJson(verification.owners.map(owner => owner.orderItemId)) !== canonicalJson(required.map(item => item.id))) {
    block("OPENING_OWNER_COVERAGE_MISMATCH", "owners", "Every current physical order line requires exactly one explicit verification, including unstarted demand and zero remaining quantity.");
  }
  if (blockers.length > 0) return finish(strict);
  const levels = new Map(evidence.levels.map(row => [row.id,row]));
  const lots = new Map(evidence.lots.map(row => [row.id,row]));
  const costs = new Map(evidence.costs.map(row => [row.id,row]));
  const items = new Map(required.map(row => [row.id,row]));
  const orders = new Map(evidence.orders.map(row => [row.id,row]));
  const owners = new Map(verification.owners.map(row => [row.orderItemId,row]));
  const selectedCosts = new Set<number>();
  const reservedByLot = new Map<number,bigint>();
  const pickedByLot = new Map<number,bigint>();
  const allocationsByItem = new Map<number,CutoverReconstructionAllocation[]>();
  const observations: CutoverReconstructionEvidence["journals"] = [];
  const add = (map: Map<number,bigint>, key: number, qty: string) => map.set(key, (map.get(key) ?? BigInt(0))+BigInt(qty));
  for (const level of evidence.levels) {
    const physicalReserved = BigInt(level.reservedQty) - BigInt(promisesByLevel.get(level.id)?.reservedQty ?? "0");
    if (physicalReserved < BigInt(0) || physicalReserved > BigInt(level.variantQty)
      || BigInt(level.variantQty) < BigInt(0) || BigInt(level.pickedQty) < BigInt(0) || BigInt(level.packedQty) !== BigInt(0)) {
      block("OPENING_CURRENT_BALANCE_INVALID", `level:${level.id}`, "Current physical counters must be valid. Only an exact journal-proven empty-bin promise can transfer as unfilled demand; other discrepancies and packed custody still require a supported handoff.");
    }
  }
  for (const owner of verification.owners) {
    const item = items.get(owner.orderItemId)!;
    const subject = `order-item:${item.id}`;
    const order = orders.get(item.orderId);
    const remaining = BigInt(item.quantity)-BigInt(item.fulfilledQuantity);
    const promise = promiseOwners.get(item.id);
    if (promise && (owner.orderId !== promise.orderId || owner.remainingQty !== promise.reservedQty
      || owner.reservedQty !== "0" || owner.pickedQty !== "0" || owner.allocations.length !== 0)) {
      block("OPENING_PROMISE_OWNER_MISMATCH", subject,
        "A proven unfilled promise must remain the exact full outstanding order quantity with no physical reserved/picked allocation. It cannot be relabeled as existing stock custody.");
    }
    // WMS progress is cumulative. Independent current picked observations must
    // agree with the unfulfilled portion; they never recreate dispatched units.
    const recordedCurrentPicked = BigInt(item.pickedQuantity)-BigInt(item.fulfilledQuantity);
    // The canonical picker compares owned picked custody to cumulative WMS
    // progress. It has no historical-fulfillment baseline contract; accepting
    // only the remaining units here would pass adoption but fail the next pick.
    if (item.fulfilledQuantity > 0 && remaining > BigInt(0)) {
      block("OPENING_PARTIAL_FULFILLMENT_RUNTIME_UNSUPPORTED", subject,
        "This line is partly fulfilled. Its remaining custody requires an explicit runtime handoff before cutover; opening verification cannot reset cumulative WMS progress.");
    }
    if (owner.orderId !== item.orderId || !order || remaining < BigInt(0)
      || item.quantity < 0 || item.pickedQuantity < 0 || item.fulfilledQuantity < 0 || item.pickedQuantity > item.quantity
      || recordedCurrentPicked < BigInt(0)
      || BigInt(owner.remainingQty) !== remaining || BigInt(owner.pickedQty) !== recordedCurrentPicked
      || BigInt(owner.reservedQty)+BigInt(owner.pickedQty) > remaining) {
      block("OPENING_CURRENT_DEMAND_MISMATCH", subject, "Verified custody must match the exact current order, remaining accepted quantity and unfulfilled picked progress. Fulfilled units exceeding cumulative picked progress require an owner correction before runtime adoption.");
    }
    const allocations: CutoverReconstructionAllocation[] = [];
    allocationsByItem.set(item.id, allocations);
    const locationIds = new Set<number>();
    let reserved = BigInt(0), picked = BigInt(0);
    for (const allocation of owner.allocations) {
      const level = levels.get(allocation.inventoryLevelId);
      if (!level || level.warehouseId === null || level.warehouseId !== order?.warehouseId || locationIds.has(level.id)) {
        block("OPENING_ALLOCATION_LEVEL_INVALID", subject, "Each allocation must identify one distinct level in the order's exact warehouse."); continue;
      }
      locationIds.add(level.id);
      const target: CutoverReconstructionAllocation = { inventoryLevelId: level.id, warehouseId: level.warehouseId,
        warehouseLocationId: level.warehouseLocationId, productVariantId: level.productVariantId, reservedQty: "0", pickedQty: "0", lots: [] };
      const assignedLotIds = new Set<number>();
      for (const allocationLot of allocation.lots) {
        const lot = lots.get(allocationLot.inventoryLotId);
        if (!lot || lot.warehouseLocationId !== level.warehouseLocationId || lot.productVariantId !== level.productVariantId
          || assignedLotIds.has(lot.id) || BigInt(allocationLot.reservedQty)+BigInt(allocationLot.pickedQty) === BigInt(0)) {
          block("OPENING_ALLOCATION_LOT_INVALID", subject, "Each positive lot allocation must belong to the exact level and variant, once per owner."); continue;
        }
        assignedLotIds.add(lot.id);
        const originalCosts: CutoverReconstructionEvidence["costs"] = [];
        for (const costId of allocationLot.originalCostIds) {
          const cost = costs.get(costId);
          if (!cost || selectedCosts.has(costId) || cost.orderId !== owner.orderId || cost.orderItemId !== item.id
            || cost.inventoryLotId !== lot.id || cost.productVariantId !== lot.productVariantId
            || BigInt(cost.quantity) <= BigInt(0) || BigInt(cost.unitCostMills) < BigInt(0)
            || BigInt(cost.totalCostMills) !== BigInt(cost.quantity)*BigInt(cost.unitCostMills)) {
            block("OPENING_PICK_COST_INVALID", `cost:${costId}`, "Current picked stock requires distinct existing original order/item/lot cost rows with exact quantities and amounts."); continue;
          }
          selectedCosts.add(costId); originalCosts.push(cost);
        }
        if (originalCosts.reduce((total,cost) => total+BigInt(cost.quantity),BigInt(0)) !== BigInt(allocationLot.pickedQty)) {
          block("OPENING_PICK_COST_MISMATCH", subject, "Original cost quantities must exactly cover the independently verified currently picked units. Historical costs cannot be invented or split here.");
        }
        add(reservedByLot, lot.id, allocationLot.reservedQty); add(pickedByLot, lot.id, allocationLot.pickedQty);
        target.reservedQty = (BigInt(target.reservedQty)+BigInt(allocationLot.reservedQty)).toString();
        target.pickedQty = (BigInt(target.pickedQty)+BigInt(allocationLot.pickedQty)).toString();
        target.lots.push({ inventoryLotId: lot.id, reservedQty: allocationLot.reservedQty, pickedQty: allocationLot.pickedQty,
          cost: lot, originalCosts });
      }
      if (target.lots.length === 0) block("OPENING_EMPTY_ALLOCATION", subject, "An allocation must contain verified current custody; unstarted demand uses no allocation rows.");
      reserved += BigInt(target.reservedQty); picked += BigInt(target.pickedQty); allocations.push(target);
      // These are in-memory opening observations, NOT synthetic historical DB
      // journal rows. Their explicit provenance is persisted with the snapshot.
      observations.push({ orderId: owner.orderId, orderItemId: item.id, productVariantId: level.productVariantId,
        warehouseLocationId: level.warehouseLocationId, reservedQty: target.reservedQty, pickedQty: target.pickedQty,
        shippedQty: "0", unknownCount: "0", journalCount: "1", journalHash: reconstructionHash({ verificationHash, target, orderItemId: item.id }) });
    }
    if (reserved !== BigInt(owner.reservedQty) || picked !== BigInt(owner.pickedQty)) block("OPENING_OWNER_ALLOCATION_MISMATCH", subject, "Exact level/lot assignments must exhaust the owner's verified reserved and picked quantities.");
  }
  // Preserve independent build reservations; never count them as customer holds
  // or release them because a new customer opening basis is being established.
  for (const build of evidence.buildReservations) if (build.reservationOwner === "build_order") {
    add(reservedByLot, build.inventoryLotId, (BigInt(build.reservedQty)-BigInt(build.consumedQty)-BigInt(build.releasedQty)).toString());
  }
  for (const lot of evidence.lots) if ((reservedByLot.get(lot.id) ?? BigInt(0)) !== BigInt(lot.reservedQty)
    || (pickedByLot.get(lot.id) ?? BigInt(0)) !== BigInt(lot.pickedQty)) {
    block("OPENING_LOT_OWNERSHIP_INCOMPLETE", `lot:${lot.id}`, "Verified customer and independent-build ownership must exhaust every recorded reserved/picked lot unit without excess.");
  }
  if (blockers.length > 0) return finish(strict);
  const projected: CutoverReconstructionEvidence = { ...evidence,
    // Verification above still matches the complete RAW level counters. This
    // projection only removes proven nonphysical promises for planning; on-hand,
    // picked, packed, lot quantities and valuation remain exactly as captured.
    levels: evidence.levels.map(level => promisesByLevel.has(level.id) ? { ...level, reservedQty: "0" } : level),
    journals: observations,
    items: evidence.items.map(item => { const owner = owners.get(item.id); return owner ? { ...item,
      quantity: Number(owner.remainingQty), pickedQuantity: Number(owner.pickedQty), fulfilledQuantity: 0 } : item; }),
    costs: evidence.costs.filter(cost => selectedCosts.has(cost.id)),
    // Full accepted-OMS coverage is checked on ORIGINAL quantities below. The
    // opening projection contains remaining quantities and must not recheck them
    // as if they were the original commercial authorization.
    acceptedOmsDemand: [],
    // Only records with explicit closed/ignored lifecycle are historical here.
    // Pending/review/failed work and live physical packages still block normally.
    sourceItems: evidence.sourceItems.filter(source => source.shipmentStatus !== "shipped"),
    physicalItems: evidence.physicalItems.filter(item => item.packageStatus !== "shipped"),
    shipmentReviewEvidence: evidence.shipmentReviewEvidence.filter(review => !(
      ((review.kind === "channel_fulfillment_acknowledgment" || review.kind === "channel_fulfillment_receipt") && review.status === "ignored")
      || (review.kind === "outbound_shipment_review" && review.status === "shipped"))),
  };
  // A fully fulfilled line has no projected claim owner. Existing package
  // checks are owner-dependent, so explicitly retain unfinished work on these
  // zero-demand lines instead of losing it when the claim line disappears.
  const exhaustedItems = new Set(verification.owners.filter(owner => owner.remainingQty === "0").map(owner => owner.orderItemId));
  for (const source of projected.sourceItems) if (source.orderItemId !== null && exhaustedItems.has(source.orderItemId)) {
    block("OPENING_ZERO_REMAINING_PACKAGE_REQUIRES_REVIEW", `source:${source.id}`,
      "A line with no remaining demand still has unshipped source work. Resolve its lifecycle before cutover; no claim owner can be inferred.");
  }
  for (const physical of projected.physicalItems) if (physical.orderItemId !== null && exhaustedItems.has(physical.orderItemId)) {
    block("OPENING_ZERO_REMAINING_PACKAGE_REQUIRES_REVIEW", `physical:${physical.id}`,
      "A line with no remaining demand still has non-shipped physical package evidence. Resolve its lifecycle before cutover.");
  }
  blockers.push(...strict.blockers.filter(row => ["OMS_ACCEPTED_DEMAND_NOT_COVERED", "DUPLICATE_IDENTITY",
    "DUPLICATE_INVENTORY_POSITION", "EXISTING_CANONICAL_LINEAGE_REQUIRES_REVIEW"].includes(row.code)));
  const planned = planCutoverReconstruction(projected);
  // This particular ambiguity is resolved by the independently verified,
  // exhaustive explicit lot-owner assignments above, never an arbitrary FIFO.
  planned.blockers = planned.blockers.filter(row => row.code !== "RESERVED_LOT_OWNERSHIP_AMBIGUOUS");
  for (const order of planned.orders) for (const line of order.lines) line.allocations = allocationsByItem.get(line.orderItemId) ?? [];
  if (planned.legacyPromiseReleases.length > 0) block("OPENING_COUNTER_RELEASE_FORBIDDEN", "levels", "Independent opening observations cannot authorize a new counter release; only the original journal-proven promise handoff is allowed.");
  return finish(planned);
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
