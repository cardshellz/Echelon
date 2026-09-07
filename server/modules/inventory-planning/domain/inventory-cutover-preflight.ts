import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { WMS_WAREHOUSE_STATUS_VALUES } from "@shared/enums/order-status";
import { wmsCutoverDemandCaptureSchema, type WmsCutoverDemandCapture } from "@shared/types/inventory-cutover-demand";
import { inventoryCutoverEncumbranceSchema, type InventoryCutoverEncumbranceDto } from "@shared/types/inventory-cutover-encumbrance";
import {
  inventoryCutoverPreflightSchema, inventoryCutoverVariantSchema,
  type InventoryCutoverFinding, type InventoryCutoverLine,
  type InventoryCutoverPreflight, type InventoryCutoverVariant,
} from "@shared/types/inventory-cutover-preflight";

export interface InventoryCutoverPreflightFacts {
  capturedAt: string;
  runtimeAuthority: "legacy" | "canonical" | null;
  authorityRevision: string | null;
  demand: WmsCutoverDemandCapture;
  encumbrance: InventoryCutoverEncumbranceDto;
  variants: InventoryCutoverVariant[];
}

const NOT_EVALUATED = [
  "Joint whole-catalog claim reconstruction and transformation planning against reconciled owner holds.",
  "Exact picked/packed movement, lot and cost lineage, including retained custody on terminal orders.",
  "OMS demand not yet represented in WMS, dropship acceptance atomicity and order-ingestion watermarks.",
  "External/3PL custody, fulfillment and inventory observation completeness.",
  "Provider readback, final authority-switch concurrency and post-cutover publication.",
] as const;

type FindingIds = Partial<Pick<InventoryCutoverFinding, "orderId" | "orderItemId" | "inventoryLevelId">>;
type AddFinding = (code: string, message: string, ids?: FindingIds) => void;
type DemandIndexes = {
  orders: ReadonlyMap<number, WmsCutoverDemandCapture["orders"][number]>;
  itemsById: ReadonlyMap<number, WmsCutoverDemandCapture["items"][number]>;
  variantsBySku: ReadonlyMap<string, readonly InventoryCutoverVariant[]>;
};
type SourceReview = {
  physicalItemIds: ReadonlySet<number>;
  sourceItemIds: ReadonlySet<number>;
};

/** Read-only evidence classification. This never turns counters into claims or repairs inventory. */
export function buildInventoryCutoverPreflight(raw: InventoryCutoverPreflightFacts): InventoryCutoverPreflight {
  const facts = parseUniquePreflightFacts(raw);
  const findings: InventoryCutoverFinding[] = [];
  const add = createFindingRecorder(findings);
  if (facts.runtimeAuthority === null || facts.authorityRevision === null) {
    add("RUNTIME_AUTHORITY_MISSING", "The persisted inventory runtime authority is unavailable; no authority is assumed.");
  }
  if (facts.encumbrance.canonicalTablesStatus !== "captured") {
    add("CANONICAL_OWNER_TABLES_UNAVAILABLE", "Canonical resource ownership could not be captured; its absence is not assumed to mean zero holds.");
  }
  const indexes = indexDemandFacts(facts);
  const sources = reviewShipmentSources(facts.demand, indexes, add);
  const lines = classifyDemandLines(facts, indexes, sources, add);
  const inventoryLevels = reconcileInventoryOwners(facts.encumbrance, add);
  return assemblePreflightReport(facts, lines, inventoryLevels, findings);
}

function parseUniquePreflightFacts(raw: InventoryCutoverPreflightFacts): InventoryCutoverPreflightFacts {
  const facts: InventoryCutoverPreflightFacts = {
    ...raw,
    demand: wmsCutoverDemandCaptureSchema.parse(raw.demand),
    encumbrance: inventoryCutoverEncumbranceSchema.parse(raw.encumbrance),
    variants: raw.variants.map((variant) => inventoryCutoverVariantSchema.parse(variant)),
  };
  assertUnique(facts.demand.orders.map((order) => order.id), "order");
  assertUnique(facts.demand.items.map((item) => item.id), "order item");
  assertUnique(facts.demand.sourceItems.map((item) => item.id), "shipment source");
  assertUnique(facts.demand.physicalItems.map((item) => item.id), "physical shipment item");
  assertUnique(facts.variants.map((variant) => variant.id), "variant");
  assertUnique(facts.encumbrance.inventoryLevels.map((level) => level.inventoryLevelId), "inventory level");
  assertUnique(facts.encumbrance.inventoryLevels.map((level) => `${level.warehouseLocationId}:${level.productVariantId}`), "inventory position");
  assertUnique(facts.encumbrance.canonicalResources.map((resource) => resource.claimResourceId), "canonical resource");
  assertUnique(facts.encumbrance.buildReservations.map((reservation) => reservation.reservationId), "build reservation");
  return facts;
}

