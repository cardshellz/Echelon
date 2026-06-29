/**
 * Inbound Shipment Tracking + Landed Cost Allocation Service
 *
 * Manages the lifecycle of inbound shipments from vendors:
 *   draft → booked → in_transit → at_port → customs_clearance → delivered → costing → closed
 *
 * Tracks itemized costs (freight, duty, insurance, etc.) and allocates them
 * to PO lines using configurable methods (volume, weight, value, line count).
 * Pushes finalized landed costs to inventory lots.
 */

import type {
  InboundShipment,
  InsertInboundShipment,
  InboundShipmentLine,
  InsertInboundShipmentLine,
  InboundFreightCost,
  InsertInboundFreightCost,
  InsertInboundFreightAllocation,
  InsertLandedCostSnapshot,
  InboundShipmentStatusHistory,
  InventoryLot,
} from "@shared/schema";
import { inboundShipmentLines, inboundFreightCosts, vendors } from "@shared/schema";
import { millsToCents, perUnitMills } from "@shared/utils/money";

/**
 * Allocate a shipment line's NON-PRODUCT landed cost (freight+duty+insurance+other,
 * in cents over `qty` base units) onto ONE inventory lot's variant unit (e.g. a case),
 * in mills, and fold it into the lot's total:
 *   landed_per_case = round_half_up(nonProductCents × 100 × units_per_variant ÷ qty)
 *   total = product + packaging + landed   (all mills; cents is a derived mirror)
 * Pure + exported for unit tests.
 */
export function computeLotLandedMills(args: {
  landedNonProductCents: number;
  unitsPerVariant: number;
  qty: number;
  poUnitCostMills: number;
  packagingCostMills: number;
}): { landedCostMills: number; totalMills: number; totalCents: number } {
  const upv = Math.max(1, Math.trunc(args.unitsPerVariant) || 1);
  const qty = Math.max(1, Math.trunc(args.qty) || 1);
  const landedCostMills = perUnitMills(Math.max(0, Math.trunc(args.landedNonProductCents)) * 100 * upv, qty);
  const totalMills = (args.poUnitCostMills || 0) + (args.packagingCostMills || 0) + landedCostMills;
  return { landedCostMills, totalMills, totalCents: millsToCents(totalMills) };
}
import { sql as sqlTag, eq } from "drizzle-orm";

// ── Minimal dependency interfaces ───────────────────────────────────

interface Storage {
  // Inbound Shipments
  getInboundShipments(filters?: any): Promise<InboundShipment[]>;
  getInboundShipmentsCount(filters?: any): Promise<number>;
  getInboundShipmentById(id: number): Promise<InboundShipment | undefined>;
  getInboundShipmentByNumber(shipmentNumber: string): Promise<InboundShipment | undefined>;
  createInboundShipment(data: InsertInboundShipment): Promise<InboundShipment>;
  updateInboundShipment(id: number, updates: Partial<InsertInboundShipment>): Promise<InboundShipment | null>;
  deleteInboundShipment(id: number): Promise<boolean>;
  generateShipmentNumber(): Promise<string>;
  // Lines
  getInboundShipmentLines(inboundShipmentId: number): Promise<InboundShipmentLine[]>;
  getInboundShipmentLineById(id: number): Promise<InboundShipmentLine | undefined>;
  getInboundShipmentLinesByPo(purchaseOrderId: number): Promise<InboundShipmentLine[]>;
  createInboundShipmentLine(data: InsertInboundShipmentLine): Promise<InboundShipmentLine>;
  bulkCreateInboundShipmentLines(lines: InsertInboundShipmentLine[]): Promise<InboundShipmentLine[]>;
  updateInboundShipmentLine(id: number, updates: Partial<InsertInboundShipmentLine>): Promise<InboundShipmentLine | null>;
  deleteInboundShipmentLine(id: number): Promise<boolean>;
  // Costs
  getInboundFreightCosts(inboundShipmentId: number): Promise<InboundFreightCost[]>;
  getInboundFreightCostById(id: number): Promise<InboundFreightCost | undefined>;
  createInboundFreightCost(data: InsertInboundFreightCost): Promise<InboundFreightCost>;
  updateInboundFreightCost(id: number, updates: Partial<InsertInboundFreightCost>): Promise<InboundFreightCost | null>;
  deleteInboundFreightCost(id: number): Promise<boolean>;
  // Allocations
  getInboundFreightCostAllocations(inboundFreightCostId: number): Promise<any[]>;
  getAllocationsForLine(inboundShipmentLineId: number): Promise<any[]>;
  createInboundFreightCostAllocation(data: InsertInboundFreightAllocation): Promise<any>;
  bulkCreateInboundFreightCostAllocations(allocations: InsertInboundFreightAllocation[]): Promise<any[]>;
  deleteAllocationsForShipment(inboundShipmentId: number): Promise<void>;
  // Landed cost snapshots
  getLandedCostSnapshots(inboundShipmentLineId: number): Promise<any[]>;
  getLandedCostSnapshotByPoLine(purchaseOrderLineId: number): Promise<any>;
  createLandedCostSnapshot(data: InsertLandedCostSnapshot): Promise<any>;
  bulkCreateLandedCostSnapshots(snapshots: InsertLandedCostSnapshot[]): Promise<any[]>;
  deleteLandedCostSnapshotsForShipment(inboundShipmentId: number): Promise<void>;
  createLandedCostAdjustment(data: any): Promise<any>;
  // Status history
  createInboundShipmentStatusHistory(data: any): Promise<InboundShipmentStatusHistory>;
  getInboundShipmentStatusHistory(inboundShipmentId: number): Promise<InboundShipmentStatusHistory[]>;
  // Cross-references
  getInboundShipmentsByPo(purchaseOrderId: number): Promise<InboundShipment[]>;
  getProvisionalLotsByShipment(inboundShipmentId: number): Promise<InventoryLot[]>;
  // PO references
  getPurchaseOrderById(id: number): Promise<any>;
  getPurchaseOrderLines(purchaseOrderId: number): Promise<any[]>;
  getPurchaseOrderLineById(id: number): Promise<any>;
  // Vendor product dimensions
  getVendorProducts(filters?: any): Promise<any[]>;
  // Product variant + product lookups
  getProductVariantById(id: number): Promise<any>;
  getProductById(id: number): Promise<any>;
  // Inventory lots
  updateInventoryLot(id: number, updates: any): Promise<any>;
}

// ── Custom error ────────────────────────────────────────────────────

export class ShipmentTrackingError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "ShipmentTrackingError";
  }
}

// ── State machine ───────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft:              ["booked", "cancelled"],
  booked:             ["in_transit", "cancelled"],
  in_transit:         ["at_port", "delivered", "cancelled"],  // delivered direct for ground/domestic
  at_port:            ["customs_clearance", "cancelled"],
  customs_clearance:  ["delivered", "cancelled"],
  delivered:          ["costing", "cancelled"],
  costing:            ["closed", "cancelled"],
};

const MODE_DEFAULT_ALLOCATION: Record<string, string> = {
  sea_fcl: "by_volume",
  sea_lcl: "by_volume",
  air: "by_chargeable_weight",
  ground: "by_weight",
  ltl: "by_weight",
  ftl: "by_weight",
  parcel: "by_weight",
  courier: "by_weight",
};

// Allocation methods that require physical line dimensions. If a cost uses one of
// these and ANY line lacks the dimension, allocation silently mis-distributes —
// equal-split fallback when every line lacks it, or $0 to the dimensionless lines
// when only some do — so we hard-block closing until dimensions are entered.
const DIMENSIONAL_METHODS = new Set(["by_volume", "by_weight", "by_chargeable_weight"]);
const DIMENSION_LABELS: Record<string, string> = {
  by_volume: "volume (length × width × height)",
  by_weight: "weight",
  by_chargeable_weight: "chargeable weight",
};
function rawLineBasisForDimension(line: any, method: string): number {
  switch (method) {
    case "by_volume": return Number(line.totalVolumeCbm || 0);
    case "by_weight": return Number(line.totalWeightKg || 0);
    case "by_chargeable_weight": return Number(line.chargeableWeightKg || 0);
    default: return 1;
  }
}

// Cost types with hard-coded allocation method overrides
const COST_TYPE_ALLOCATION_OVERRIDES: Record<string, string> = {
  duty: "by_value",
  brokerage: "by_line_count",
  inspection: "by_line_count",
  platform_fee: "by_line_count",
};

function positiveIntegerOrNull(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
  return numberValue;
}

function firstPositiveInteger(...values: unknown[]): number | null {
  for (const value of values) {
    const numberValue = positiveIntegerOrNull(value);
    if (numberValue !== null) return numberValue;
  }
  return null;
}

