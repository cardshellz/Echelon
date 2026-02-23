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
  ShipmentCost,
  InsertShipmentCost,
  InsertShipmentCostAllocation,
  InsertLandedCostSnapshot,
  InboundShipmentStatusHistory,
  InventoryLot,
} from "@shared/schema";

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
  getShipmentCosts(inboundShipmentId: number): Promise<ShipmentCost[]>;
  getShipmentCostById(id: number): Promise<ShipmentCost | undefined>;
  createShipmentCost(data: InsertShipmentCost): Promise<ShipmentCost>;
  updateShipmentCost(id: number, updates: Partial<InsertShipmentCost>): Promise<ShipmentCost | null>;
  deleteShipmentCost(id: number): Promise<boolean>;
  // Allocations
  getShipmentCostAllocations(shipmentCostId: number): Promise<any[]>;
  getAllocationsForLine(inboundShipmentLineId: number): Promise<any[]>;
  createShipmentCostAllocation(data: InsertShipmentCostAllocation): Promise<any>;
  bulkCreateShipmentCostAllocations(allocations: InsertShipmentCostAllocation[]): Promise<any[]>;
  deleteAllocationsForShipment(inboundShipmentId: number): Promise<void>;
  // Landed cost snapshots
  getLandedCostSnapshots(inboundShipmentLineId: number): Promise<any[]>;
  getLandedCostSnapshotByPoLine(purchaseOrderLineId: number): Promise<any>;
  createLandedCostSnapshot(data: InsertLandedCostSnapshot): Promise<any>;
  bulkCreateLandedCostSnapshots(snapshots: InsertLandedCostSnapshot[]): Promise<any[]>;
  deleteLandedCostSnapshotsForShipment(inboundShipmentId: number): Promise<void>;
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
  // Product variant dimensions
  getProductVariantById?(id: number): Promise<any>;
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

// Cost types with hard-coded allocation method overrides
const COST_TYPE_ALLOCATION_OVERRIDES: Record<string, string> = {
  duty: "by_value",
  brokerage: "by_line_count",
  inspection: "by_line_count",
};

// ── Service factory ─────────────────────────────────────────────────

export type ShipmentTrackingService = ReturnType<typeof createShipmentTrackingService>;