/** Helpers record findings only in this invocation's explicitly owned collection. */
function createFindingRecorder(findings: InventoryCutoverFinding[]): AddFinding {
  return (code, message, ids = {}) => {
    findings.push({ code, message, orderId: null, orderItemId: null, inventoryLevelId: null, ...ids });
  };
}

function indexDemandFacts(facts: InventoryCutoverPreflightFacts): DemandIndexes {
  const orders = new Map(facts.demand.orders.map((order) => [order.id, order]));
  const itemsById = new Map(facts.demand.items.map((item) => [item.id, item]));
  const variantsBySku = new Map<string, InventoryCutoverVariant[]>();
  for (const variant of facts.variants) {
    const key = variant.sku.toUpperCase();
    variantsBySku.set(key, [...(variantsBySku.get(key) ?? []), variant]);
  }
  return { orders, itemsById, variantsBySku };
}

function reviewShipmentSources(demand: WmsCutoverDemandCapture, indexes: DemandIndexes, add: AddFinding): SourceReview {
  const { orders, itemsById, variantsBySku } = indexes;
  const physicalItemIds = new Set(demand.physicalItems.flatMap((item) => [item.orderItemId, item.replacementForOrderItemId].filter((id): id is number => id !== null)));
  const sourceItemIds = new Set<number>();
  const intendedSourceQty = new Map<number, bigint>();
  for (const source of demand.sourceItems) {
    const item = source.orderItemId === null ? null : itemsById.get(source.orderItemId);
    if (source.orderItemId !== null && (!item || source.headerOrderId !== item.orderId)) {
      add("SHIPMENT_SOURCE_ORDER_MEMBERSHIP_CONFLICT", "A shipment source points to a missing or different order item; its package contents cannot establish this order's demand.", {
        orderId: source.headerOrderId !== null && orders.has(source.headerOrderId) ? source.headerOrderId : null,
        orderItemId: item?.id ?? null,
      });
    }
    const targetMatches = item ? (variantsBySku.get(item.sku.toUpperCase()) ?? []).filter((variant) => variant.isActive) : [];
    // Normal unshipped source rows/labels describe intended packages. They do not
    // reduce customer demand or prove a stock movement. Unknown/corrected history
    // still requires reconciliation before it can be used by a migration.
    const ordinaryUnshipped = item && source.headerOrderId === item.orderId
      && source.replacementForOrderItemId === null && source.correctionForShipmentItemId === null
      && source.purpose === "customer_fulfillment" && source.quantity >= 0
      && targetMatches.length === 1 && source.productVariantId === targetMatches[0]!.id
      && ["planned", "queued", "labeled"].includes(source.shipmentStatus ?? "");
    if (ordinaryUnshipped && item) intendedSourceQty.set(item.id, (intendedSourceQty.get(item.id) ?? BigInt(0)) + BigInt(source.quantity));
    if (!ordinaryUnshipped) {
      for (const itemId of [source.orderItemId, source.replacementForOrderItemId]) if (itemId !== null) sourceItemIds.add(itemId);
    }
  }
  for (const [itemId, quantity] of intendedSourceQty) if (quantity > BigInt(itemsById.get(itemId)!.quantity)) sourceItemIds.add(itemId);
  if (demand.physicalItems.some((item) => item.orderItemId === null && item.replacementForOrderItemId === null)) {
    add("UNATTRIBUTED_PHYSICAL_PACKAGE_EVIDENCE", "A physical package row has no exact order-item identity; no inventory custody is inferred from its SKU.");
  }
  if (demand.sourceItems.some((item) => item.orderItemId === null && item.replacementForOrderItemId === null)) {
    add("UNATTRIBUTED_SHIPMENT_SOURCE", "A shipment source has no exact order-item identity; review its contents separately.");
  }
  return { physicalItemIds, sourceItemIds };
}