function getReceiveVariantId(row: any): number | null {
  return firstPositiveInteger(
    row?.expectedReceiveVariantId,
    row?.expected_receive_variant_id,
    row?.productVariantId,
    row?.product_variant_id,
  );
}

function getReceiveUnitsPerVariant(row: any): number | null {
  return firstPositiveInteger(
    row?.expectedReceiveUnitsPerVariant,
    row?.expected_receive_units_per_variant,
    row?.unitsPerUom,
    row?.units_per_uom,
  );
}

// ── Service factory ─────────────────────────────────────────────────

export type ShipmentTrackingService = ReturnType<typeof createShipmentTrackingService>;

export function createShipmentTrackingService(db: any, storage: Storage) {

  // ─── Private helpers ────────────────────────────────────────────

  function resolveAllocationMethod(cost: InboundFreightCost, shipment: InboundShipment) {
    const costTypeOverride = COST_TYPE_ALLOCATION_OVERRIDES[cost.costType];
    if (costTypeOverride) {
      return { method: costTypeOverride, source: "cost_type_override" };
    }
    if (cost.allocationMethod) {
      return { method: cost.allocationMethod, source: "cost_row" };
    }
    if (shipment.allocationMethodDefault) {
      return { method: shipment.allocationMethodDefault, source: "shipment_default" };
    }
    return { method: "by_volume", source: "fallback_default" };
  }

  async function buildAllocationBasis(lines: InboundShipmentLine[], method: string) {
    const values: Array<{ lineId: number; basis: number }> = [];
    let rawBasisTotal = 0;

    for (const line of lines) {
      let basis = 0;
      switch (method) {
        case "by_volume":
          basis = Number(line.totalVolumeCbm || 0);
          break;
        case "by_chargeable_weight":
          basis = Number(line.chargeableWeightKg || 0);
          break;
        case "by_weight":
          basis = Number(line.totalWeightKg || 0);
          break;
        case "by_value":
          if (line.purchaseOrderLineId) {
            const poLine = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId);
            basis = (poLine?.unitCostCents || 0) * line.qtyShipped;
          }
          break;
        case "by_line_count":
          basis = 1;
          break;
        default:
          basis = 1;
      }
      values.push({ lineId: line.id, basis });
      rawBasisTotal += basis;
    }

    if (rawBasisTotal === 0) {
      return {
        values: values.map((value) => ({ ...value, basis: 1 })),
        rawBasisTotal,
        basisTotal: values.length,
        usedFallback: values.length > 0,
      };
    }

    return { values, rawBasisTotal, basisTotal: rawBasisTotal, usedFallback: false };
  }

  function assertTransition(currentStatus: string, targetStatus: string) {
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new ShipmentTrackingError(
        `Cannot transition from '${currentStatus}' to '${targetStatus}'`,
        400,
      );
    }
  }

  async function recordStatusChange(
    inboundShipmentId: number,
    fromStatus: string | null,
    toStatus: string,
    userId?: string,
    notes?: string,
  ) {
    await storage.createInboundShipmentStatusHistory({
      inboundShipmentId,
      fromStatus,
      toStatus,
      changedBy: userId || null,
      notes: notes || null,
    });
  }

  async function recomputeShipmentTotals(shipmentId: number) {
    const lines = await storage.getInboundShipmentLines(shipmentId);
    const costs = await storage.getInboundFreightCosts(shipmentId);

    // Aggregate NET totals from lines (weight/volume computed from per-carton values × cartonCount)
    let totalWeightKg = 0;
    let totalVolumeCbm = 0;
    let totalPieces = 0;
    let totalCartons = 0;

    for (const line of lines) {
      totalWeightKg += Number(line.totalWeightKg || 0);
      totalVolumeCbm += Number(line.totalVolumeCbm || 0);
      totalPieces += line.qtyShipped;
      totalCartons += line.cartonCount || 0;
    }

    let estimatedTotalCostCents = 0;
    let actualTotalCostCents = 0;
    for (const cost of costs) {
      estimatedTotalCostCents += cost.estimatedCents || 0;
      actualTotalCostCents += cost.actualCents || 0;
    }

    // NOTE: grossWeightKg, totalGrossVolumeCbm, palletCount are user-entered at shipment level (from BOL) — never overwritten here
    await storage.updateInboundShipment(shipmentId, {
      totalWeightKg: String(totalWeightKg),
      totalVolumeCbm: String(totalVolumeCbm),
      totalPieces,
      totalCartons,
      estimatedTotalCostCents,
      actualTotalCostCents,
    } as any);
  }

  function computeLineTotals(line: { qtyShipped: number; cartonCount?: number | null; weightKg?: string | null; lengthCm?: string | null; widthCm?: string | null; heightCm?: string | null }) {
    // Multiplier: cartonCount for case SKUs (weight/dims are per-carton), qtyShipped for piece items
    const multiplier = (line.cartonCount && line.cartonCount > 0) ? line.cartonCount : line.qtyShipped;
    const weightKg = Number(line.weightKg || 0);
    const lengthCm = Number(line.lengthCm || 0);
    const widthCm = Number(line.widthCm || 0);
    const heightCm = Number(line.heightCm || 0);

    const totalWeightKg = multiplier * weightKg;
    // Net volume: L * W * H in cm → CBM (divide by 1,000,000)
    const unitVolumeCbm = (lengthCm * widthCm * heightCm) / 1_000_000;
    const totalVolumeCbm = multiplier * unitVolumeCbm;
    // Chargeable weight: max(actual, volumetric) — IATA formula: L*W*H / 5000 per unit
    const volumetricWeightKg = (lengthCm * widthCm * heightCm) / 5000;
    const chargeableWeightKg = multiplier * Math.max(weightKg, volumetricWeightKg);

    return {
      totalWeightKg: String(totalWeightKg),
      totalVolumeCbm: String(totalVolumeCbm),
      chargeableWeightKg: String(chargeableWeightKg),
    };
  }

  // ─── Enrich lines with variant + PO data ────────────────────────

  async function getEnrichedLines(shipmentId: number) {
    const lines = await storage.getInboundShipmentLines(shipmentId);

    // Batch-fetch unique variant IDs and PO line IDs
    const variantIds = Array.from(new Set(lines.map(l => l.productVariantId).filter(Boolean))) as number[];
    const poLineIds = Array.from(new Set(lines.map(l => l.purchaseOrderLineId).filter(Boolean))) as number[];

    const variantMap = new Map<number, any>();
    const productMap = new Map<number, any>();
    const poLineMap = new Map<number, any>();

    // Fetch variants
    await Promise.all(variantIds.map(async (id) => {
      const pv = await storage.getProductVariantById(id);
      if (pv) variantMap.set(id, pv);
    }));

    // Fetch products (for real product title) via variant.productId
    const productIds = Array.from(new Set(
      Array.from(variantMap.values()).map((pv: any) => pv.productId).filter(Boolean)
    )) as number[];
    await Promise.all(productIds.map(async (id) => {
      const product = await storage.getProductById(id);
      if (product) productMap.set(id, product);
    }));

    // Fetch PO lines
    await Promise.all(poLineIds.map(async (id) => {
      const pol = await storage.getPurchaseOrderLineById(id);
      if (pol) poLineMap.set(id, pol);
    }));

    return lines.map(line => {
      const pv = line.productVariantId ? variantMap.get(line.productVariantId) : null;
      const product = pv?.productId ? productMap.get(pv.productId) : null;
      const pol = line.purchaseOrderLineId ? poLineMap.get(line.purchaseOrderLineId) : null;
      return {
        ...line,
        unitsPerVariant: pv?.unitsPerVariant ?? 1,
        productName: product?.title || product?.name || pol?.productName || pv?.name || line.sku || null,
        poQtyOrdered: pol?.orderQty ?? null,
      };
    });
  }

  // ─── CRUD ───────────────────────────────────────────────────────

  async function createShipment(data: {
    mode?: string;
    carrierName?: string;
    forwarderName?: string;
    bookingReference?: string;
    originPort?: string;
    destinationPort?: string;
    originCountry?: string;
    destinationCountry?: string;
    containerNumber?: string;
    sealNumber?: string;
    containerSize?: string;
    containerCapacityCbm?: string;
    bolNumber?: string;
    houseBol?: string;
    trackingNumber?: string;
    etd?: Date;
    eta?: Date;
    warehouseId?: number;
    notes?: string;
    internalNotes?: string;
  }, userId?: string) {
    const shipmentNumber = (data as any).shipmentNumber || await storage.generateShipmentNumber();
    const allocationMethodDefault = data.mode ? MODE_DEFAULT_ALLOCATION[data.mode] || "by_volume" : "by_volume";

    let shipment: InboundShipment;
    try {
      shipment = await storage.createInboundShipment({
        shipmentNumber,
        status: "draft",
        allocationMethodDefault,
        createdBy: userId || null,
        ...data,
      } as any);
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new ShipmentTrackingError(
          `Shipment number '${shipmentNumber}' already in use by an active record.`,
          409,
        );
      }
      throw error;
    }

    await recordStatusChange(shipment.id, null, "draft", userId, "Shipment created");
    return shipment;
  }

  async function getShipment(id: number) {
    const shipment = await storage.getInboundShipmentById(id);
    if (!shipment) throw new ShipmentTrackingError("Shipment not found", 404);
    return shipment;
  }

  async function updateShipment(id: number, updates: Partial<InsertInboundShipment>) {
    const shipment = await getShipment(id);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot edit a closed or cancelled shipment");
    }
    // If mode changed, update default allocation method
    if (updates.mode && updates.mode !== shipment.mode) {
      (updates as any).allocationMethodDefault = MODE_DEFAULT_ALLOCATION[updates.mode] || "by_volume";
    }
    return await storage.updateInboundShipment(id, updates);
  }

  async function deleteShipment(id: number) {
    const shipment = await getShipment(id);
    if (shipment.status !== "draft") {
      throw new ShipmentTrackingError("Only draft shipments can be deleted");
    }
    return await storage.deleteInboundShipment(id);
  }

  // ─── Status transitions ────────────────────────────────────────

  async function transitionTo(id: number, targetStatus: string, userId?: string, notes?: string, extraUpdates?: Partial<InsertInboundShipment>) {
    const shipment = await getShipment(id);
    assertTransition(shipment.status, targetStatus);

    const updates: any = { status: targetStatus, ...extraUpdates };

    // Validation + auto-set date fields
    switch (targetStatus) {
      case "booked": {
        const lines = await storage.getInboundShipmentLines(id);
        if (lines.length === 0) {
          throw new ShipmentTrackingError("Cannot book a shipment with no lines");
        }
        break;
      }
      case "in_transit":
        updates.shipDate = updates.shipDate || new Date();
        break;
      case "at_port":
        updates.actualArrival = updates.actualArrival || new Date();
        break;
      case "customs_clearance":
        break;
      case "delivered":
        updates.deliveredDate = updates.deliveredDate || new Date();
        if (shipment.status === "customs_clearance") {
          updates.customsClearedDate = updates.customsClearedDate || new Date();
        }
        break;
      case "costing":
        break;
      case "closed":
        updates.closedBy = userId || null;
        updates.closedAt = new Date();
        break;
      case "cancelled":
        break;
    }

    await storage.updateInboundShipment(id, updates);
    await recordStatusChange(id, shipment.status, targetStatus, userId, notes);
    return await storage.getInboundShipmentById(id);
  }

  async function book(id: number, userId?: string, notes?: string) {
    return transitionTo(id, "booked", userId, notes || "Shipment booked");
  }

  async function markInTransit(id: number, userId?: string, notes?: string, shipDate?: Date) {
    return transitionTo(id, "in_transit", userId, notes || "Shipment departed", { shipDate } as any);
  }

  async function markAtPort(id: number, userId?: string, notes?: string, actualArrival?: Date) {
    return transitionTo(id, "at_port", userId, notes || "Arrived at port", { actualArrival } as any);
  }

  async function markCustomsClearance(id: number, userId?: string, notes?: string) {
    return transitionTo(id, "customs_clearance", userId, notes || "Entered customs clearance");
  }

  async function markDelivered(id: number, userId?: string, notes?: string, deliveredDate?: Date) {
    return transitionTo(id, "delivered", userId, notes || "Delivered to warehouse", { deliveredDate } as any);
  }

  async function startCosting(id: number, userId?: string, notes?: string) {
    return transitionTo(id, "costing", userId, notes || "Costing started");
  }

  async function close(id: number, userId?: string, notes?: string) {
    // Finalize allocations, then PUSH the finalized landed costs onto the received
    // (provisional) lots — closing a shipment flows its freight/duty to inventory
    // automatically, instead of leaving it to a manual "Push Costs to Lots" click.
    // Best-effort: a push failure (e.g. nothing received yet) must NOT block the close;
    // the snapshots persist, the manual push remains as a re-trigger, and any receipt
    // created after close still picks up the landed cost at receive time.
    //
    // HARD GATE (dimensions): refuse to close if any cost is allocated by a physical
    // dimension (volume/weight) but some lines lack that dimension — otherwise freight
    // silently equal-splits or drops $0 onto the dimensionless lines. Scoped to ONLY this
    // blocker; other advisory blockers (unallocated/stale/mismatch) still don't gate close.
    const allocationStatus = await getAllocationStatus(id);
    const dimIssues = allocationStatus.issues.filter((issue) => issue.code === "missing_dimensions");
    if (dimIssues.length > 0) {
      throw new ShipmentTrackingError(
        `Cannot close — freight is allocated by dimensions but some lines are missing them. ${dimIssues.map((i) => i.message).join(" ")}`,
        400,
      );
    }

    await finalizeAllocations(id, userId);
    const closed = await transitionTo(id, "closed", userId, notes || "Shipment closed — landed costs finalized");
    try {
      await pushLandedCostsToLots(id);
    } catch (e: any) {
      console.warn(`[ShipmentTracking] auto-push landed cost on close for shipment ${id} failed (non-fatal): ${e?.message ?? e}`);
    }
    return closed;
  }

  async function cancel(id: number, userId?: string, reason?: string) {
    if (!reason) throw new ShipmentTrackingError("Cancellation reason is required");
    return transitionTo(id, "cancelled", userId, `Cancelled: ${reason}`);
  }

  // ─── Line management ───────────────────────────────────────────

  async function addLinesFromPO(
    shipmentId: number,
    purchaseOrderId: number,
    lineSelections?: Array<{ poLineId: number; qty: number }>,
    lineIds?: number[],
  ) {
    // Pre-flight checks (non-locked reads OK — shipment status is not contended)
    const shipment = await getShipment(shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot add lines to a closed or cancelled shipment");
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new ShipmentTrackingError("Purchase order not found", 404);

    const poLines = await storage.getPurchaseOrderLines(purchaseOrderId);

    // Build qty map from lineSelections (new behavior)
    const qtyMap = new Map<number, number>(); // poLineId -> qty
    if (lineSelections && lineSelections.length > 0) {
      for (const sel of lineSelections) {
        qtyMap.set(sel.poLineId, sel.qty);
      }
    }

    // Legacy: lineIds filters to specific lines but uses orderQty
    const candidateLines = qtyMap.size > 0
      ? poLines.filter((l: any) => qtyMap.has(l.id))
      : lineIds
        ? poLines.filter((l: any) => lineIds.includes(l.id))
        : poLines;

    const candidateLineIds = candidateLines.map((l: any) => l.id);

    if (candidateLineIds.length === 0) {
      throw new ShipmentTrackingError("No new PO lines to add");
    }

    // ── Atomic: lock PO lines, re-read shipped qty, validate, insert ──
    const created = await db.transaction(async (tx: any) => {
      // 1. Lock candidate PO lines (serializes concurrent adds on same lines)
      const lockedRows = await tx.execute(sqlTag`
        SELECT
          id,
          line_type,
          status,
          order_qty,
          cancelled_qty,
          sku,
          product_variant_id,
          expected_receive_variant_id,
          expected_receive_units_per_variant,
          units_per_uom
        FROM procurement.purchase_order_lines
        WHERE id = ANY(ARRAY[${sqlTag.join(candidateLineIds, sqlTag`, `)}]::integer[])
        FOR UPDATE
      `);

      const lockedLines = lockedRows.rows as any[];

      // Deduplicate: skip PO lines already on this shipment
      const existingOnShipment = await tx.execute(sqlTag`
        SELECT purchase_order_line_id
        FROM procurement.inbound_shipment_lines
        WHERE inbound_shipment_id = ${shipmentId}
          AND purchase_order_line_id = ANY(ARRAY[${sqlTag.join(candidateLineIds, sqlTag`, `)}]::integer[])
      `);
      const existingPoLineIds = new Set(
        existingOnShipment.rows
          .map((r: any) => r.purchase_order_line_id)
          .filter((id: any) => id != null),
      );
      // Intersect locked lines with candidates (defense-in-depth; SQL already
      // filters by candidateLineIds, but this guards against any edge case)
      const candidateIdSet = new Set(candidateLineIds);
      const linesToAdd = lockedLines.filter(
        (l: any) => candidateIdSet.has(l.id) && !existingPoLineIds.has(l.id),
      );

      if (linesToAdd.length === 0) {
        throw new ShipmentTrackingError("No new PO lines to add (all already on this shipment)");
      }

      // 2. Re-read alreadyShippedQty AFTER the lock (fresh data)
      const shippedResult = await tx.execute(sqlTag`
        SELECT
          isl.purchase_order_line_id,
          COALESCE(SUM(isl.qty_shipped), 0) AS already_shipped
        FROM procurement.inbound_shipment_lines isl
        JOIN procurement.inbound_shipments s ON s.id = isl.inbound_shipment_id
        WHERE isl.purchase_order_line_id = ANY(ARRAY[${sqlTag.join(candidateLineIds, sqlTag`, `)}]::integer[])
          AND s.status != 'cancelled'
        GROUP BY isl.purchase_order_line_id
      `);

      const shippedQtyByPoLine = new Map<number, number>();
      for (const row of shippedResult.rows as any[]) {
        shippedQtyByPoLine.set(
          Number(row.purchase_order_line_id),
          Number(row.already_shipped),
        );
      }

      // 3. Validate per-line against locked, re-read data
      if (qtyMap.size > 0) {
        for (const poLine of linesToAdd) {
          const isProduct = !poLine.line_type || poLine.line_type === "product";
          if (!isProduct) {
            throw new ShipmentTrackingError(
              `Line ${poLine.sku || poLine.id} is a ${poLine.line_type || "non-product"} line and cannot be shipped`,
            );
          }
          if (poLine.status === "closed" || poLine.status === "cancelled") {
            throw new ShipmentTrackingError(
              `Line ${poLine.sku || poLine.id} is ${poLine.status} and cannot be shipped`,
            );
          }

          const qty = qtyMap.get(poLine.id)!;
          if (qty <= 0) {
            throw new ShipmentTrackingError(
              `Line ${poLine.sku || poLine.id}: qty must be > 0 (got ${qty})`,
            );
          }

          const orderQty = poLine.order_qty ?? 0;
          const cancelledQty = poLine.cancelled_qty ?? 0;
          const alreadyShipped = shippedQtyByPoLine.get(poLine.id) ?? 0;
          const remaining = orderQty - alreadyShipped - cancelledQty;
          if (qty > remaining) {
            throw new ShipmentTrackingError(
              `Line ${poLine.sku || poLine.id}: qty ${qty} exceeds remaining ${remaining} (ordered ${orderQty}, shipped ${alreadyShipped}, cancelled ${cancelledQty})`,
            );
          }
        }
      }

      // 4. Insert new lines inside the transaction
      const newLines = await Promise.all(linesToAdd.map(async (poLine: any) => {
        const receiveVariantId = getReceiveVariantId(poLine);
        const qtyPieces = qtyMap.size > 0 ? qtyMap.get(poLine.id)! : (poLine.order_qty ?? 0);
        const dims = await resolveDimensionsForVariant(receiveVariantId, po.vendorId);

        let cartonCount: number | null = null;
        let receiveUnitsPerVariant = getReceiveUnitsPerVariant(poLine);
        if (!receiveUnitsPerVariant && receiveVariantId) {
          const receiveVariant = await storage.getProductVariantById(receiveVariantId);
          receiveUnitsPerVariant = positiveIntegerOrNull(receiveVariant?.unitsPerVariant);
        }
        if (receiveUnitsPerVariant && receiveUnitsPerVariant > 1) {
          cartonCount = Math.ceil(qtyPieces / receiveUnitsPerVariant);
        }

        const computed = computeLineTotals({
          qtyShipped: qtyPieces,
          cartonCount,
          weightKg: dims.weightKg,
          lengthCm: dims.lengthCm,
          widthCm: dims.widthCm,
          heightCm: dims.heightCm,
        });

        return {
          inboundShipmentId: shipmentId,
          purchaseOrderId,
          purchaseOrderLineId: poLine.id,
          productVariantId: receiveVariantId,
          sku: poLine.sku || null,
          qtyShipped: qtyPieces,
          cartonCount,
          weightKg: dims.weightKg,
          lengthCm: dims.lengthCm,
          widthCm: dims.widthCm,
          heightCm: dims.heightCm,
          ...computed,
        };
      }));

      return await tx.insert(inboundShipmentLines).values(newLines).returning();
    });

    await recomputeShipmentTotals(shipmentId);
    return created;
  }

  async function removeLine(lineId: number) {
    const line = await storage.getInboundShipmentLineById(lineId);
    if (!line) throw new ShipmentTrackingError("Shipment line not found", 404);

    const shipment = await getShipment(line.inboundShipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot remove lines from a closed or cancelled shipment");
    }

    await storage.deleteInboundShipmentLine(lineId);
    await recomputeShipmentTotals(line.inboundShipmentId);
    return true;
  }

  async function updateLineDimensions(lineId: number, updates: {
    weightKg?: string;
    lengthCm?: string;
    widthCm?: string;
    heightCm?: string;
    cartonCount?: number;
    qtyShipped?: number;
    notes?: string;
  }) {
    const line = await storage.getInboundShipmentLineById(lineId);
    if (!line) throw new ShipmentTrackingError("Shipment line not found", 404);

    // Recompute totals from per-carton values × cartonCount
    const qtyShipped = updates.qtyShipped ?? line.qtyShipped;
    const cartonCount = updates.cartonCount ?? line.cartonCount;
    const weightKg = updates.weightKg ?? line.weightKg;
    const lengthCm = updates.lengthCm ?? line.lengthCm;
    const widthCm = updates.widthCm ?? line.widthCm;
    const heightCm = updates.heightCm ?? line.heightCm;

    const computed = computeLineTotals({ qtyShipped, cartonCount, weightKg, lengthCm, widthCm, heightCm });

    await storage.updateInboundShipmentLine(lineId, {
      qtyShipped: updates.qtyShipped,
      weightKg: updates.weightKg,
      lengthCm: updates.lengthCm,
      widthCm: updates.widthCm,
      heightCm: updates.heightCm,
      cartonCount: cartonCount,
      notes: updates.notes,
      ...computed,
    } as any);

    await recomputeShipmentTotals(line.inboundShipmentId);
    return await storage.getInboundShipmentLineById(lineId);
  }

  async function resolveDimensionsForVariant(productVariantId: number | null, vendorId: number | null): Promise<{
    weightKg: string | null;
    lengthCm: string | null;
    widthCm: string | null;
    heightCm: string | null;
  }> {
    // Priority: vendor_products dims → product_variants dims → null
    if (productVariantId && vendorId) {
      const vendorProducts = await storage.getVendorProducts({ vendorId, productVariantId });
      const vp = vendorProducts[0];
      if (vp?.weightKg || vp?.lengthCm) {
        return {
          weightKg: vp.weightKg || null,
          lengthCm: vp.lengthCm || null,
          widthCm: vp.widthCm || null,
          heightCm: vp.heightCm || null,
        };
      }
    }

    // Fall back to product_variants dimensions (convert mm→cm, g→kg)
    if (productVariantId) {
      const pv = await storage.getProductVariantById(productVariantId);
      if (pv) {
        const weightKg = pv.weightGrams ? String(Number(pv.weightGrams) / 1000) : null;
        const lengthCm = pv.lengthMm ? String(Number(pv.lengthMm) / 10) : null;
        const widthCm = pv.widthMm ? String(Number(pv.widthMm) / 10) : null;
        const heightCm = pv.heightMm ? String(Number(pv.heightMm) / 10) : null;
        if (weightKg || lengthCm) {
          return { weightKg, lengthCm, widthCm, heightCm };
        }
      }
    }

    return { weightKg: null, lengthCm: null, widthCm: null, heightCm: null };
  }

  async function resolveDimensionsForShipment(shipmentId: number) {
    const shipment = await getShipment(shipmentId);
    const lines = await storage.getInboundShipmentLines(shipmentId);
    let updated = 0;

    for (const line of lines) {
      // Only resolve if dimensions are missing
      if (line.weightKg && line.lengthCm) continue;

      // Get vendorId from the PO
      let vendorId: number | null = null;
      if (line.purchaseOrderId) {
        const po = await storage.getPurchaseOrderById(line.purchaseOrderId);
        vendorId = po?.vendorId || null;
      }

      const dims = await resolveDimensionsForVariant(line.productVariantId, vendorId);
      if (!dims.weightKg && !dims.lengthCm) continue;

      const computed = computeLineTotals({
        qtyShipped: line.qtyShipped,
        cartonCount: line.cartonCount,
        weightKg: dims.weightKg,
        lengthCm: dims.lengthCm,
        widthCm: dims.widthCm,
        heightCm: dims.heightCm,
      });

      await storage.updateInboundShipmentLine(line.id, {
        weightKg: dims.weightKg,
        lengthCm: dims.lengthCm,
        widthCm: dims.widthCm,
        heightCm: dims.heightCm,
        ...computed,
      } as any);

      updated++;
    }

    await recomputeShipmentTotals(shipmentId);
    return { updated, total: lines.length };
  }

  async function importPackingList(shipmentId: number, rows: Array<{
    sku?: string;
    purchaseOrderLineId?: number;
    productVariantId?: number;
    qtyShipped: number;
    weightKg?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    cartonCount?: number;
  }>) {
    const shipment = await getShipment(shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot import to a closed or cancelled shipment");
    }

    const newLines: InsertInboundShipmentLine[] = [];
    const errors: Array<{ row: number; error: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.qtyShipped || row.qtyShipped <= 0) {
        errors.push({ row: i + 1, error: "Quantity must be > 0" });
        continue;
      }

      const computed = computeLineTotals({
        qtyShipped: row.qtyShipped,
        cartonCount: row.cartonCount,
        weightKg: row.weightKg != null ? String(row.weightKg) : null,
        lengthCm: row.lengthCm != null ? String(row.lengthCm) : null,
        widthCm: row.widthCm != null ? String(row.widthCm) : null,
        heightCm: row.heightCm != null ? String(row.heightCm) : null,
      });

      newLines.push({
        inboundShipmentId: shipmentId,
        purchaseOrderId: null,
        purchaseOrderLineId: row.purchaseOrderLineId || null,
        productVariantId: row.productVariantId || null,
        sku: row.sku || null,
        qtyShipped: row.qtyShipped,
        weightKg: row.weightKg != null ? String(row.weightKg) : null,
        lengthCm: row.lengthCm != null ? String(row.lengthCm) : null,
        widthCm: row.widthCm != null ? String(row.widthCm) : null,
        heightCm: row.heightCm != null ? String(row.heightCm) : null,
        ...computed,
        cartonCount: row.cartonCount || null,
      } as any);
    }

    const created = await storage.bulkCreateInboundShipmentLines(newLines);
    await recomputeShipmentTotals(shipmentId);

    return {
      imported: created.length,
      errors,
      lines: created,
    };
  }

  // ─── Cost management ───────────────────────────────────────────

  async function addCost(shipmentId: number, data: {
    costType: string;
    description?: string;
    estimatedCents?: number;
    actualCents?: number;
    currency?: string;
    exchangeRate?: string;
    allocationMethod?: string;
    costStatus?: string;
    invoiceNumber?: string;
    invoiceDate?: Date;
    dueDate?: Date;
    paidDate?: Date;
    vendorId?: number | null;
    performedByName?: string;
    notes?: string;
  }) {
    const shipment = await getShipment(shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot add costs to a closed or cancelled shipment");
    }

    // Coerce date strings to Date objects for Drizzle timestamp columns
    const coerced: any = { ...data };
    if (coerced.invoiceDate && typeof coerced.invoiceDate === "string") coerced.invoiceDate = new Date(coerced.invoiceDate);
    if (coerced.dueDate && typeof coerced.dueDate === "string") coerced.dueDate = new Date(coerced.dueDate);
    if (coerced.paidDate && typeof coerced.paidDate === "string") coerced.paidDate = new Date(coerced.paidDate);

    const cost = await storage.createInboundFreightCost({
      inboundShipmentId: shipmentId,
      ...coerced,
    } as any);

    await recomputeShipmentTotals(shipmentId);
    // Auto-run allocation so lines reflect updated costs immediately
    try { await runAllocation(shipmentId); } catch (_) { /* no lines yet is ok */ }
    return cost;
  }

  async function updateCost(costId: number, updates: Partial<InsertInboundFreightCost>) {
    const cost = await storage.getInboundFreightCostById(costId);
    if (!cost) throw new ShipmentTrackingError("Cost not found", 404);

    const shipment = await getShipment(cost.inboundShipmentId);
    if (shipment.status === "closed") {
      throw new ShipmentTrackingError("Cannot edit costs on a closed shipment");
    }

    // Coerce date strings to Date objects for Drizzle timestamp columns
    const coerced: any = { ...updates };
    if (coerced.invoiceDate && typeof coerced.invoiceDate === "string") coerced.invoiceDate = new Date(coerced.invoiceDate);
    if (coerced.dueDate && typeof coerced.dueDate === "string") coerced.dueDate = new Date(coerced.dueDate);
    if (coerced.paidDate && typeof coerced.paidDate === "string") coerced.paidDate = new Date(coerced.paidDate);

    const updated = await storage.updateInboundFreightCost(costId, coerced);
    await recomputeShipmentTotals(cost.inboundShipmentId);
    try { await runAllocation(cost.inboundShipmentId); } catch (_) { }
    return updated;
  }

  async function removeCost(costId: number) {
    const cost = await storage.getInboundFreightCostById(costId);
    if (!cost) throw new ShipmentTrackingError("Cost not found", 404);

    const shipment = await getShipment(cost.inboundShipmentId);
    if (shipment.status === "closed") {
      throw new ShipmentTrackingError("Cannot remove costs from a closed shipment");
    }

    await storage.deleteInboundFreightCost(costId);
    await recomputeShipmentTotals(cost.inboundShipmentId);
    try { await runAllocation(cost.inboundShipmentId); } catch (_) { }
    return true;
  }

  // ─── Allocation engine ─────────────────────────────────────────

  async function runAllocation(shipmentId: number): Promise<{
    allocations: Array<{
      lineId: number;
      sku: string | null;
      poUnitCostCents: number;
      freightCents: number;
      dutyCents: number;
      insuranceCents: number;
      otherCents: number;
      totalAllocatedCents: number;
      landedUnitCostCents: number;
    }>;
    totalAllocated: number;
  }> {
    const shipment = await getShipment(shipmentId);
    const lines = await storage.getInboundShipmentLines(shipmentId);
    const costs = await storage.getInboundFreightCosts(shipmentId);

    if (lines.length === 0) {
      throw new ShipmentTrackingError("No lines to allocate costs to");
    }

    // Clear previous allocations
    await storage.deleteAllocationsForShipment(shipmentId);

    // Per-line accumulators
    const lineAllocations = new Map<number, {
      freightCents: number;
      dutyCents: number;
      insuranceCents: number;
      otherCents: number;
    }>();
    for (const line of lines) {
      lineAllocations.set(line.id, { freightCents: 0, dutyCents: 0, insuranceCents: 0, otherCents: 0 });
    }

    const allNewAllocations: InsertInboundFreightAllocation[] = [];

    for (const cost of costs) {
      const effectiveAmount = cost.actualCents ?? cost.estimatedCents ?? 0;
      if (effectiveAmount === 0) continue;

      const { method } = resolveAllocationMethod(cost, shipment);
      const basisSummary = await buildAllocationBasis(lines, method);
      const basisValues = basisSummary.values;
      const basisTotal = basisSummary.basisTotal;

      // Allocate to each line
      let allocated = 0;
      let maxBasisIdx = 0;
      let maxBasis = 0;

      for (let i = 0; i < basisValues.length; i++) {
        const bv = basisValues[i];
        const share = bv.basis / basisTotal;
        const lineCents = Math.round(effectiveAmount * share);
        allocated += lineCents;

        if (bv.basis > maxBasis) {
          maxBasis = bv.basis;
          maxBasisIdx = i;
        }

        allNewAllocations.push({
          shipmentCostId: cost.id,
          inboundShipmentLineId: bv.lineId,
          allocationBasisValue: String(bv.basis),
          allocationBasisTotal: String(basisTotal),
          sharePercent: String(Math.round(share * 10000) / 100),
          allocatedCents: lineCents,
        } as any);

        // Accumulate by cost type category
        const lineAcc = lineAllocations.get(bv.lineId)!;
        const category = getCostCategory(cost.costType);
        if (category === "freight") lineAcc.freightCents += lineCents;
        else if (category === "duty") lineAcc.dutyCents += lineCents;
        else if (category === "insurance") lineAcc.insuranceCents += lineCents;
        else lineAcc.otherCents += lineCents;
      }

      // Rounding remainder → add to largest-basis line
      const remainder = effectiveAmount - allocated;
      if (remainder !== 0) {
        const lastAlloc = allNewAllocations[allNewAllocations.length - basisValues.length + maxBasisIdx];
        lastAlloc.allocatedCents = (lastAlloc.allocatedCents as number) + remainder;

        const lineAcc = lineAllocations.get(basisValues[maxBasisIdx].lineId)!;
        const category = getCostCategory(cost.costType);
        if (category === "freight") lineAcc.freightCents += remainder;
        else if (category === "duty") lineAcc.dutyCents += remainder;
        else if (category === "insurance") lineAcc.insuranceCents += remainder;
        else lineAcc.otherCents += remainder;
      }
    }

    // Bulk insert all allocations
    await storage.bulkCreateInboundFreightCostAllocations(allNewAllocations);

    // Update each line's allocated_cost_cents and landed_unit_cost_cents
    let totalAllocated = 0;
    const resultLines: any[] = [];

    for (const line of lines) {
      const acc = lineAllocations.get(line.id)!;
      const totalForLine = acc.freightCents + acc.dutyCents + acc.insuranceCents + acc.otherCents;
      totalAllocated += totalForLine;

      // Look up PO unit cost
      let poUnitCostCents = 0;
      if (line.purchaseOrderLineId) {
        const poLine = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId);
        poUnitCostCents = poLine?.unitCostCents || 0;
      }

      const totalCostCents = (poUnitCostCents * line.qtyShipped) + totalForLine;
      const landedUnitCostCents = line.qtyShipped > 0 ? Math.round(totalCostCents / line.qtyShipped) : 0;

      await storage.updateInboundShipmentLine(line.id, {
        allocatedCostCents: totalForLine,
        landedUnitCostCents,
      } as any);

      resultLines.push({
        lineId: line.id,
        sku: line.sku,
        poUnitCostCents,
        ...acc,
        totalAllocatedCents: totalForLine,
        landedUnitCostCents,
      });
    }

    return { allocations: resultLines, totalAllocated };
  }

  async function getAllocationStatus(shipmentId: number) {
    const shipment = await getShipment(shipmentId);
    const lines = await storage.getInboundShipmentLines(shipmentId);
    const costs = await storage.getInboundFreightCosts(shipmentId);
    const currentLineIds = new Set(lines.map((line) => line.id));
    const issues: Array<{
      severity: "blocker" | "warning";
      code: string;
      message: string;
      costId?: number;
      lineId?: number;
    }> = [];
    const costStatuses: any[] = [];

    let effectiveCostCents = 0;
    let allocatedCostCents = 0;
    let allocatableCostCount = 0;

    if (lines.length === 0) {
      issues.push({
        severity: "blocker",
        code: "no_lines",
        message: "Shipment has no lines to allocate costs to",
      });
    }

    for (const cost of costs) {
      const effectiveCents = cost.actualCents ?? cost.estimatedCents ?? 0;
      const { method, source } = resolveAllocationMethod(cost, shipment);
      const allocations = await storage.getInboundFreightCostAllocations(cost.id);
      const allocatedCents = allocations.reduce((sum: number, allocation: any) => sum + Number(allocation.allocatedCents || 0), 0);
      const staleAllocationCount = allocations.filter((allocation: any) => !currentLineIds.has(allocation.inboundShipmentLineId)).length;
      const basisSummary = lines.length > 0
        ? await buildAllocationBasis(lines, method)
        : { rawBasisTotal: 0, basisTotal: 0, usedFallback: false };

      effectiveCostCents += effectiveCents;
      allocatedCostCents += allocatedCents;
      if (effectiveCents !== 0) {
        allocatableCostCount += 1;
      }

      const missingDimLines = DIMENSIONAL_METHODS.has(method)
        ? lines.filter((line) => rawLineBasisForDimension(line, method) <= 0)
        : [];

      let status = "allocated";
      if (effectiveCents === 0) {
        status = "zero_amount";
      } else if (missingDimLines.length > 0) {
        status = "missing_dimensions";
        issues.push({
          severity: "blocker",
          code: "missing_dimensions",
          costId: cost.id,
          message: `${cost.costType} is allocated by ${DIMENSION_LABELS[method] ?? method}, but ${missingDimLines.length} line(s) are missing it: ${missingDimLines.map((line) => line.sku || `line ${line.id}`).join(", ")}. Enter dimensions (or use Resolve Dimensions) before closing.`,
        });
      } else if (allocations.length === 0) {
        status = "needs_allocation";
        issues.push({
          severity: "blocker",
          code: "cost_not_allocated",
          costId: cost.id,
          message: `${cost.costType} cost has not been allocated`,
        });
      } else if (staleAllocationCount > 0) {
        status = "stale_allocation";
        issues.push({
          severity: "blocker",
          code: "stale_allocation_line",
          costId: cost.id,
          message: `${cost.costType} cost has allocations tied to missing shipment lines`,
        });
      } else if (allocatedCents !== effectiveCents) {
        status = "allocation_mismatch";
        issues.push({
          severity: "blocker",
          code: "allocation_total_mismatch",
          costId: cost.id,
          message: `${cost.costType} cost allocation total does not match the effective cost`,
        });
      } else if (basisSummary.usedFallback && method !== "by_line_count") {
        status = "allocated_with_fallback";
        issues.push({
          severity: "warning",
          code: "allocation_basis_fallback",
          costId: cost.id,
          message: `${cost.costType} used even split because ${method} basis values were zero`,
        });
      }

      costStatuses.push({
        costId: cost.id,
        costType: cost.costType,
        description: cost.description,
        effectiveCents,
        allocatedCents,
        allocationCount: allocations.length,
        method,
        methodSource: source,
        rawBasisTotal: basisSummary.rawBasisTotal,
        basisTotal: basisSummary.basisTotal,
        usedFallback: basisSummary.usedFallback,
        status,
      });
    }

    const blockerCount = issues.filter((issue) => issue.severity === "blocker").length;
    const warningCount = issues.filter((issue) => issue.severity === "warning").length;
    const allocationStatus =
      lines.length === 0
        ? "blocked"
        : allocatableCostCount === 0
          ? "no_costs"
          : blockerCount > 0
            ? "needs_allocation"
            : warningCount > 0
              ? "allocated_with_warnings"
              : "allocated";

    return {
      shipmentId,
      status: allocationStatus,
      lineCount: lines.length,
      costCount: costs.length,
      allocatableCostCount,
      effectiveCostCents,
      allocatedCostCents,
      unallocatedCents: effectiveCostCents - allocatedCostCents,
      issueCount: issues.length,
      blockerCount,
      warningCount,
      costs: costStatuses,
      issues,
    };
  }

  async function getLandedCostHealth(options: { limit?: number } = {}) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 250);
    const shipments = await storage.getInboundShipments({
      status: ["costing", "closed"],
      limit,
    });
    const items: Array<{
      id: string;
      type: string;
      severity: "critical" | "warning";
      shipmentId: number;
      shipmentNumber: string | null;
      shipmentStatus: string;
      detail: string;
      action: string;
      provisionalLotCount?: number;
      missingSnapshotLineIds?: number[];
      blockerCount?: number;
      warningCount?: number;
    }> = [];
    const counts = {
      allocationBlockers: 0,
      allocationWarnings: 0,
      pendingFinalization: 0,
      finalizedNotPushed: 0,
      staleProvisionalLots: 0,
    };

    for (const shipment of shipments) {
      const lines = await storage.getInboundShipmentLines(shipment.id);
      const provisionalLots = await storage.getProvisionalLotsByShipment(shipment.id);
      const allocation = await getAllocationStatus(shipment.id);
      const missingSnapshotLineIds: number[] = [];
      let finalizedLineCount = 0;

      for (const line of lines) {
        const snapshots = await storage.getLandedCostSnapshots(line.id);
        if (snapshots.length > 0 && snapshots[0]?.landedUnitCostCents != null) {
          finalizedLineCount += 1;
        } else {
          missingSnapshotLineIds.push(line.id);
        }
      }

      if (allocation.blockerCount > 0) {
        counts.allocationBlockers += 1;
        items.push({
          id: `allocation_blocked-${shipment.id}`,
          type: "allocation_blocked",
          severity: "critical",
          shipmentId: shipment.id,
          shipmentNumber: shipment.shipmentNumber ?? null,
          shipmentStatus: shipment.status,
          detail: `${allocation.blockerCount} allocation blocker${allocation.blockerCount === 1 ? "" : "s"} need review before landed cost can be trusted`,
          action: "review_allocation",
          blockerCount: allocation.blockerCount,
        });
      } else if (allocation.warningCount > 0) {
        counts.allocationWarnings += 1;
        items.push({
          id: `allocation_warning-${shipment.id}`,
          type: "allocation_warning",
          severity: "warning",
          shipmentId: shipment.id,
          shipmentNumber: shipment.shipmentNumber ?? null,
          shipmentStatus: shipment.status,
          detail: `${allocation.warningCount} allocation warning${allocation.warningCount === 1 ? "" : "s"} present`,
          action: "review_allocation",
          warningCount: allocation.warningCount,
        });
      }

      if (lines.length > 0 && allocation.allocatableCostCount > 0 && missingSnapshotLineIds.length > 0) {
        counts.pendingFinalization += 1;
        items.push({
          id: `pending_finalization-${shipment.id}`,
          type: "pending_finalization",
          severity: shipment.status === "closed" ? "critical" : "warning",
          shipmentId: shipment.id,
          shipmentNumber: shipment.shipmentNumber ?? null,
          shipmentStatus: shipment.status,
          detail: `${missingSnapshotLineIds.length} shipment line${missingSnapshotLineIds.length === 1 ? "" : "s"} do not have finalized landed cost snapshots`,
          action: "finalize_landed_cost",
          missingSnapshotLineIds,
        });
      }

      if (provisionalLots.length > 0) {
        if (shipment.status === "closed") {
          counts.staleProvisionalLots += 1;
          items.push({
            id: `stale_provisional_lots-${shipment.id}`,
            type: "stale_provisional_lots",
            severity: "critical",
            shipmentId: shipment.id,
            shipmentNumber: shipment.shipmentNumber ?? null,
            shipmentStatus: shipment.status,
            detail: `${provisionalLots.length} provisional lot${provisionalLots.length === 1 ? "" : "s"} remain after shipment close`,
            action: finalizedLineCount === lines.length ? "push_costs_to_lots" : "finalize_landed_cost",
            provisionalLotCount: provisionalLots.length,
          });
        } else if (finalizedLineCount === lines.length && lines.length > 0) {
          counts.finalizedNotPushed += 1;
          items.push({
            id: `finalized_not_pushed-${shipment.id}`,
            type: "finalized_not_pushed",
            severity: "warning",
            shipmentId: shipment.id,
            shipmentNumber: shipment.shipmentNumber ?? null,
            shipmentStatus: shipment.status,
            detail: `${provisionalLots.length} provisional lot${provisionalLots.length === 1 ? "" : "s"} can receive finalized landed cost`,
            action: "push_costs_to_lots",
            provisionalLotCount: provisionalLots.length,
          });
        }
      }
    }

    const critical = items.filter((item) => item.severity === "critical").length;
    const warning = items.filter((item) => item.severity === "warning").length;
    const status = critical > 0 ? "critical" : warning > 0 ? "warning" : "healthy";

    return {
      status,
      scannedShipments: shipments.length,
      critical,
      warning,
      counts,
      items: items.slice(0, limit),
    };
  }

  function getCostCategory(costType: string): "freight" | "duty" | "insurance" | "other" {
    if (costType === "freight" || costType === "drayage" || costType === "port_handling" || costType === "dimensions_adjustment") return "freight";
    if (costType === "duty" || costType === "brokerage") return "duty";
    if (costType === "insurance") return "insurance";
    return "other";
  }

  function nullableNumber(value: unknown): number | null {
    if (value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function sameNullableNumber(left: unknown, right: unknown): boolean {
    return nullableNumber(left) === nullableNumber(right);
  }

  function landedSnapshotMatches(existing: any, next: InsertLandedCostSnapshot): boolean {
    return (
      sameNullableNumber(existing.inboundShipmentLineId, (next as any).inboundShipmentLineId) &&
      sameNullableNumber(existing.purchaseOrderLineId, (next as any).purchaseOrderLineId) &&
      sameNullableNumber(existing.productVariantId, (next as any).productVariantId) &&
      sameNullableNumber(existing.poUnitCostCents, (next as any).poUnitCostCents) &&
      sameNullableNumber(existing.freightAllocatedCents, (next as any).freightAllocatedCents) &&
      sameNullableNumber(existing.dutyAllocatedCents, (next as any).dutyAllocatedCents) &&
      sameNullableNumber(existing.insuranceAllocatedCents, (next as any).insuranceAllocatedCents) &&
      sameNullableNumber(existing.otherAllocatedCents, (next as any).otherAllocatedCents) &&
      sameNullableNumber(existing.totalLandedCostCents, (next as any).totalLandedCostCents) &&
      sameNullableNumber(existing.landedUnitCostCents, (next as any).landedUnitCostCents) &&
      sameNullableNumber(existing.qty, (next as any).qty)
    );
  }

  async function finalizeAllocations(shipmentId: number, userId?: string) {
    const shipment = await getShipment(shipmentId);
    if (!["costing", "closed"].includes(shipment.status)) {
      throw new ShipmentTrackingError("Landed costs can only be finalized while shipment is in costing or closed status");
    }

    const lines = await storage.getInboundShipmentLines(shipmentId);

    if (lines.length === 0) {
      throw new ShipmentTrackingError("No lines to finalize");
    }

    // Run allocation first to ensure fresh numbers
    await runAllocation(shipmentId);

    // Re-fetch lines after allocation
    const updatedLines = await storage.getInboundShipmentLines(shipmentId);

    // Fetch old snapshots before deleting
    const oldSnapshotsByLine = new Map<number, any>();
    for (const line of updatedLines) {
      const snaps = await storage.getLandedCostSnapshots(line.id);
      if (snaps.length > 0) {
        oldSnapshotsByLine.set(line.id, snaps[0]);
      }
    }

    const snapshots: InsertLandedCostSnapshot[] = [];
    const adjustments: any[] = [];

    for (const line of updatedLines) {
      // Get per-category breakdown
      const allocations = await storage.getAllocationsForLine(line.id);
      let freightCents = 0, dutyCents = 0, insuranceCents = 0, otherCents = 0;

      for (const alloc of allocations) {
        const cost = await storage.getInboundFreightCostById(alloc.shipmentCostId);
        if (!cost) continue;
        const category = getCostCategory(cost.costType);
        const cents = alloc.allocatedCents || 0;
        if (category === "freight") freightCents += cents;
        else if (category === "duty") dutyCents += cents;
        else if (category === "insurance") insuranceCents += cents;
        else otherCents += cents;
      }

      let poUnitCostCents = 0;
      if (line.purchaseOrderLineId) {
        const poLine = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId);
        poUnitCostCents = poLine?.unitCostCents || 0;
      }

      const totalLandedCostCents = (poUnitCostCents * line.qtyShipped) + freightCents + dutyCents + insuranceCents + otherCents;
      const landedUnitCostCents = line.qtyShipped > 0 ? Math.round(totalLandedCostCents / line.qtyShipped) : 0;

      // H6: Landed-cost re-allocation must not retroactively mutate closed lines
      if (shipment.status === "closed") {
        const oldSnap = oldSnapshotsByLine.get(line.id);
        if (oldSnap && oldSnap.totalLandedCostCents !== totalLandedCostCents) {
          const adjustmentCents = totalLandedCostCents - oldSnap.totalLandedCostCents;
          
          adjustments.push({
            inboundShipmentLineId: line.id,
            purchaseOrderLineId: line.purchaseOrderLineId,
            adjustmentAmountCents: adjustmentCents,
            reason: "Post-close landed cost reallocation",
            createdBy: userId || "system",
          });
        }
      }

      snapshots.push({
        inboundShipmentLineId: line.id,
        purchaseOrderLineId: line.purchaseOrderLineId,
        productVariantId: line.productVariantId,
        poUnitCostCents,
        freightAllocatedCents: freightCents,
        dutyAllocatedCents: dutyCents,
        insuranceAllocatedCents: insuranceCents,
        otherAllocatedCents: otherCents,
        totalLandedCostCents,
        landedUnitCostCents,
        qty: line.qtyShipped,
        finalizedAt: new Date(),
      } as any);
    }

    const unchanged =
      snapshots.length === updatedLines.length &&
      snapshots.every((snapshot: any) => {
        const oldSnap = oldSnapshotsByLine.get(snapshot.inboundShipmentLineId);
        return oldSnap && landedSnapshotMatches(oldSnap, snapshot);
      });

    if (unchanged) {
      return { finalized: snapshots.length, unchanged: true, adjustments: 0 };
    }

    await storage.deleteLandedCostSnapshotsForShipment(shipmentId);
    for (const adjustment of adjustments) {
      await storage.createLandedCostAdjustment(adjustment);
    }
    await storage.bulkCreateLandedCostSnapshots(snapshots);
    return { finalized: snapshots.length, unchanged: false, adjustments: adjustments.length };
  }

  // ─── Receiving integration ─────────────────────────────────────

  /**
   * After costs are finalized, push landed costs to provisional lots.
   * Called when closing the shipment or manually triggered.
   */
  async function pushLandedCostsToLots(shipmentId: number) {
    const shipment = await getShipment(shipmentId);
    if (shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot push landed costs for a cancelled shipment");
    }

    const lots = await storage.getProvisionalLotsByShipment(shipmentId);
    if (lots.length === 0) return { updated: 0, total: 0, skipped: [] };

    const lines = await storage.getInboundShipmentLines(shipmentId);
    // Build finalized landed cost keyed by PO LINE. Snapshots/shipment lines are
    // product-level (purchase_order_line_id) and lots are variant-level (case), so
    // po_line is the durable join — the old variant-keyed match never matched
    // product-level lines. Carry the NON-PRODUCT landed component
    // (freight+duty+insurance+other) and qty so it can be allocated exactly to each
    // lot's variant unit.
    const finalizedByPoLine = new Map<number, { landedNonProductCents: number; qty: number; lineIds: number[] }>();
    const unfinalizedPoLines = new Set<number>();

    for (const line of lines) {
      const poLineId = Number(line.purchaseOrderLineId);
      if (!Number.isInteger(poLineId) || poLineId <= 0) continue;

      const snapshots = await storage.getLandedCostSnapshots(line.id);
      const snapshot = snapshots[0];
      if (!snapshot || snapshot.totalLandedCostCents == null) {
        unfinalizedPoLines.add(poLineId);
        continue;
      }

      const qty = Number(snapshot.qty) || 0;
      const nonProduct = Math.max(0,
        Number(snapshot.freightAllocatedCents || 0)
        + Number(snapshot.dutyAllocatedCents || 0)
        + Number(snapshot.insuranceAllocatedCents || 0)
        + Number(snapshot.otherAllocatedCents || 0),
      );
      if (!Number.isFinite(nonProduct) || qty <= 0) {
        unfinalizedPoLines.add(poLineId);
        continue;
      }

      const existing = finalizedByPoLine.get(poLineId);
      if (existing) {
        // Same PO line across >1 line of this shipment: sum landed + qty.
        existing.landedNonProductCents += nonProduct;
        existing.qty += qty;
        existing.lineIds.push(line.id);
      } else {
        finalizedByPoLine.set(poLineId, { landedNonProductCents: nonProduct, qty, lineIds: [line.id] });
      }
    }

    let updated = 0;
    const skipped: Array<{
      lotId: number;
      productVariantId: number | null;
      reason: string;
      lineIds?: number[];
    }> = [];

    for (const lot of lots) {
      const poLineId = Number((lot as any).poLineId);
      if (!Number.isInteger(poLineId) || poLineId <= 0) {
        skipped.push({ lotId: lot.id, productVariantId: lot.productVariantId ?? null, reason: "lot_missing_po_line" });
        continue;
      }

      const finalized = finalizedByPoLine.get(poLineId);
      if (!finalized) {
        skipped.push({
          lotId: lot.id,
          productVariantId: lot.productVariantId,
          reason: unfinalizedPoLines.has(poLineId) ? "landed_cost_not_finalized" : "no_matching_finalized_landed_cost",
        });
        continue;
      }

      // Allocate the line's non-product landed cost to THIS lot's variant unit (case),
      // in MILLS: round_half_up(nonProductCents × 100 × units_per_variant ÷ qty). The lot
      // already carries product + packaging mills from receive; set landed and recompute
      // total = product + packaging + landed (cents columns derived as display mirrors).
      const variant = await storage.getProductVariantById(Number(lot.productVariantId));
      const { landedCostMills, totalMills, totalCents } = computeLotLandedMills({
        landedNonProductCents: finalized.landedNonProductCents,
        unitsPerVariant: Number(variant?.unitsPerVariant) || 1,
        qty: finalized.qty,
        poUnitCostMills: Number((lot as any).poUnitCostMills) || 0,
        packagingCostMills: Number((lot as any).packagingCostMills) || 0,
      });

      try {
        await db.execute(sqlTag`
          UPDATE inventory.inventory_lots SET
            landed_cost_mills = ${landedCostMills},
            total_unit_cost_mills = ${totalMills},
            unit_cost_mills = ${totalMills},
            landed_cost_cents = ${millsToCents(landedCostMills)},
            total_unit_cost_cents = ${totalCents},
            unit_cost_cents = ${totalCents},
            cost_provisional = 0,
            cost_source = CASE WHEN cost_source = 'po' THEN 'po_landed' ELSE cost_source END
          WHERE id = ${lot.id}
        `);
      } catch (e: any) {
        console.warn(`[ShipmentTracking] landed-cost lot update for lot ${lot.id} failed: ${e.message}`);
        skipped.push({ lotId: lot.id, productVariantId: lot.productVariantId, reason: "lot_update_failed", lineIds: finalized.lineIds });
        continue;
      }

      // Cascade to any order_item_costs already booked from this lot (rare — provisional
      // lots are usually unsold) so shipped COGS reflects the finalized landed cost. The
      // lot's per-variant-unit total now includes freight; mirror it (mills + cents).
      try {
        await db.execute(sqlTag`
          UPDATE oms.order_item_costs
          SET unit_cost_mills = ${totalMills},
              total_cost_mills = qty * ${totalMills},
              unit_cost_cents = ${totalCents},
              total_cost_cents = qty * ${totalCents}
          WHERE inventory_lot_id = ${lot.id}
            AND unit_cost_mills != ${totalMills}
        `);
      } catch (e: any) {
        console.warn(`[ShipmentTracking] COGS cascade for lot ${lot.id} failed (non-fatal): ${e.message}`);
      }

      updated++;
    }

    return { updated, total: lots.length, skipped };
  }

  /**
   * Get the landed unit cost for a PO line (used by receiving.close).
   * Returns null if no finalized landed cost exists.
   */
  async function getLandedCostForPoLine(purchaseOrderLineId: number): Promise<number | null> {
    const snapshot = await storage.getLandedCostSnapshotByPoLine(purchaseOrderLineId);
    return snapshot?.landedUnitCostCents ?? null;
  }

  /**
   * Create a receiving order from a shipment (convenience).
   * Sets up the receiving order linked to the shipment.
   */
  async function getShipmentForReceiving(shipmentId: number) {
    const shipment = await getShipment(shipmentId);
    const lines = await storage.getInboundShipmentLines(shipmentId);

    // Build lookup: has landed cost been finalized?
    const hasSnapshots = new Map<number, boolean>();
    for (const line of lines) {
      const snaps = await storage.getLandedCostSnapshots(line.id);
      hasSnapshots.set(line.id, snaps.length > 0);
    }

    return {
      shipment,
      lines,
      costFinalized: Array.from(hasSnapshots.values()).every(v => v),
      lineCount: lines.length,
      totalQty: lines.reduce((s, l) => s + l.qtyShipped, 0),
    };
  }

  // ─── Public API ────────────────────────────────────────────────

  return {
    // CRUD
    createShipment,
    getShipment,
    getShipments: (filters?: any) => storage.getInboundShipments(filters),
    getShipmentsCount: (filters?: any) => storage.getInboundShipmentsCount(filters),
    getShipmentByNumber: (num: string) => storage.getInboundShipmentByNumber(num),
    updateShipment,
    deleteShipment,

    // Status transitions
    book,
    markInTransit,
    markAtPort,
    markCustomsClearance,
    markDelivered,
    startCosting,
    close,
    cancel,

    // Lines
    addLinesFromPO,
    removeLine,
    updateLineDimensions,
    resolveDimensionsForShipment,
    importPackingList,
    getLines: (shipmentId: number) => storage.getInboundShipmentLines(shipmentId),
    getEnrichedLines: getEnrichedLines,
    getLinesByPo: (poId: number) => storage.getInboundShipmentLinesByPo(poId),

    // Costs
    addCost,
    updateCost,
    removeCost,
    getCost: (costId: number) => storage.getInboundFreightCostById(costId),
    getCosts: async (shipmentId: number) => {
      const rows = await db
        .select({
          cost: inboundFreightCosts,
          counterpartyName: vendors.name,
        })
        .from(inboundFreightCosts)
        .leftJoin(vendors, eq(vendors.id, inboundFreightCosts.vendorId))
        .where(eq(inboundFreightCosts.inboundShipmentId, shipmentId));
      return rows.map((r: any) => ({ ...r.cost, vendorName: r.counterpartyName }));
    },

    // Allocation
    runAllocation,
    getAllocationStatus,
    getLandedCostHealth,
    finalizeAllocations,

    // Receiving integration
    pushLandedCostsToLots,
    getLandedCostForPoLine,
    getShipmentForReceiving,

    // Cross-references
    getShipmentsByPo: (poId: number) => storage.getInboundShipmentsByPo(poId),
    getStatusHistory: (shipmentId: number) => storage.getInboundShipmentStatusHistory(shipmentId),
  };
}
