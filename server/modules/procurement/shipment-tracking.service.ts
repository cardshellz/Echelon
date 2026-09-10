import { buildShipmentAllocationBasis, resolveShipmentAllocationMethod, shipmentAllocationBasisMatches, DIMENSIONAL_ALLOCATION_METHODS } from "./domain/shipment-allocation-basis";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { recordShipmentCostRevisions, applyShipmentCostRevisions } from "./shipment-cost-application.service";
import { COGSService } from "../inventory/cogs.service";
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

import { createShipmentLineMutationOwner, assertShipmentLineHistoryMutable } from "./shipment-line-mutations.service";
import { versionShipmentLine } from "./shipment-line-version";
import type { ShipmentPurchaseOrderReference } from "@shared/procurement/shipment-purchase-orders";
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
import { inboundShipmentLines, inboundFreightCosts, vendors, auditEvents } from "@shared/schema";
import { centsToMills, millsToCents, perUnitMills } from "@shared/utils/money";
import { createCOGSService } from "../inventory";
import { Decimal } from "decimal.js";
import { shipmentCostCreateSchema, shipmentCostResourceIdSchema, shipmentCostPatchSchema, shipmentCostDeleteSchema, SHIPMENT_COST_EDITABLE_FIELDS, type ShipmentCostCreateCommand } from "@shared/procurement/shipment-cost-command";
import { shipmentHeaderCreateSchema, shipmentHeaderPatchSchema } from "@shared/procurement/shipment-header-input";
import { shipmentCostVersion, versionShipmentCost } from "./shipment-cost-version";
import type { ShipmentCostCommand } from "./shipment-cost-commands";
import { eq, sql as sqlTag } from "drizzle-orm";

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

export function allocateCentsByBasis(
  amountCents: number,
  basisValues: Array<{ lineId: number; basis: number }>,
): Array<{ lineId: number; basis: number; allocatedCents: number; sharePercent: string }> {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new ShipmentTrackingError("Allocation amount must be a non-negative safe integer cents value");
  }
  if (basisValues.length === 0) return [];

  const normalized = basisValues.map((value) => {
    if (!Number.isInteger(value.lineId) || value.lineId <= 0) {
      throw new ShipmentTrackingError("Allocation line identity must be a positive integer");
    }
    const basis = new Decimal(String(value.basis));
    if (!basis.isFinite() || basis.isNegative()) {
      throw new ShipmentTrackingError("Allocation basis must be a non-negative finite number");
    }
    return { lineId: value.lineId, basis };
  });
  const basisTotal = normalized.reduce((sum, value) => sum.plus(value.basis), new Decimal(0));
  if (!basisTotal.isPositive()) {
    throw new ShipmentTrackingError("Allocation basis total must be positive");
  }

  const rows = normalized.map((value) => {
    const exactCents = new Decimal(amountCents).mul(value.basis).div(basisTotal);
    return {
      lineId: value.lineId,
      basis: value.basis.toNumber(),
      allocatedCents: exactCents.toDecimalPlaces(0, Decimal.ROUND_FLOOR).toNumber(),
      remainder: exactCents.mod(1),
      sharePercent: value.basis.div(basisTotal).mul(100).toDecimalPlaces(4).toFixed(4),
    };
  });

  const centsRemaining = amountCents - rows.reduce((sum, row) => sum + row.allocatedCents, 0);
  const remainderOrder = [...rows].sort((left, right) => {
    const remainderComparison = right.remainder.comparedTo(left.remainder);
    return remainderComparison !== 0 ? remainderComparison : left.lineId - right.lineId;
  });
  for (let index = 0; index < centsRemaining; index++) {
    remainderOrder[index % remainderOrder.length].allocatedCents += 1;
  }

  return rows.map(({ remainder: _remainder, ...row }) => row);
}

// ── Minimal dependency interfaces ───────────────────────────────────

interface Storage {
  // Inbound Shipments
  getInboundShipments(filters?: any): Promise<InboundShipment[]>;
  getInboundShipmentPurchaseOrders(shipmentIds: readonly number[]): Promise<Map<number, ShipmentPurchaseOrderReference[]>>;
  getInboundShipmentsCount(filters?: any): Promise<number>;
  getInboundShipmentById(id: number, executor?: any): Promise<InboundShipment | undefined>;
  getInboundShipmentByNumber(shipmentNumber: string): Promise<InboundShipment | undefined>;
  createInboundShipment(data: InsertInboundShipment): Promise<InboundShipment>;
  updateInboundShipment(id: number, updates: Partial<InsertInboundShipment>, executor?: any, recordedAt?: Date): Promise<InboundShipment | null>;
  deleteInboundShipment(id: number, executor?: any): Promise<boolean>;
  generateShipmentNumber(): Promise<string>;
  // Lines
  getInboundShipmentLines(inboundShipmentId: number, executor?: any): Promise<InboundShipmentLine[]>;
  getInboundShipmentLineById(id: number, executor?: any): Promise<InboundShipmentLine | undefined>;
  getInboundShipmentLinesByPo(purchaseOrderId: number): Promise<InboundShipmentLine[]>;
  getShippedQtyByPoLines(poLineIds: number[], executor?: any): Promise<Map<number, number>>;
  createInboundShipmentLine(data: InsertInboundShipmentLine): Promise<InboundShipmentLine>;
  bulkCreateInboundShipmentLines(lines: InsertInboundShipmentLine[], executor?: any, recordedAt?: Date): Promise<InboundShipmentLine[]>;
  updateInboundShipmentLine(id: number, updates: Partial<InsertInboundShipmentLine>, executor?: any, recordedAt?: Date): Promise<InboundShipmentLine | null>;
  deleteInboundShipmentLine(id: number, executor?: any): Promise<boolean>;
  // Costs
  getInboundFreightCosts(inboundShipmentId: number, executor?: any): Promise<InboundFreightCost[]>;
  getInboundFreightCostById(id: number, executor?: any): Promise<InboundFreightCost | undefined>;
  createInboundFreightCost(data: InsertInboundFreightCost, executor?: any, recordedAt?: Date): Promise<InboundFreightCost>;
  updateInboundFreightCost(id: number, updates: Partial<InsertInboundFreightCost>, executor?: any, recordedAt?: Date): Promise<InboundFreightCost | null>;
  deleteInboundFreightCost(id: number, executor?: any): Promise<boolean>;
  // Allocations
  getInboundFreightCostAllocations(inboundFreightCostId: number, executor?: any): Promise<any[]>;
  getAllocationsForLine(inboundShipmentLineId: number, executor?: any): Promise<any[]>;
  createInboundFreightCostAllocation(data: InsertInboundFreightAllocation, executor?: any): Promise<any>;
  bulkCreateInboundFreightCostAllocations(allocations: InsertInboundFreightAllocation[], executor?: any): Promise<any[]>;
  deleteAllocationsForShipment(inboundShipmentId: number, executor?: any): Promise<void>;
  // Landed cost snapshots
  getLandedCostSnapshots(inboundShipmentLineId: number, executor?: any): Promise<any[]>;
  getLandedCostSnapshotByPoLine(purchaseOrderLineId: number): Promise<any>;
  createLandedCostSnapshot(data: InsertLandedCostSnapshot): Promise<any>;
  bulkCreateLandedCostSnapshots(snapshots: InsertLandedCostSnapshot[], executor?: any): Promise<any[]>;
  deleteLandedCostSnapshotsForShipment(inboundShipmentId: number, executor?: any): Promise<void>;
  createLandedCostAdjustment(data: any, executor?: any): Promise<any>;
  // Status history
  createInboundShipmentStatusHistory(data: any, executor?: any): Promise<InboundShipmentStatusHistory>;
  getInboundShipmentStatusHistory(inboundShipmentId: number): Promise<InboundShipmentStatusHistory[]>;
  // Cross-references
  getInboundShipmentsByPo(purchaseOrderId: number): Promise<InboundShipment[]>;
  getProvisionalLotsByShipment(inboundShipmentId: number, executor?: any): Promise<InventoryLot[]>;
  // PO references
  getPurchaseOrderById(id: number, executor?: any): Promise<any>;
  getPurchaseOrderLines(purchaseOrderId: number, executor?: any): Promise<any[]>;
  getPurchaseOrderLineById(id: number, executor?: any): Promise<any>;
  // Vendor product dimensions
  getVendorProducts(filters?: any, executor?: any): Promise<any[]>;
  // Product variant + product lookups
  getProductVariantById(id: number, executor?: any): Promise<any>;
  getProductById(id: number): Promise<any>;
}