function classifyDemandLines(
  facts: InventoryCutoverPreflightFacts,
  indexes: DemandIndexes,
  sources: SourceReview,
  add: AddFinding,
): InventoryCutoverLine[] {
  const { orders, variantsBySku } = indexes;
  const { physicalItemIds, sourceItemIds } = sources;
  const claimedItemIds = new Set(facts.encumbrance.canonicalResources.map((resource) => resource.orderItemId));
  return facts.demand.items.map((item) => {
    const order = orders.get(item.orderId);
    if (!order) throw new Error("Cutover demand capture contains an item without its order.");
    const lineFindings: string[] = [];
    const issue = (code: string, message: string) => {
      lineFindings.push(code);
      add(code, message, { orderId: order.id, orderItemId: item.id });
    };
    const ordered = BigInt(item.quantity);
    const picked = BigInt(item.pickedQuantity);
    const fulfilled = BigInt(item.fulfilledQuantity);
    const matches = (variantsBySku.get(item.sku.toUpperCase()) ?? []).filter((variant) => variant.isActive);
    const variant = matches.length === 1 ? matches[0]! : null;
    const hasPackageEvidence = physicalItemIds.has(item.id) || sourceItemIds.has(item.id);
    let disposition: InventoryCutoverLine["disposition"] = "review_required";
    let candidateDemandQty: string | null = null;

    if (ordered < BigInt(0) || picked < BigInt(0) || fulfilled < BigInt(0) || picked > ordered || fulfilled > ordered) {
      issue("INVALID_ORDER_QUANTITIES", "Order, picked and fulfilled counters must be reconciled before deriving demand.");
    }
    const notInventoryTracked = item.requiresShipping === 0
      || (variant !== null && (!variant.requiresShipping || !variant.trackInventory));
    if (notInventoryTracked) {
      if (hasPackageEvidence || claimedItemIds.has(item.id)) {
        issue("NONINVENTORY_OWNER_EVIDENCE", "A non-inventory item has package or canonical resource evidence; verify its ownership history.");
      }
      if (lineFindings.length === 0) { disposition = "no_inventory_demand"; candidateDemandQty = "0"; }
    } else {
      if (!(WMS_WAREHOUSE_STATUS_VALUES as readonly (string | null)[]).includes(order.status)
        || ["shipped", "cancelled"].includes(order.status ?? "")) {
        issue("ORDER_STATE_REVIEW", "The captured order state is not a recognized nonterminal state; do not infer demand from it.");
      }
      if (![0, 1].includes(order.onHold)) issue("ORDER_HOLD_STATE_INVALID", "The order's hold flag is not a recognized value.");
      if (item.requiresShipping !== 1) issue("INVALID_SHIPPING_REQUIREMENT", "The order item's shipping requirement is not a recognized value.");
      if (matches.length !== 1) issue("VARIANT_IDENTITY_UNRESOLVED", "The physical item SKU must identify exactly one active catalog variant.");
      if (variant && item.productId !== null && item.productId !== variant.id && item.productId !== variant.productId) {
        issue("VARIANT_IDENTITY_CONFLICT", "The stored product identity disagrees with the exact SKU mapping.");
      }
      if (variant?.salesEligibility === "internal_only") issue("INTERNAL_TARGET_REVIEW", "An existing customer line targets an internal-only variant; review it without inferring a replacement SKU.");
      if (order.warehouseId === null) issue("WAREHOUSE_SCOPE_MISSING", "The physical order has no assigned warehouse; network scope is not inferred.");
      if (order.status === "awaiting_3pl") issue("EXTERNAL_FULFILLMENT_REVIEW", "This order is externally fulfilled; local picker counters cannot establish 3PL custody or claims.");
      if (picked > BigInt(0) || fulfilled > BigInt(0) || hasPackageEvidence || claimedItemIds.has(item.id)) {
        issue("DEMAND_CUSTODY_RECONCILIATION_REQUIRED", "Picker progress, fulfillment counters and package records are not interchangeable with exact inventory custody; reconcile their lineage before claiming remaining demand.");
      }
      if (item.status === "cancelled" || ordered === BigInt(0)) {
        if (lineFindings.length === 0) { disposition = "no_inventory_demand"; candidateDemandQty = "0"; }
      } else if (!["pending", "in_progress", "short"].includes(item.status ?? "")) {
        issue("ITEM_STATE_REVIEW", "The current item state does not prove untouched unfulfilled demand. Short work remains demand; completed work requires custody evidence.");
      }
      if (lineFindings.length === 0 && disposition !== "no_inventory_demand") {
        disposition = "unstarted_demand";
        candidateDemandQty = ordered.toString();
      }
    }
    return {
      orderId: order.id, orderItemId: item.id, warehouseId: order.warehouseId, sku: item.sku,
      orderStatus: order.status, itemStatus: item.status, productVariantId: variant?.id ?? null,
      orderedQty: String(item.quantity), recordedPickedQty: String(item.pickedQuantity), recordedFulfilledQty: String(item.fulfilledQuantity),
      candidateDemandQty, disposition, findingCodes: [...new Set(lineFindings)].sort(),
    };
  }).sort((a, b) => a.orderId - b.orderId || a.orderItemId - b.orderItemId);
}