export function createShipmentTrackingService(_db: any, storage: Storage) {

  // ─── Private helpers ────────────────────────────────────────────

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
    const costs = await storage.getShipmentCosts(shipmentId);

    let totalWeightKg = 0;
    let totalVolumeCbm = 0;
    let totalGrossVolumeCbm = 0;
    let totalPieces = 0;
    let totalCartons = 0;

    for (const line of lines) {
      totalWeightKg += Number(line.totalWeightKg || 0);
      totalVolumeCbm += Number(line.totalVolumeCbm || 0);
      totalGrossVolumeCbm += Number(line.grossVolumeCbm || 0);
      totalPieces += line.qtyShipped;
      totalCartons += line.cartonCount || 0;
    }

    let estimatedTotalCostCents = 0;
    let actualTotalCostCents = 0;
    for (const cost of costs) {
      estimatedTotalCostCents += cost.estimatedCents || 0;
      actualTotalCostCents += cost.actualCents || 0;
    }

    await storage.updateInboundShipment(shipmentId, {
      totalWeightKg: String(totalWeightKg),
      totalVolumeCbm: String(totalVolumeCbm),
      totalGrossVolumeCbm: String(totalGrossVolumeCbm),
      totalPieces,
      totalCartons,
      estimatedTotalCostCents,
      actualTotalCostCents,
    } as any);
  }

  function computeLineTotals(line: { qtyShipped: number; weightKg?: string | null; lengthCm?: string | null; widthCm?: string | null; heightCm?: string | null }) {
    const qty = line.qtyShipped;
    const weightKg = Number(line.weightKg || 0);
    const lengthCm = Number(line.lengthCm || 0);
    const widthCm = Number(line.widthCm || 0);
    const heightCm = Number(line.heightCm || 0);

    const totalWeightKg = qty * weightKg;
    // Net volume: L * W * H in cm → CBM (divide by 1,000,000)
    const unitVolumeCbm = (lengthCm * widthCm * heightCm) / 1_000_000;
    const totalVolumeCbm = qty * unitVolumeCbm;
    // Chargeable weight: max(actual, volumetric) — IATA formula: L*W*H / 5000 per unit
    const volumetricWeightKg = (lengthCm * widthCm * heightCm) / 5000;
    const chargeableWeightKg = qty * Math.max(weightKg, volumetricWeightKg);

    return {
      totalWeightKg: String(totalWeightKg),
      totalVolumeCbm: String(totalVolumeCbm),
      chargeableWeightKg: String(chargeableWeightKg),
    };
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
    const shipmentNumber = await storage.generateShipmentNumber();
    const allocationMethodDefault = data.mode ? MODE_DEFAULT_ALLOCATION[data.mode] || "by_volume" : "by_volume";

    const shipment = await storage.createInboundShipment({
      shipmentNumber,
      status: "draft",
      allocationMethodDefault,
      createdBy: userId || null,
      ...data,
    } as any);

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
    // Finalize allocations before closing
    await finalizeAllocations(id, userId);
    return transitionTo(id, "closed", userId, notes || "Shipment closed — landed costs finalized");
  }

  async function cancel(id: number, userId?: string, reason?: string) {
    if (!reason) throw new ShipmentTrackingError("Cancellation reason is required");
    return transitionTo(id, "cancelled", userId, `Cancelled: ${reason}`);
  }

  // ─── Line management ───────────────────────────────────────────

  async function addLinesFromPO(shipmentId: number, purchaseOrderId: number, lineIds?: number[]) {
    const shipment = await getShipment(shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot add lines to a closed or cancelled shipment");
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new ShipmentTrackingError("Purchase order not found", 404);

    const poLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const linesToAdd = lineIds
      ? poLines.filter((l: any) => lineIds.includes(l.id))
      : poLines;

    if (linesToAdd.length === 0) {
      throw new ShipmentTrackingError("No PO lines to add");
    }

    const newLines: InsertInboundShipmentLine[] = [];
    for (const poLine of linesToAdd) {
      // Try to resolve dimensions: vendor_products first, then product_variants
      const dims = await resolveDimensionsForVariant(poLine.productVariantId, po.vendorId);

      const computed = computeLineTotals({
        qtyShipped: poLine.qtyOrdered ?? poLine.qty ?? 0,
        weightKg: dims.weightKg,
        lengthCm: dims.lengthCm,
        widthCm: dims.widthCm,
        heightCm: dims.heightCm,
      });

      newLines.push({
        inboundShipmentId: shipmentId,
        purchaseOrderId,
        purchaseOrderLineId: poLine.id,
        productVariantId: poLine.productVariantId,
        sku: poLine.sku || null,
        qtyShipped: poLine.qtyOrdered ?? poLine.qty ?? 0,
        weightKg: dims.weightKg,
        lengthCm: dims.lengthCm,
        widthCm: dims.widthCm,
        heightCm: dims.heightCm,
        ...computed,
      } as any);
    }

    const created = await storage.bulkCreateInboundShipmentLines(newLines);
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
    grossVolumeCbm?: string;
    cartonCount?: number;
    palletCount?: number;
    qtyShipped?: number;
    notes?: string;
  }) {
    const line = await storage.getInboundShipmentLineById(lineId);
    if (!line) throw new ShipmentTrackingError("Shipment line not found", 404);

    // Recompute totals if quantity or dimensions changed
    const qtyShipped = updates.qtyShipped ?? line.qtyShipped;
    const weightKg = updates.weightKg ?? line.weightKg;
    const lengthCm = updates.lengthCm ?? line.lengthCm;
    const widthCm = updates.widthCm ?? line.widthCm;
    const heightCm = updates.heightCm ?? line.heightCm;

    const computed = computeLineTotals({ qtyShipped, weightKg, lengthCm, widthCm, heightCm });

    await storage.updateInboundShipmentLine(lineId, {
      ...updates,
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
    if (productVariantId && storage.getProductVariantById) {
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
    grossVolumeCbm?: number;
    cartonCount?: number;
    palletCount?: number;
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
        grossVolumeCbm: row.grossVolumeCbm != null ? String(row.grossVolumeCbm) : null,
        cartonCount: row.cartonCount || null,
        palletCount: row.palletCount || null,
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
    vendorName?: string;
    notes?: string;
  }) {
    const shipment = await getShipment(shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      throw new ShipmentTrackingError("Cannot add costs to a closed or cancelled shipment");
    }

    const cost = await storage.createShipmentCost({
      inboundShipmentId: shipmentId,
      ...data,
    } as any);

    await recomputeShipmentTotals(shipmentId);
    return cost;
  }

  async function updateCost(costId: number, updates: Partial<InsertShipmentCost>) {
    const cost = await storage.getShipmentCostById(costId);
    if (!cost) throw new ShipmentTrackingError("Cost not found", 404);

    const shipment = await getShipment(cost.inboundShipmentId);
    if (shipment.status === "closed") {
      throw new ShipmentTrackingError("Cannot edit costs on a closed shipment");
    }

    const updated = await storage.updateShipmentCost(costId, updates);
    await recomputeShipmentTotals(cost.inboundShipmentId);
    return updated;
  }

  async function removeCost(costId: number) {
    const cost = await storage.getShipmentCostById(costId);
    if (!cost) throw new ShipmentTrackingError("Cost not found", 404);

    const shipment = await getShipment(cost.inboundShipmentId);
    if (shipment.status === "closed") {
      throw new ShipmentTrackingError("Cannot remove costs from a closed shipment");
    }

    await storage.deleteShipmentCost(costId);
    await recomputeShipmentTotals(cost.inboundShipmentId);
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
    const costs = await storage.getShipmentCosts(shipmentId);

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

    const allNewAllocations: InsertShipmentCostAllocation[] = [];

    for (const cost of costs) {
      const effectiveAmount = cost.actualCents ?? cost.estimatedCents ?? 0;
      if (effectiveAmount === 0) continue;

      // Determine allocation method (priority: cost-type override → cost-level override → shipment default → mode default)
      const method = COST_TYPE_ALLOCATION_OVERRIDES[cost.costType]
        || cost.allocationMethod
        || shipment.allocationMethodDefault
        || "by_volume";

      // Compute per-line basis values
      const basisValues: Array<{ lineId: number; basis: number }> = [];
      let basisTotal = 0;

      for (const line of lines) {
        let basis = 0;
        switch (method) {
          case "by_volume":
            // Prefer gross volume, fall back to net volume
            basis = Number(line.grossVolumeCbm || 0) || Number(line.totalVolumeCbm || 0);
            break;
          case "by_chargeable_weight":
            basis = Number(line.chargeableWeightKg || 0);
            break;
          case "by_weight":
            basis = Number(line.totalWeightKg || 0);
            break;
          case "by_value":
            // PO line cost × qty shipped
            if (line.purchaseOrderLineId) {
              const poLine = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId);
              basis = (poLine?.unitCostCents || 0) * line.qtyShipped;
            }
            break;
          case "by_line_count":
            basis = 1;
            break;
          default:
            basis = 1; // Fallback to even split
        }
        basisValues.push({ lineId: line.id, basis });
        basisTotal += basis;
      }

      // Fallback to even split if all basis values are 0
      if (basisTotal === 0) {
        for (const bv of basisValues) bv.basis = 1;
        basisTotal = basisValues.length;
      }

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
    await storage.bulkCreateShipmentCostAllocations(allNewAllocations);

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

  function getCostCategory(costType: string): "freight" | "duty" | "insurance" | "other" {
    if (costType === "freight" || costType === "drayage" || costType === "port_handling") return "freight";
    if (costType === "duty") return "duty";
    if (costType === "insurance") return "insurance";
    return "other";
  }

  async function finalizeAllocations(shipmentId: number, userId?: string) {
    const shipment = await getShipment(shipmentId);
    const lines = await storage.getInboundShipmentLines(shipmentId);

    if (lines.length === 0) {
      throw new ShipmentTrackingError("No lines to finalize");
    }

    // Run allocation first to ensure fresh numbers
    await runAllocation(shipmentId);

    // Re-fetch lines after allocation
    const updatedLines = await storage.getInboundShipmentLines(shipmentId);

    // Delete existing snapshots and create new ones
    await storage.deleteLandedCostSnapshotsForShipment(shipmentId);

    const snapshots: InsertLandedCostSnapshot[] = [];

    for (const line of updatedLines) {
      // Get per-category breakdown
      const allocations = await storage.getAllocationsForLine(line.id);
      let freightCents = 0, dutyCents = 0, insuranceCents = 0, otherCents = 0;

      for (const alloc of allocations) {
        const cost = await storage.getShipmentCostById(alloc.shipmentCostId);
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

    await storage.bulkCreateLandedCostSnapshots(snapshots);
    return { finalized: snapshots.length };
  }

  // ─── Receiving integration ─────────────────────────────────────

  /**
   * After costs are finalized, push landed costs to provisional lots.
   * Called when closing the shipment or manually triggered.
   */
  async function pushLandedCostsToLots(shipmentId: number) {
    const lots = await storage.getProvisionalLotsByShipment(shipmentId);
    if (lots.length === 0) return { updated: 0 };

    const lines = await storage.getInboundShipmentLines(shipmentId);
    let updated = 0;

    for (const lot of lots) {
      // Find the matching shipment line via PO line or variant
      const matchingLine = lines.find(l =>
        l.productVariantId === lot.productVariantId,
      );

      if (!matchingLine?.landedUnitCostCents) continue;

      await storage.updateInventoryLot(lot.id, {
        unitCostCents: matchingLine.landedUnitCostCents,
        costProvisional: 0,
      });
      updated++;
    }

    return { updated, total: lots.length };
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
    getLinesByPo: (poId: number) => storage.getInboundShipmentLinesByPo(poId),

    // Costs
    addCost,
    updateCost,
    removeCost,
    getCosts: (shipmentId: number) => storage.getShipmentCosts(shipmentId),

    // Allocation
    runAllocation,
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