interface LotCostRevalueService {
  updateLotLandedCostMills(lotId: number, landedCostMills: number): Promise<any | null>;
  withTx(tx: any): LotCostRevalueService;
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
const DIMENSIONAL_METHODS = DIMENSIONAL_ALLOCATION_METHODS;
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

function allocatedCentsPerUnitMills(allocatedCents: unknown, qtyShipped: unknown): number | null {
  const cents = Number(allocatedCents);
  const qty = Number(qtyShipped);
  if (!Number.isInteger(cents) || cents < 0 || !Number.isInteger(qty) || qty <= 0) return null;
  return perUnitMills(cents * 100, qty);
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) return null;
  return numberValue;
}

function poUnitCostMillsFromLine(poLine: any): number | null {
  const mills = nonNegativeIntegerOrNull(poLine?.unitCostMills);
  if (mills !== null) return mills;

  const cents = nonNegativeIntegerOrNull(poLine?.unitCostCents);
  return cents !== null ? centsToMills(cents) : null;
}

function snapshotPoUnitCostMills(snapshot: any): number | null {
  const cents = nonNegativeIntegerOrNull(snapshot?.poUnitCostCents);
  return cents !== null ? centsToMills(cents) : null;
}

function snapshotLandedUnitCostMills(snapshot: any): number | null {
  const cents = nonNegativeIntegerOrNull(snapshot?.landedUnitCostCents);
  return cents !== null ? centsToMills(cents) : null;
}

function snapshotAllocatedCostCents(snapshot: any): number | null {
  const fields = [
    "freightAllocatedCents",
    "dutyAllocatedCents",
    "insuranceAllocatedCents",
    "otherAllocatedCents",
  ];
  let total = 0;
  for (const field of fields) {
    const cents = nonNegativeIntegerOrNull(snapshot?.[field] ?? 0);
    if (cents === null) return null;
    total += cents;
  }
  return total;
}

export type ShipmentTrackingService = ReturnType<typeof createShipmentTrackingService>;