function reconcileInventoryOwners(
  encumbrance: InventoryCutoverEncumbranceDto,
  add: AddFinding,
): InventoryCutoverPreflight["inventoryLevels"] {
  const canonicalByLevel = collectCanonicalOpenByLevel(encumbrance, add);
  const buildByPosition = collectStandaloneBuildOpenByPosition(encumbrance, add);
  return summarizeLevelBalances(encumbrance.inventoryLevels, canonicalByLevel, buildByPosition, add);
}

function collectCanonicalOpenByLevel(
  encumbrance: InventoryCutoverEncumbranceDto,
  add: AddFinding,
): ReadonlyMap<number, bigint> {
  const canonicalByLevel = new Map<number, bigint>();
  const knownLevels = new Map(encumbrance.inventoryLevels.map((level) => [level.inventoryLevelId, level]));
  for (const resource of encumbrance.canonicalResources) {
    const counters = [resource.claimedQty, resource.releasedQty, resource.consumedQty, resource.pickedQty].map(BigInt);
    const open = counters[0]! - counters[1]! - counters[2]! - counters[3]!;
    if (counters.some((value) => value < BigInt(0)) || open < BigInt(0)) {
      add("INVALID_CANONICAL_RESOURCE_BALANCE", "Canonical resource counters do not form a nonnegative outstanding hold.", { inventoryLevelId: resource.inventoryLevelId });
      continue;
    }
    const level = knownLevels.get(resource.inventoryLevelId);
    if (resource.orderId === null || resource.orderItemId === null || resource.targetVariantId === null || resource.claimStatus === null) {
      add("CANONICAL_OWNER_IDENTITY_MISSING", "Canonical resource hold ownership is missing its claim/order/item/target identity.", { inventoryLevelId: resource.inventoryLevelId });
    }
    if (!level) { add("CANONICAL_RESOURCE_LEVEL_MISSING", "A canonical resource references an inventory level absent from the capture."); continue; }
    if (level.productVariantId !== resource.sourceVariantId || level.warehouseLocationId !== resource.warehouseLocationId) {
      add("CANONICAL_RESOURCE_IDENTITY_CONFLICT", "A canonical resource disagrees with the variant or location of its recorded inventory level.", { inventoryLevelId: resource.inventoryLevelId }); continue;
    }
    if (resource.claimStatus !== "active" && open > BigInt(0)) add("INACTIVE_CLAIM_RETAINS_HOLD", "An inactive canonical claim retains an outstanding resource hold.", { inventoryLevelId: resource.inventoryLevelId });
    canonicalByLevel.set(resource.inventoryLevelId, (canonicalByLevel.get(resource.inventoryLevelId) ?? BigInt(0)) + open);
  }
  return canonicalByLevel;
}

function collectStandaloneBuildOpenByPosition(
  encumbrance: InventoryCutoverEncumbranceDto,
  add: AddFinding,
): ReadonlyMap<string, bigint> {
  const buildByPosition = new Map<string, bigint>();
  const resourcesById = new Map(encumbrance.canonicalResources.map((resource) => [resource.claimResourceId, resource]));
  const buildQtyByClaimResource = new Map<string, bigint>();
  const buildQtyByLot = new Map<number, bigint>();
  const lotReservedById = new Map<number, string | null>();
  for (const reservation of encumbrance.buildReservations) {
    const counters = [reservation.reservedQty, reservation.consumedQty, reservation.releasedQty].map(BigInt);
    const open = counters[0]! - counters[1]! - counters[2]!;
    if (counters.some((value) => value < BigInt(0)) || open < BigInt(0)) { add("INVALID_BUILD_RESERVATION_BALANCE", "Build reservation counters do not form a nonnegative outstanding hold."); continue; }
    if (open === BigInt(0)) continue;
    buildQtyByLot.set(reservation.inventoryLotId, (buildQtyByLot.get(reservation.inventoryLotId) ?? BigInt(0)) + open);
    if (lotReservedById.has(reservation.inventoryLotId) && lotReservedById.get(reservation.inventoryLotId) !== reservation.lotQtyReserved) {
      add("BUILD_LOT_CAPTURE_INCONSISTENT", "The same physical lot has conflicting reservation counters in this capture.");
    }
    lotReservedById.set(reservation.inventoryLotId, reservation.lotQtyReserved);
    if (reservation.buildOrderId === null || reservation.buildOrderStatus === null || reservation.warehouseId === null) add("BUILD_OWNER_IDENTITY_MISSING", "An outstanding build reservation lacks its build order, state or warehouse identity.");
    if (["completed", "cancelled"].includes(reservation.buildOrderStatus ?? "")) add("TERMINAL_BUILD_RETAINS_HOLD", "A terminal build retains an outstanding reservation; preserve it for explicit reconciliation rather than releasing it automatically.");
    // Claim-owned build reservations are projections of the canonical hold, not additional capacity spent.
    if (reservation.reservationOwner === "availability_claim") {
      const resource = reservation.claimLotResourceId === null ? null : resourcesById.get(reservation.claimLotResourceId);
      if (reservation.availabilityClaimId === null || reservation.availabilityClaimLotAllocationId === null
        || !resource || resource.claimId !== reservation.availabilityClaimId
        || resource.sourceVariantId !== reservation.componentVariantId
        || resource.warehouseLocationId !== reservation.sourceLocationId
        || resource.warehouseId !== reservation.warehouseId
        || reservation.componentVariantId !== reservation.lotVariantId
        || reservation.sourceLocationId !== reservation.lotLocationId
        || reservation.claimLotInventoryLotId !== reservation.inventoryLotId
        || reservation.claimLotOpenQty === null || BigInt(reservation.claimLotOpenQty) !== open
        || BigInt(resource.claimedQty) - BigInt(resource.releasedQty) - BigInt(resource.consumedQty) - BigInt(resource.pickedQty) < open) {
        add("BUILD_CLAIM_LINEAGE_UNVERIFIED", "A canonical-backed build reservation does not match captured claim, resource and lot ownership; no independent or duplicate hold is inferred.");
      } else {
        buildQtyByClaimResource.set(resource.claimResourceId, (buildQtyByClaimResource.get(resource.claimResourceId) ?? BigInt(0)) + open);
      }
      continue;
    }
    if (reservation.reservationOwner !== "build_order") { add("BUILD_RESERVATION_OWNER_UNKNOWN", "An outstanding build reservation has an unsupported owner; its stock cannot be treated as free."); continue; }
    if (reservation.sourceLocationId === null || reservation.componentVariantId !== reservation.lotVariantId
      || reservation.sourceLocationId !== reservation.lotLocationId) {
      add("BUILD_RESERVATION_LOCATION_CONFLICT", "An outstanding build reservation does not match its component and physical lot location.");
      continue;
    }
    const key = `${reservation.sourceLocationId}:${reservation.componentVariantId}`;
    buildByPosition.set(key, (buildByPosition.get(key) ?? BigInt(0)) + open);
  }
  for (const [resourceId, projectedQty] of buildQtyByClaimResource) {
    const resource = resourcesById.get(resourceId)!;
    const open = BigInt(resource.claimedQty) - BigInt(resource.releasedQty) - BigInt(resource.consumedQty) - BigInt(resource.pickedQty);
    if (projectedQty > open) add("BUILD_CLAIM_PROJECTIONS_EXCEED_HOLD", "Combined build lot projections exceed their shared canonical resource hold.", { inventoryLevelId: resource.inventoryLevelId });
  }
  for (const [lotId, open] of buildQtyByLot) {
    const recorded = lotReservedById.get(lotId);
    if (recorded === null || recorded === undefined || BigInt(recorded) < open) add("BUILD_LOT_RESERVED_SHORTFALL", "A lot's recorded reserved quantity cannot cover all captured outstanding build reservations.");
  }
  return buildByPosition;
}