export function createShipmentTrackingService(
  db: any,
  storage: Storage,
  lotCostRevalueService: LotCostRevalueService = createCOGSService(db),
  clock: () => Date = () => new Date(),
) {

  async function runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    if (typeof db?.transaction !== "function") {
      throw new ShipmentTrackingError("Database transaction support is required for landed-cost writes", 500);
    }
    return await db.transaction(async (tx: any) => { await lockInventoryCostGraph(tx); return fn(tx); });
  }

  async function lockShipment(tx: any, shipmentId: number): Promise<InboundShipment> {
    const lockResult = await tx.execute(sqlTag`
      SELECT id
      FROM procurement.inbound_shipments
      WHERE id = ${shipmentId}
      FOR UPDATE
    `);
    if (!lockResult.rows?.[0]) {
      throw new ShipmentTrackingError("Shipment not found", 404);
    }
    const shipment = await storage.getInboundShipmentById(shipmentId, tx);
    if (!shipment) {
      throw new ShipmentTrackingError("Shipment not found", 404);
    }
    return shipment;
  }

  // ─── Private helpers ────────────────────────────────────────────

  function resolveAllocationMethod(cost: InboundFreightCost, shipment: InboundShipment) {
    try { return resolveShipmentAllocationMethod(cost.costType, cost.allocationMethod ?? null, shipment.allocationMethodDefault ?? null); }
    catch (error) { throw new ShipmentTrackingError(error instanceof Error ? error.message : "Invalid allocation policy", 409, { code: "INVALID_ALLOCATION_METHOD" }); }
  }

  async function buildAllocationBasis(lines: InboundShipmentLine[], method: string, executor?: any) {
    const inputs = [];
    for (const line of lines) {
      const poLine = method === "by_value" && line.purchaseOrderLineId
        ? await storage.getPurchaseOrderLineById(line.purchaseOrderLineId, executor) : null;
      inputs.push({ lineId: line.id, qtyShipped: line.qtyShipped, totalVolumeCbm: line.totalVolumeCbm,
        totalWeightKg: line.totalWeightKg, chargeableWeightKg: line.chargeableWeightKg, poUnitCostCents: poLine?.unitCostCents ?? null });
    }
    try { return buildShipmentAllocationBasis(inputs, method); }
    catch (error) { throw new ShipmentTrackingError(error instanceof Error ? error.message : "Invalid allocation basis", 409, { code: "INVALID_ALLOCATION_BASIS" }); }
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
    executor?: any,
    changedAt?: Date,
  ) {
    const entry = {
      inboundShipmentId,
      fromStatus,
      toStatus,
      changedBy: userId || null,
      notes: notes || null,
      ...(changedAt ? { changedAt } : {}),
    };
    if (executor) await storage.createInboundShipmentStatusHistory(entry, executor);
    else await storage.createInboundShipmentStatusHistory(entry);
  }

  async function recomputeShipmentTotals(shipmentId: number, executor?: any, recordedAt?: Date) {
    const lines = await storage.getInboundShipmentLines(shipmentId, executor);
    const costs = await storage.getInboundFreightCosts(shipmentId, executor);

    // Aggregate NET totals from lines (weight/volume computed from per-carton values × cartonCount)
    let totalWeightKg = new Decimal(0);
    let totalVolumeCbm = new Decimal(0);
    let totalPieces = 0;
    let totalCartons = 0;

    for (const line of lines) {
      totalWeightKg = totalWeightKg.plus(line.totalWeightKg ?? "0");
      totalVolumeCbm = totalVolumeCbm.plus(line.totalVolumeCbm ?? "0");
      totalPieces += line.qtyShipped;
      totalCartons += line.cartonCount || 0;
    }

    let estimatedTotal = BigInt(0);
    let actualTotal = BigInt(0);
    let effectiveTotal = BigInt(0);
    for (const cost of costs) {
      for (const amount of [cost.estimatedCents, cost.actualCents]) {
        if (amount !== null && amount !== undefined && !Number.isSafeInteger(amount)) {
          throw new ShipmentTrackingError("Recorded charge amounts must be safe integer cents", 409, { code: "SHIPMENT_COST_AMOUNT_INVALID" });
        }
      }
      estimatedTotal += BigInt(cost.estimatedCents ?? 0);
      actualTotal += BigInt(cost.actualCents ?? 0);
      effectiveTotal += BigInt(cost.actualCents ?? cost.estimatedCents ?? 0);
    }
    if ([estimatedTotal, actualTotal, effectiveTotal].some((amount) => amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER))) {
      throw new ShipmentTrackingError("Shipment charge totals exceed the supported exact range", 409, { code: "SHIPMENT_COST_TOTAL_OVERFLOW" });
    }
    const estimatedTotalCostCents = Number(estimatedTotal);
    const actualTotalCostCents = Number(actualTotal);

    // NOTE: grossWeightKg, totalGrossVolumeCbm, palletCount are user-entered at shipment level (from BOL) — never overwritten here
    await storage.updateInboundShipment(shipmentId, {
      totalWeightKg: totalWeightKg.toFixed(),
      totalVolumeCbm: totalVolumeCbm.toFixed(),
      totalPieces,
      totalCartons,
      estimatedTotalCostCents,
      actualTotalCostCents,
    } as any, executor, recordedAt);
  }

  async function refreshAllocationsForShipmentInTransaction(
    tx: any,
    shipmentId: number,
    lockedShipment: InboundShipment,
    recordedAt?: Date,
  ) {
    const lines = await storage.getInboundShipmentLines(shipmentId, tx);
    if (lines.length === 0) {
      await storage.deleteAllocationsForShipment(shipmentId, tx);
      return null;
    }

    return await runAllocationInTransaction(tx, shipmentId, lockedShipment, recordedAt);
  }

  async function getAllocationBreakdownsByLine(shipmentId: number) {
    const costs = await storage.getInboundFreightCosts(shipmentId);
    const breakdowns = new Map<number, {
      freightAllocatedCents: number;
      dutyAllocatedCents: number;
      insuranceAllocatedCents: number;
      otherAllocatedCents: number;
    }>();

    for (const cost of costs) {
      const allocations = await storage.getInboundFreightCostAllocations(cost.id);
      const category = getCostCategory(cost.costType);

      for (const allocation of allocations) {
        const lineId = Number(allocation.inboundShipmentLineId);
        if (!Number.isInteger(lineId)) continue;

        const current = breakdowns.get(lineId) ?? {
          freightAllocatedCents: 0,
          dutyAllocatedCents: 0,
          insuranceAllocatedCents: 0,
          otherAllocatedCents: 0,
        };
        const cents = Number(allocation.allocatedCents || 0);

        if (category === "freight") current.freightAllocatedCents += cents;
        else if (category === "duty") current.dutyAllocatedCents += cents;
        else if (category === "insurance") current.insuranceAllocatedCents += cents;
        else current.otherAllocatedCents += cents;

        breakdowns.set(lineId, current);
      }
    }

    return breakdowns;
  }


  async function getEnrichedLines(shipmentId: number) {
    const lines = await storage.getInboundShipmentLines(shipmentId);
    const allocationBreakdowns = await getAllocationBreakdownsByLine(shipmentId);

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
      const allocationBreakdown = allocationBreakdowns.get(line.id);
      const freightAllocatedCents = allocationBreakdown?.freightAllocatedCents ?? null;
      const dutyAllocatedCents = allocationBreakdown?.dutyAllocatedCents ?? null;
      const insuranceAllocatedCents = allocationBreakdown?.insuranceAllocatedCents ?? null;
      const otherAllocatedCents = allocationBreakdown?.otherAllocatedCents ?? null;
      const breakdownTotalCents = allocationBreakdown
        ? allocationBreakdown.freightAllocatedCents
          + allocationBreakdown.dutyAllocatedCents
          + allocationBreakdown.insuranceAllocatedCents
          + allocationBreakdown.otherAllocatedCents
        : null;
      const allocatedCostCents = line.allocatedCostCents ?? breakdownTotalCents;
      const poUnitCostMills = poUnitCostMillsFromLine(pol);
      const totalAllocatedMillsPerUnit = allocatedCentsPerUnitMills(allocatedCostCents, line.qtyShipped);
      const landedUnitCostMills =
        poUnitCostMills !== null && totalAllocatedMillsPerUnit !== null
          ? poUnitCostMills + totalAllocatedMillsPerUnit
          : null;
      return {
        ...versionShipmentLine(line),
        allocatedCostCents,
        sku: line.sku || pol?.sku || pv?.sku || product?.sku || null,
        unitsPerVariant: pv?.unitsPerVariant ?? 1,
        productName: product?.title || product?.name || pol?.productName || pv?.name || line.sku || null,
        poQtyOrdered: pol?.orderQty ?? null,
        poUnitCostCents: pol?.unitCostCents ?? null,
        poUnitCostMills,
        freightAllocatedCents,
        dutyAllocatedCents,
        insuranceAllocatedCents,
        otherAllocatedCents,
        freightAllocatedMillsPerUnit: allocatedCentsPerUnitMills(freightAllocatedCents, line.qtyShipped),
        dutyAllocatedMillsPerUnit: allocatedCentsPerUnitMills(dutyAllocatedCents, line.qtyShipped),
        insuranceAllocatedMillsPerUnit: allocatedCentsPerUnitMills(insuranceAllocatedCents, line.qtyShipped),
        otherAllocatedMillsPerUnit: allocatedCentsPerUnitMills(otherAllocatedCents, line.qtyShipped),
        totalAllocatedMillsPerUnit,
        landedUnitCostMills,
      };
    });
  }

  // ─── CRUD ───────────────────────────────────────────────────────

  async function createShipment(rawData: unknown, userId?: string) {
    const parsed = shipmentHeaderCreateSchema.parse(rawData);
    const data = {
      ...parsed,
      ...(parsed.eta !== undefined ? { eta: parsed.eta === null ? null : new Date(parsed.eta) } : {}),
      ...(parsed.etd !== undefined ? { etd: parsed.etd === null ? null : new Date(parsed.etd) } : {}),
    };
    const shipmentNumber = data.shipmentNumber || await storage.generateShipmentNumber();
    const allocationMethodDefault = data.mode ? MODE_DEFAULT_ALLOCATION[data.mode] || "by_volume" : "by_volume";

    let shipment: InboundShipment;
    try {
      shipment = await storage.createInboundShipment({
        ...data,
        shipmentNumber,
        status: "draft",
        allocationMethodDefault,
        createdBy: userId || null,
      } as InsertInboundShipment);
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new ShipmentTrackingError(`Shipment number '${shipmentNumber}' already in use by an active record.`, 409);
      }
      throw error;
    }
    await recordStatusChange(shipment.id, null, "draft", userId, "Shipment created");
    return shipment;
  }

  async function getShipment(id: number, executor?: any) {
    const shipment = await storage.getInboundShipmentById(id, executor);
    if (!shipment) throw new ShipmentTrackingError("Shipment not found", 404);
    return shipment;
  }

  async function getShipments(filters?: any) {
    const shipments = await storage.getInboundShipments(filters);
    const purchaseOrdersByShipment = await storage.getInboundShipmentPurchaseOrders(shipments.map((shipment) => shipment.id));
    return shipments.map((shipment) => ({ ...shipment, purchaseOrders: purchaseOrdersByShipment.get(shipment.id) ?? [] }));
  }

  async function getShipmentPurchaseOrders(id: number): Promise<ShipmentPurchaseOrderReference[]> {
    return (await storage.getInboundShipmentPurchaseOrders([id])).get(id) ?? [];
  }

  async function updateShipment(id: number, rawUpdates: unknown) {
    const parsed = shipmentHeaderPatchSchema.parse(rawUpdates);
    const updates = {
      ...parsed,
      ...(parsed.eta !== undefined ? { eta: parsed.eta === null ? null : new Date(parsed.eta) } : {}),
      ...(parsed.etd !== undefined ? { etd: parsed.etd === null ? null : new Date(parsed.etd) } : {}),
    } as Partial<InsertInboundShipment>;
    return runInTransaction(async (tx) => {
      const shipment = await lockShipment(tx, id);
      if (shipment.status === "closed" || shipment.status === "cancelled") {
        throw new ShipmentTrackingError("Cannot edit a closed or cancelled shipment");
      }
      if (updates.mode && updates.mode !== shipment.mode) {
        updates.allocationMethodDefault = MODE_DEFAULT_ALLOCATION[updates.mode] || "by_volume";
      }
      return storage.updateInboundShipment(id, updates, tx);
    });
  }

  async function deleteShipment(id: number) {
    return runInTransaction(async (tx) => {
      const shipment = await lockShipment(tx, id);
      if (shipment.status !== "draft") throw new ShipmentTrackingError("Only draft shipments can be deleted");
      const costs = await storage.getInboundFreightCosts(id, tx);
      if (costs.length > 0) {
        throw new ShipmentTrackingError("Remove draft charges individually before deleting this shipment. Invoice-referenced charges must retain their source shipment.", 409, { code: "SHIPMENT_HAS_COST_HISTORY" });
      }
      await assertShipmentLineHistoryMutable(tx, id);
      const lines = await storage.getInboundShipmentLines(id, tx);
      if (lines.length > 0) throw new ShipmentTrackingError(
        "Remove draft lines individually before deleting the empty shipment so their changes remain audited.",
        409, { code: "SHIPMENT_HAS_LINE_HISTORY" },
      );
      return storage.deleteInboundShipment(id, tx);
    });
  }

  // ─── Status transitions ────────────────────────────────────────

  async function transitionTo(id: number, targetStatus: string, userId?: string, notes?: string, extraUpdates?: Partial<InsertInboundShipment>) {
    return await runInTransaction(async (tx) => {
      // Re-check after the shared shipment lock: a transition that waited for
      // close must not apply a decision made from the previous costing state.
      const shipment = await lockShipment(tx, id);
      assertTransition(shipment.status, targetStatus);
      const changedAt = finalizationTime();
      const updates: Partial<InsertInboundShipment> = { status: targetStatus, ...extraUpdates };

      // Preserve supplied event dates; the injected clock supplies only missing
      // timestamps and the time this state transition was recorded.
      switch (targetStatus) {
        case "booked": {
          const lines = await storage.getInboundShipmentLines(id, tx);
          if (lines.length === 0) {
            throw new ShipmentTrackingError("Cannot book a shipment with no lines");
          }
          break;
        }
        case "in_transit":
          updates.shipDate = updates.shipDate || changedAt;
          break;
        case "at_port":
          updates.actualArrival = updates.actualArrival || changedAt;
          break;
        case "delivered":
          updates.deliveredDate = updates.deliveredDate || changedAt;
          if (shipment.status === "customs_clearance") {
            updates.customsClearedDate = updates.customsClearedDate || changedAt;
          }
          break;
        case "closed":
          updates.closedBy = userId || null;
          updates.closedAt = changedAt;
          break;
      }

      const updated = await storage.updateInboundShipment(id, updates, tx);
      if (!updated) throw new ShipmentTrackingError("Shipment not found", 404);
      await recordStatusChange(id, shipment.status, targetStatus, userId, notes, tx, changedAt);
      return updated;
    });
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
    // Hold the same shipment lock through finalization, closure and history.
    // Releasing it after snapshots would let a charge amendment commit before
    // closure and leave the closed shipment using stale finalized costs.
    const closed = await runInTransaction(async (tx) => {
      const shipment = await lockShipment(tx, id);
      assertTransition(shipment.status, "closed");
      const closedAt = finalizationTime();
      const finalization = await finalizeAllocationsInTransaction(tx, shipment, userId, closedAt);
      const updated = await storage.updateInboundShipment(id, {
        status: "closed", closedBy: userId || null, closedAt,
      }, tx);
      if (!updated) throw new ShipmentTrackingError("Shipment not found", 404);
      await recordStatusChange(
        id, shipment.status, "closed", userId,
        notes || "Shipment closed — landed costs finalized", tx, closedAt,
      );
      return { ...updated, costReviewIssues: finalization.costReviewIssues };
    });
    let costApplication: Awaited<ReturnType<typeof pushLandedCostsToLots>> | { status: "retry_required"; code: string };
    try {
      costApplication = await pushLandedCostsToLots(id);
    } catch (e: any) {
      costApplication = { status: "retry_required", code: "SHIPMENT_LOT_COST_PUSH_FAILED" };
      console.warn(JSON.stringify({
        event: "procurement.shipment.close_lot_cost_push_failed",
        shipmentId: id, actorId: userId ?? null,
        code: e instanceof ShipmentTrackingError ? e.details?.code ?? "SHIPMENT_LOT_COST_PUSH_FAILED" : "SHIPMENT_LOT_COST_PUSH_FAILED",
        errorType: e instanceof Error ? e.name : typeof e,
      }));
    }
    return { ...closed, costApplication };
  }

  async function cancel(id: number, userId?: string, reason?: string) {
    if (!reason) throw new ShipmentTrackingError("Cancellation reason is required");
    return transitionTo(id, "cancelled", userId, `Cancelled: ${reason}`);
  }

  // ─── Line management ───────────────────────────────────────────

  async function resolveDimensionsForVariant(productVariantId: number, vendorId: number | undefined, executor?: any) {
    const vendorProduct = vendorId
      ? (await storage.getVendorProducts({ vendorId, productVariantId }, executor))[0] : undefined;
    const variant = await storage.getProductVariantById(productVariantId, executor);
    const convert = (value: unknown, divisor: number): string | null => value == null
      ? null : new Decimal(String(value)).div(divisor).toFixed();
    // Resolve each field independently so partial supplier evidence does not
    // discard available catalog dimensions or overwrite entered line values.
    return {
      weightKg: vendorProduct?.weightKg ?? convert(variant?.weightGrams, 1000),
      lengthCm: vendorProduct?.lengthCm ?? convert(variant?.lengthMm, 10),
      widthCm: vendorProduct?.widthCm ?? convert(variant?.widthMm, 10),
      heightCm: vendorProduct?.heightCm ?? convert(variant?.heightMm, 10),
    };
  }

  function costError(message: string, statusCode: number, code: string): never {
    throw new ShipmentTrackingError(message, statusCode, { code });
  }

  async function invoiceSourceExists(tx: any, costId: number): Promise<boolean> {
    const result = await tx.execute(sqlTag`
      SELECT EXISTS (
        SELECT 1 FROM procurement.vendor_invoice_lines WHERE freight_cost_id = ${costId}
      ) AS "hasReference"
    `);
    return result.rows[0]?.hasReference === true;
  }

  async function versionCosts<T extends InboundFreightCost>(costs: T[], executor: any = db) {
    if (costs.length === 0) return [];
    const result = await executor.execute(sqlTag`
      SELECT DISTINCT freight_cost_id AS id FROM procurement.vendor_invoice_lines
      WHERE freight_cost_id = ANY(${sqlTag.param(costs.map((cost) => cost.id))}::int[])
    `);
    const referenced = new Set(result.rows.map((row: { id: number }) => row.id));
    return costs.map((cost) => versionShipmentCost(cost, referenced.has(cost.id)));
  }

  function assertCostCurrencyBasis(cost: Pick<InboundFreightCost, "currency" | "exchangeRate">) {
    if (cost.currency !== "USD" || cost.exchangeRate == null || !new Decimal(cost.exchangeRate).eq(1)) {
      costError("This charge has an unsupported currency basis. Keep its recorded values and resolve currency evidence before changing shipment economics.", 409, "SHIPMENT_COST_CURRENCY_UNSUPPORTED");
    }
  }

  function costFields(data: Record<string, unknown>): Partial<InsertInboundFreightCost> {
    const fields = Object.fromEntries(SHIPMENT_COST_EDITABLE_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(data, field))
      .map((field) => [field, data[field]]));
    if (typeof fields.invoiceDate === "string") fields.invoiceDate = new Date(fields.invoiceDate);
    return fields as Partial<InsertInboundFreightCost>;
  }

  function costFieldChanged(before: InboundFreightCost, updates: Partial<InsertInboundFreightCost>, field: keyof InsertInboundFreightCost): boolean {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) return false;
    const oldValue = before[field as keyof InboundFreightCost];
    const newValue = updates[field];
    // PostgreSQL numeric reads are scale-padded ("1.0000"); an equivalent
    // USD rate must not turn a metadata correction into an economic amendment.
    if (field === "exchangeRate" && oldValue != null && newValue != null) {
      return !new Decimal(String(oldValue)).eq(String(newValue));
    }
    const comparable = (value: unknown) => value instanceof Date ? value.toISOString() : value ?? null;
    return comparable(oldValue) !== comparable(newValue);
  }

  async function executeCostCommandInTransaction(
    tx: any, command: ShipmentCostCommand, actorId: string, now: Date,
  ) {
    if (!tx || typeof tx.execute !== "function" || typeof tx.insert !== "function") {
      costError("Database transaction support is required for shipment charge writes", 500, "SHIPMENT_COST_TRANSACTION_REQUIRED");
    }
    if (!shipmentCostResourceIdSchema.safeParse(command.resourceId).success) {
      costError("Charge resource ID must be a positive PostgreSQL integer", 400, "SHIPMENT_COST_ID_INVALID");
    }
    if (typeof actorId !== "string" || !actorId.trim()) costError("An authenticated actor is required", 401, "SHIPMENT_COST_ACTOR_REQUIRED");
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      costError("A valid command clock is required", 500, "SHIPMENT_COST_CLOCK_INVALID");
    }
    const data = command.operation === "create" ? shipmentCostCreateSchema.parse(command.body)
      : command.operation === "update" ? shipmentCostPatchSchema.parse(command.body)
      : command.operation === "delete" ? shipmentCostDeleteSchema.parse(command.body)
      : costError("Unsupported charge command", 400, "SHIPMENT_COST_OPERATION_INVALID");
    const initial = command.operation === "create" ? null : await storage.getInboundFreightCostById(command.resourceId, tx);
    if (command.operation !== "create" && !initial) costError("Shipment charge not found", 404, "SHIPMENT_COST_NOT_FOUND");
    const shipmentId = initial?.inboundShipmentId ?? command.resourceId;
    const shipment = await lockShipment(tx, shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") {
      costError("Closed or cancelled shipment charges cannot be changed here.", 409, "SHIPMENT_COST_TERMINAL");
    }

    let before: InboundFreightCost | null = null;
    let hasInvoiceSourceReference = false;
    if (command.operation !== "create") {
      await tx.execute(sqlTag`SELECT id FROM procurement.inbound_freight_costs WHERE id = ${command.resourceId} FOR UPDATE`);
      before = await storage.getInboundFreightCostById(command.resourceId, tx) ?? null;
      if (!before || before.inboundShipmentId !== shipmentId) costError("Shipment charge not found", 404, "SHIPMENT_COST_NOT_FOUND");
      // AP link/unlink also locks this row. Re-read AFTER that lock so its
      // current vendor/link state, not the preliminary lookup, is authoritative.
      hasInvoiceSourceReference = await invoiceSourceExists(tx, before.id);
      if (!("expectedVersion" in data) || data.expectedVersion !== shipmentCostVersion(before)) {
        costError("This charge changed since you opened it. Load the latest charge and review your changes.", 409, "SHIPMENT_COST_VERSION_CONFLICT");
      }
    }

    const updates = command.operation === "delete" ? {} : costFields(data);
    const allocationFields = ["costType", "estimatedCents", "actualCents", "currency", "exchangeRate", "allocationMethod"] as const;
    const protectedFields = [...allocationFields, "vendorId", "invoiceDate"] as const;
    const affectsEconomics = command.operation !== "update" || allocationFields.some((field) => costFieldChanged(before!, updates, field));
    const protectedEdit = command.operation === "delete" || protectedFields.some((field) => before && costFieldChanged(before, updates, field));
    if (before && (before.vendorInvoiceId !== null || hasInvoiceSourceReference) && protectedEdit) {
      costError("This charge is referenced by an invoice. Edit the invoice through Accounts Payable; its source charge cannot be removed or financially amended here.", 409, "SHIPMENT_COST_AP_OWNED");
    }

    if (affectsEconomics) {
      // Existing foreign/unknown-basis rows remain readable and permit metadata
      // correction. Never combine them with USD or silently change their basis.
      const costs = await storage.getInboundFreightCosts(shipmentId, tx);
      for (const cost of costs) assertCostCurrencyBasis(cost);
      if (before) assertCostCurrencyBasis(before);
    }

    let after: InboundFreightCost | null = null;
    if (command.operation === "create") {
      after = await storage.createInboundFreightCost({
        ...updates, inboundShipmentId: shipmentId,
        costType: (data as ShipmentCostCreateCommand).costType,
        currency: "USD", exchangeRate: "1",
        costStatus: updates.actualCents == null ? "estimated" : "finalized",
      }, tx, now);
    } else if (command.operation === "update") {
      const patch = { ...updates };
      if (costFieldChanged(before!, updates, "actualCents") && !before!.vendorInvoiceId && !hasInvoiceSourceReference) {
        patch.costStatus = updates.actualCents === null ? "estimated" : "finalized";
      }
      after = await storage.updateInboundFreightCost(before!.id, patch, tx, now);
      if (!after) costError("Shipment charge not found", 404, "SHIPMENT_COST_NOT_FOUND");
    } else {
      if (!await storage.deleteInboundFreightCost(before!.id, tx)) costError("Shipment charge not found", 404, "SHIPMENT_COST_NOT_FOUND");
    }

    if (affectsEconomics) {
      await recomputeShipmentTotals(shipmentId, tx);
      await refreshAllocationsForShipmentInTransaction(tx, shipmentId, shipment);
    }
    const targetId = after?.id ?? before!.id;
    await tx.insert(auditEvents).values({
      timestamp: now, level: "AUDIT", actor: actorId,
      action: `procurement.shipment_cost.${command.operation === "create" ? "created" : command.operation === "update" ? "amended" : "deleted"}`,
      target: `shipment_cost:${targetId}`,
      changes: { before, after },
      context: { shipmentId, reason: data.reason ?? null },
    });
    return after ? versionShipmentCost(after, hasInvoiceSourceReference) : { success: true as const };
  }

  // ─── Allocation engine ─────────────────────────────────────────

  async function runAllocationInTransaction(tx: any, shipmentId: number, lockedShipment?: InboundShipment, recordedAt?: Date): Promise<{
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
    const shipment = lockedShipment ?? await lockShipment(tx, shipmentId);
    const lines = await storage.getInboundShipmentLines(shipmentId, tx);
    const costs = await storage.getInboundFreightCosts(shipmentId, tx);

    if (lines.length === 0) {
      throw new ShipmentTrackingError("No lines to allocate costs to");
    }

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
      const effectiveAmount = Number(cost.actualCents ?? cost.estimatedCents ?? 0);
      if (!Number.isSafeInteger(effectiveAmount) || effectiveAmount < 0) {
        throw new ShipmentTrackingError(
          `Cost ${cost.id} must have a non-negative safe integer cents amount`,
          409,
          { code: "INVALID_LANDED_COST_AMOUNT", shipmentId, costId: cost.id, effectiveAmount },
        );
      }
      if (effectiveAmount === 0) continue;

      const { method } = resolveAllocationMethod(cost, shipment);
      const basisSummary = await buildAllocationBasis(lines, method, tx);
      const basisValues = basisSummary.values;
      const basisTotal = basisSummary.basisTotal;

      const distributed = allocateCentsByBasis(effectiveAmount, basisValues);
      for (const allocation of distributed) {
        allNewAllocations.push({
          shipmentCostId: cost.id,
          inboundShipmentLineId: allocation.lineId,
          allocationBasisValue: String(allocation.basis),
          allocationBasisTotal: String(basisTotal),
          sharePercent: allocation.sharePercent,
          allocatedCents: allocation.allocatedCents,
        } as any);

        // Accumulate by cost type category
        const lineAcc = lineAllocations.get(allocation.lineId)!;
        const category = getCostCategory(cost.costType);
        if (category === "freight") lineAcc.freightCents += allocation.allocatedCents;
        else if (category === "duty") lineAcc.dutyCents += allocation.allocatedCents;
        else if (category === "insurance") lineAcc.insuranceCents += allocation.allocatedCents;
        else lineAcc.otherCents += allocation.allocatedCents;
      }

    }

    // Bulk insert all allocations
    let totalAllocated = 0;
    const resultLines: any[] = [];
    const lineUpdates: Array<{ lineId: number; allocatedCostCents: number; landedUnitCostCents: number }> = [];

    for (const line of lines) {
      const qtyShipped = Number(line.qtyShipped);
      if (!Number.isSafeInteger(qtyShipped) || qtyShipped <= 0) {
        throw new ShipmentTrackingError(
          `Shipment line ${line.id} must have a positive safe integer shipped quantity`,
          409,
          { code: "INVALID_SHIPMENT_LINE_QUANTITY", shipmentId, lineId: line.id, qtyShipped },
        );
      }
      const acc = lineAllocations.get(line.id)!;
      const totalForLine = acc.freightCents + acc.dutyCents + acc.insuranceCents + acc.otherCents;
      totalAllocated += totalForLine;

      // Look up PO unit cost
      let poUnitCostCents = 0;
      if (line.purchaseOrderLineId) {
        const poLine = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId, tx);
        poUnitCostCents = Number(poLine?.unitCostCents || 0);
      }
      if (!Number.isSafeInteger(poUnitCostCents) || poUnitCostCents < 0) {
        throw new ShipmentTrackingError(
          `Shipment line ${line.id} has an invalid PO unit cost`,
          409,
          { code: "INVALID_PO_UNIT_COST", shipmentId, lineId: line.id, poUnitCostCents },
        );
      }

      const totalCostCents = (poUnitCostCents * qtyShipped) + totalForLine;
      if (!Number.isSafeInteger(totalCostCents)) {
        throw new ShipmentTrackingError(
          `Shipment line ${line.id} landed cost exceeds safe integer range`,
          409,
          { code: "LANDED_COST_OVERFLOW", shipmentId, lineId: line.id },
        );
      }
      const landedUnitCostCents = new Decimal(totalCostCents)
        .div(qtyShipped)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
        .toNumber();
      lineUpdates.push({ lineId: line.id, allocatedCostCents: totalForLine, landedUnitCostCents });

      resultLines.push({
        lineId: line.id,
        sku: line.sku,
        poUnitCostCents,
        ...acc,
        totalAllocatedCents: totalForLine,
        landedUnitCostCents,
      });
    }

    if (!Number.isSafeInteger(totalAllocated)) {
      throw new ShipmentTrackingError("Allocated landed cost exceeds safe integer range", 409, {
        code: "LANDED_COST_OVERFLOW",
        shipmentId,
      });
    }

    await storage.deleteAllocationsForShipment(shipmentId, tx);
    await storage.bulkCreateInboundFreightCostAllocations(allNewAllocations, tx);
    for (const update of lineUpdates) {
      await storage.updateInboundShipmentLine(update.lineId, {
        allocatedCostCents: update.allocatedCostCents,
        landedUnitCostCents: update.landedUnitCostCents,
      } as any, tx, recordedAt);
    }

    return { allocations: resultLines, totalAllocated };
  }

  async function runAllocation(shipmentId: number) {
    return await runInTransaction(async (tx) => {
      const shipment = await lockShipment(tx, shipmentId);
      if (shipment.status === "closed") {
        throw new ShipmentTrackingError(
          "Closed shipment costs must be changed through landed-cost finalization so adjustments are recorded",
          409,
          { code: "CLOSED_SHIPMENT_ALLOCATION_REQUIRES_FINALIZATION", shipmentId },
        );
      }
      if (shipment.status === "cancelled") {
        throw new ShipmentTrackingError("Cannot allocate costs for a cancelled shipment");
      }
      return await runAllocationInTransaction(tx, shipmentId, shipment);
    });
  }

  async function getAllocationStatus(shipmentId: number, executor?: any) {
    const shipment = await getShipment(shipmentId, executor);
    const lines = await storage.getInboundShipmentLines(shipmentId, executor);
    const costs = await storage.getInboundFreightCosts(shipmentId, executor);
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
      const allocations = await storage.getInboundFreightCostAllocations(cost.id, executor);
      const allocatedCents = allocations.reduce((sum: number, allocation: any) => sum + Number(allocation.allocatedCents || 0), 0);
      const staleAllocationCount = allocations.filter((allocation: any) => !currentLineIds.has(allocation.inboundShipmentLineId)).length;
      const basisSummary = lines.length > 0
        ? await buildAllocationBasis(lines, method, executor)
        : { rawBasisTotal: 0, basisTotal: 0, usedFallback: false };
      const basisValues = "values" in basisSummary ? basisSummary.values : [];
      const expectedBasisByLine = new Map(
        basisValues.map((value: any) => [value.lineId, value.basis]),
      );
      const staleBasisCount = allocations.filter((allocation: any) => {
        if (!currentLineIds.has(allocation.inboundShipmentLineId)) return false;
        const expectedBasis = expectedBasisByLine.get(allocation.inboundShipmentLineId);
        if (expectedBasis == null) return true;
        return !shipmentAllocationBasisMatches(allocation.allocationBasisValue, expectedBasis)
          || !shipmentAllocationBasisMatches(allocation.allocationBasisTotal, basisSummary.basisTotal);
      }).length;

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
      } else if (staleBasisCount > 0) {
        status = "stale_allocation_basis";
        issues.push({
          severity: "blocker",
          code: "stale_allocation_basis",
          costId: cost.id,
          message: `${cost.costType} allocation basis no longer matches current ${method} values on ${staleBasisCount} line(s). Re-run allocation before closing.`,
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

  function finalizationTime(): Date {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new ShipmentTrackingError("A valid finalization clock is required", 500, {
        code: "SHIPMENT_FINALIZATION_CLOCK_INVALID",
      });
    }
    return new Date(now.getTime());
  }

  async function finalizeAllocations(shipmentId: number, userId?: string) {
    return await runInTransaction(async (tx) => {
      const shipment = await lockShipment(tx, shipmentId);
      return finalizeAllocationsInTransaction(tx, shipment, userId, finalizationTime());
    });
  }

  async function finalizeAllocationsInTransaction(
    tx: any, shipment: InboundShipment, userId: string | undefined, finalizedAt: Date,
  ) {
    const shipmentId = shipment.id;
    if (!["costing", "closed"].includes(shipment.status)) {
      throw new ShipmentTrackingError("Landed costs can only be finalized while shipment is in costing or closed status");
    }

    const lines = await storage.getInboundShipmentLines(shipmentId, tx);

    if (lines.length === 0) {
      throw new ShipmentTrackingError("No lines to finalize");
    }

    // A dimensional cost with an incomplete basis would otherwise equal-split when
    // all values are absent or assign $0 to individual dimensionless lines. Keep the
    // gate inside finalization so the standalone finalize action cannot bypass it.
    const allocationStatus = await getAllocationStatus(shipmentId, tx);
    const dimensionIssues = allocationStatus.issues.filter((issue) => issue.code === "missing_dimensions");
    if (dimensionIssues.length > 0) {
      throw new ShipmentTrackingError(
        `Cannot finalize landed costs — freight is allocated by dimensions but some lines are missing them. ${dimensionIssues.map((issue) => issue.message).join(" ")}`,
        400,
        {
          code: "MISSING_ALLOCATION_DIMENSIONS",
          issues: dimensionIssues,
        },
      );
    }

    // Run allocation first to ensure fresh numbers
    await runAllocationInTransaction(tx, shipmentId, shipment);

    // Re-fetch lines after allocation
    const updatedLines = await storage.getInboundShipmentLines(shipmentId, tx);

    // Fetch old snapshots before deleting
    const oldSnapshotsByLine = new Map<number, any>();
    for (const line of updatedLines) {
      const snaps = await storage.getLandedCostSnapshots(line.id, tx);
      if (snaps.length > 0) {
        oldSnapshotsByLine.set(line.id, snaps[0]);
      }
    }

    const snapshots: InsertLandedCostSnapshot[] = [];
    const adjustments: any[] = [];

    for (const line of updatedLines) {
      // Get per-category breakdown
      const allocations = await storage.getAllocationsForLine(line.id, tx);
      let freightCents = 0, dutyCents = 0, insuranceCents = 0, otherCents = 0;

      for (const alloc of allocations) {
        const cost = await storage.getInboundFreightCostById(alloc.shipmentCostId, tx);
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
        const poLine = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId, tx);
        poUnitCostCents = Number(poLine?.unitCostCents || 0);
      }

      const qtyShipped = Number(line.qtyShipped);
      const totalLandedCostCents = (poUnitCostCents * qtyShipped) + freightCents + dutyCents + insuranceCents + otherCents;
      const landedUnitCostCents = new Decimal(totalLandedCostCents)
        .div(qtyShipped)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
        .toNumber();

      // H6: Landed-cost re-allocation must not retroactively mutate closed lines
      if (shipment.status === "closed") {
        const oldSnap = oldSnapshotsByLine.get(line.id);
        if (oldSnap && oldSnap.totalLandedCostCents !== totalLandedCostCents) {
          const adjustmentPoLineId = Number(line.purchaseOrderLineId);
          if (!Number.isInteger(adjustmentPoLineId) || adjustmentPoLineId <= 0) {
            throw new ShipmentTrackingError(
              `Closed shipment line ${line.id} cannot record a landed-cost adjustment without a PO line`,
              409,
              { code: "LANDED_COST_ADJUSTMENT_MISSING_PO_LINE", shipmentId, lineId: line.id },
            );
          }
          const adjustmentCents = totalLandedCostCents - oldSnap.totalLandedCostCents;
          
          adjustments.push({
            inboundShipmentLineId: line.id,
            purchaseOrderLineId: adjustmentPoLineId,
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
        finalizedAt,
      } as any);
    }

    const unchanged =
      snapshots.length === updatedLines.length &&
      snapshots.every((snapshot: any) => {
        const oldSnap = oldSnapshotsByLine.get(snapshot.inboundShipmentLineId);
        return oldSnap && landedSnapshotMatches(oldSnap, snapshot);
      });

    if (unchanged) {
      const evidence = await recordShipmentCostRevisions(tx, shipmentId, userId || "system:shipment-costs", finalizedAt, { allocationJustFinalized: true });
      return { finalized: snapshots.length, unchanged: true, adjustments: 0, costReviewIssues: evidence.issues };
    }

    await storage.deleteLandedCostSnapshotsForShipment(shipmentId, tx);
    for (const adjustment of adjustments) {
      await storage.createLandedCostAdjustment(adjustment, tx);
    }
    await storage.bulkCreateLandedCostSnapshots(snapshots, tx);
    const evidence = await recordShipmentCostRevisions(tx, shipmentId, userId || "system:shipment-costs", finalizedAt, { allocationJustFinalized: true });
    return { finalized: snapshots.length, unchanged: false, adjustments: adjustments.length, costReviewIssues: evidence.issues };
  }

  // ─── Receiving integration ─────────────────────────────────────

  /**
   * Apply the exact current shipment-line revision through recorded lot lineage.
   * Called when closing the shipment or manually triggered.
   */
  async function pushLandedCostsToLots(shipmentId: number) {
    return runInTransaction(async (tx) => {
      const shipment = await lockShipment(tx, shipmentId);
      if (shipment.status === "cancelled") throw new ShipmentTrackingError("Cannot push landed costs for a cancelled shipment");
      return applyShipmentCostRevisions(tx, shipmentId, new COGSService(tx), "system:shipment-costs", finalizationTime());
    });
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
   * Get the landed unit cost in mills for a PO line (used by receiving.close).
   * Reconstructs mills from finalized snapshot allocation buckets because the
   * persisted snapshot stores the legacy cents mirror only.
   */
  async function getLandedCostMillsForPoLine(purchaseOrderLineId: number): Promise<number | null> {
    const snapshot = await storage.getLandedCostSnapshotByPoLine(purchaseOrderLineId);
    if (!snapshot) return null;

    const fallbackMills = snapshotLandedUnitCostMills(snapshot);
    const poLine = await storage.getPurchaseOrderLineById(purchaseOrderLineId);
    const poUnitCostMills = poUnitCostMillsFromLine(poLine) ?? snapshotPoUnitCostMills(snapshot);
    const allocatedCostCents = snapshotAllocatedCostCents(snapshot);
    if (poUnitCostMills === null || allocatedCostCents === null) return fallbackMills;

    const allocatedCostMills =
      allocatedCostCents === 0
        ? 0
        : allocatedCentsPerUnitMills(allocatedCostCents, snapshot.qty);
    if (allocatedCostMills === null) return fallbackMills;

    return poUnitCostMills + allocatedCostMills;
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
    getShipments,
    getShipmentPurchaseOrders,
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
    executeLineCommandInTransaction: createShipmentLineMutationOwner({
      storage, lockShipment, resolveDimensions: resolveDimensionsForVariant,
      recomputeTotals: recomputeShipmentTotals,
      refreshAllocations: async (tx, shipmentId, shipment, recordedAt) => {
        // Physical line edits change charge distribution. Preserve the same
        // verified currency basis required by the shipment charge owner.
        for (const cost of await storage.getInboundFreightCosts(shipmentId, tx)) assertCostCurrencyBasis(cost);
        return refreshAllocationsForShipmentInTransaction(tx, shipmentId, shipment, recordedAt);
      },
    }).executeLineCommandInTransaction,
    getLines: (shipmentId: number) => storage.getInboundShipmentLines(shipmentId),
    getEnrichedLines: getEnrichedLines,
    getLinesByPo: (poId: number) => storage.getInboundShipmentLinesByPo(poId),
    getShippedQtyByPoLines: (poLineIds: number[]) => storage.getShippedQtyByPoLines(poLineIds),

    // Costs
    executeCostCommandInTransaction,
    versionCosts,
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
      return versionCosts(rows.map((r: any) => ({ ...r.cost, vendorName: r.counterpartyName })));
    },

    // Allocation
    runAllocation,
    getAllocationStatus,
    getLandedCostHealth,
    finalizeAllocations,

    // Receiving integration
    pushLandedCostsToLots,
    getLandedCostForPoLine,
    getLandedCostMillsForPoLine,
    getShipmentForReceiving,

    // Cross-references
    getShipmentsByPo: (poId: number) => storage.getInboundShipmentsByPo(poId),
    getStatusHistory: (shipmentId: number) => storage.getInboundShipmentStatusHistory(shipmentId),
  };
}