function summarizeLevelBalances(
  levels: InventoryCutoverEncumbranceDto["inventoryLevels"],
  canonicalByLevel: ReadonlyMap<number, bigint>,
  buildByPosition: ReadonlyMap<string, bigint>,
  add: AddFinding,
): InventoryCutoverPreflight["inventoryLevels"] {
  const unmatchedBuildPositions = new Set(buildByPosition.keys());
  const inventoryLevels = levels.map((level) => {
    const canonical = canonicalByLevel.get(level.inventoryLevelId) ?? BigInt(0);
    const key = `${level.warehouseLocationId}:${level.productVariantId}`;
    const builds = buildByPosition.get(key) ?? BigInt(0);
    unmatchedBuildPositions.delete(key);
    const residual = BigInt(level.reservedQty) - canonical - builds;
    if ([level.variantQty, level.reservedQty, level.pickedQty, level.packedQty].some((value) => BigInt(value) < BigInt(0))) {
      add("NEGATIVE_INVENTORY_COUNTER", "An inventory counter is negative; no clamping or repair is performed by this preview.", { inventoryLevelId: level.inventoryLevelId });
    }
    if (residual !== BigInt(0)) add("RESERVATION_OWNER_RECONCILIATION_REQUIRED", "The recorded reservation counter differs from captured canonical and standalone-build holds. The difference may include legacy order holds; it is not free stock.", { inventoryLevelId: level.inventoryLevelId });
    if (BigInt(level.pickedQty) > BigInt(0) || BigInt(level.packedQty) > BigInt(0)) add("PICKED_CUSTODY_LINEAGE_REQUIRED", "Picked/packed counters require exact movement, order and lot/cost lineage before migration; they are not deducted from physical on-hand again.", { inventoryLevelId: level.inventoryLevelId });
    return {
      inventoryLevelId: level.inventoryLevelId, productVariantId: level.productVariantId,
      warehouseLocationId: level.warehouseLocationId, physicalQty: level.variantQty,
      recordedReservedQty: level.reservedQty, canonicalOpenQty: canonical.toString(),
      standaloneBuildOpenQty: builds.toString(), unattributedReservedQty: residual.toString(),
      pickedQty: level.pickedQty, packedQty: level.packedQty,
    };
  }).sort((a, b) => a.inventoryLevelId - b.inventoryLevelId);
  if (unmatchedBuildPositions.size > 0) add("BUILD_RESERVATION_LEVEL_MISSING", "Some outstanding build reservations have no captured inventory level.");
  return inventoryLevels;
}

function assemblePreflightReport(
  facts: InventoryCutoverPreflightFacts,
  lines: InventoryCutoverLine[],
  inventoryLevels: InventoryCutoverPreflight["inventoryLevels"],
  findings: readonly InventoryCutoverFinding[],
): InventoryCutoverPreflight {
  const uniqueFindings = [...new Map(findings.map((finding) => [canonicalJson(finding), finding])).values()]
    .sort((a, b) => a.code.localeCompare(b.code) || (a.orderId ?? 0) - (b.orderId ?? 0)
      || (a.orderItemId ?? 0) - (b.orderItemId ?? 0) || (a.inventoryLevelId ?? 0) - (b.inventoryLevelId ?? 0));
  return inventoryCutoverPreflightSchema.parse({
    contractVersion: "inventory_cutover_preflight_v1",
    scope: "nonterminal_wms_demand_and_current_inventory_encumbrances",
    capturedAt: facts.capturedAt, evidenceHash: createHash("sha256").update(canonicalJson(facts)).digest("hex"),
    runtimeAuthority: facts.runtimeAuthority, authorityRevision: facts.authorityRevision,
    outcome: uniqueFindings.length > 0 ? "review_required" : "evidence_captured",
    operationalWriteAttempted: false, activationReadinessEvaluated: false,
    excludedTerminalOrderCount: facts.demand.excludedTerminalOrderCount,
    summary: {
      orders: facts.demand.orders.length, lines: lines.length,
      unstartedDemandLines: lines.filter((line) => line.disposition === "unstarted_demand").length,
      noInventoryDemandLines: lines.filter((line) => line.disposition === "no_inventory_demand").length,
      reviewLines: lines.filter((line) => line.disposition === "review_required").length,
      inventoryLevels: inventoryLevels.length,
      unattributedReservationLevels: inventoryLevels.filter((level) => level.unattributedReservedQty !== "0").length,
    },
    lines, inventoryLevels, findings: uniqueFindings, notEvaluated: [...NOT_EVALUATED],
  });
}

function assertUnique(values: readonly (number | string)[], entity: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Cutover capture contains duplicate ${entity} identities.`);
}
