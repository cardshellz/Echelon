import type { SupplierReturnSourceProof } from "@shared/procurement/supplier-return";
import { CostEvidenceError } from "../infrastructure/cost-evidence-values";
import { sliceCostQuantityIntervals, validateCostQuantityIntervals, type CostQuantityInterval } from "./cost-quantity-intervals";
import { hasExactLotCostTotals, lotCostTotals, lotCostsForIntervals, moneyToSafeNumber, type LotCostRecord } from "./lot-cost";

export const MAX_SUPPLIER_RETURN_LINES = 100;
export const MAX_SUPPLIER_RETURN_ANCESTORS = 100;

export class SupplierReturnStockError extends CostEvidenceError {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(code, message, context);
    this.name = "SupplierReturnStockError";
  }
}

export interface SupplierReturnProvenanceLot {
  id: number;
  productId: number;
  productVariantId: number;
  receivedQuantity: number;
  purchaseOrderId: number | null;
  purchaseOrderLineId: number | null;
  receivingOrderId: number | null;
}

export interface SupplierReturnOriginEvidence {
  origin: SupplierReturnSourceProof["origin"];
  receipt: {
    receivingOrderId: number;
    purchaseOrderLineId: number | null;
    productId: number | null;
    productVariantId: number | null;
    unitsPerVariant: number | null;
    receivedQuantity: number;
    recordedOriginQuantity: number;
    closed: boolean;
    hasReversal: boolean;
    costSourceKind: string | null;
  };
}

export interface SupplierReturnTransferEvidence {
  transfer: SupplierReturnSourceProof["transfers"][number];
  operationKind: string;
  allocationLotId: number;
  allocationQuantity: number;
  allocationDirection: number;
  hasAllocationReversal: boolean;
}

function fail(code: string, message: string, inventoryLotId: number): never {
  throw new SupplierReturnStockError(code, message, { inventoryLotId });
}

/** Only an original receipt or an exact one-to-one transfer chain proves which
 * supplier owns this return. A copied PO label on a mixed/transformed lot does
 * not establish physical provenance. */
export function proveSupplierReturnProvenance(input: {
  inventoryLotId: number;
  vendorId: number;
  lots: readonly SupplierReturnProvenanceLot[];
  origins: readonly SupplierReturnOriginEvidence[];
  transfers: readonly SupplierReturnTransferEvidence[];
}): SupplierReturnSourceProof {
  const { inventoryLotId, vendorId } = input;
  const lots = new Map(input.lots.map(lot => [lot.id, lot]));
  const origins = new Map(input.origins.map(row => [row.origin.inventoryLotId, row]));
  if (lots.size !== input.lots.length || origins.size !== input.origins.length
    || new Set(input.transfers.map(row => row.transfer.contributionId)).size !== input.transfers.length) {
    fail("SUPPLIER_RETURN_SOURCE_DUPLICATE", "The supplier return source contains duplicate provenance identities.", inventoryLotId);
  }
  const selected = lots.get(inventoryLotId);
  if (!selected) fail("SUPPLIER_RETURN_SOURCE_MISSING", "The selected stock has no complete source evidence.", inventoryLotId);
  const visited = new Set<number>();
  const reverseChain: SupplierReturnSourceProof["transfers"] = [];
  let current = selected;
  for (let depth = 0; depth <= MAX_SUPPLIER_RETURN_ANCESTORS; depth++) {
    if (visited.has(current.id)) fail("SUPPLIER_RETURN_SOURCE_CYCLE", "The stock source contains a circular transfer history.", inventoryLotId);
    visited.add(current.id);
    const incoming = input.transfers.filter(row => row.transfer.outputLotId === current.id);
    const root = origins.get(current.id);
    if (root) {
      const { origin, receipt } = root;
      if (incoming.length !== 0) fail("SUPPLIER_RETURN_SOURCE_AMBIGUOUS", "A receipt lot also claims a transformed source.", inventoryLotId);
      if (origin.vendorId !== vendorId) fail("SUPPLIER_RETURN_VENDOR_MISMATCH", "This stock was received from a different supplier.", inventoryLotId);
      if (!receipt.closed || receipt.hasReversal) {
        fail("SUPPLIER_RETURN_RECEIPT_REVIEW", "Supplier returns require a closed receipt without a receipt correction.", inventoryLotId);
      }
      if (receipt.costSourceKind !== "purchase_order_line" || origin.receivingOrderId !== receipt.receivingOrderId
        || origin.purchaseOrderLineId !== receipt.purchaseOrderLineId
        || origin.productId !== receipt.productId || origin.productVariantId !== receipt.productVariantId
        || origin.unitsPerVariant !== receipt.unitsPerVariant
        || receipt.receivedQuantity !== receipt.recordedOriginQuantity
        || origin.receivedVariantQuantity !== current.receivedQuantity
        || origin.receivedVariantQuantity > receipt.receivedQuantity) {
        fail("SUPPLIER_RETURN_RECEIPT_SOURCE_CHANGED", "The receipt, frozen units and original cost quantity no longer agree.", inventoryLotId);
      }
      for (const id of visited) {
        const lot = lots.get(id)!;
        if (lot.productId !== origin.productId || lot.productVariantId !== origin.productVariantId
          || lot.purchaseOrderId !== origin.purchaseOrderId || lot.purchaseOrderLineId !== origin.purchaseOrderLineId
          || lot.receivingOrderId !== origin.receivingOrderId) {
          fail("SUPPLIER_RETURN_SOURCE_IDENTITY_CHANGED", "The stock's product or receipt identity disagrees with its original source.", inventoryLotId);
        }
      }
      return { contractVersion: 1, origin: { ...origin }, transfers: reverseChain.reverse() };
    }
    if (incoming.length !== 1) fail("SUPPLIER_RETURN_SOURCE_UNPROVEN", "This stock has missing or mixed supplier provenance.", inventoryLotId);
    const edge = incoming[0];
    const { transfer } = edge;
    const parent = lots.get(transfer.sourceLotId);
    if (!parent || edge.operationKind !== "transfer" || transfer.sourceQuantity !== transfer.outputQuantity
      || transfer.outputQuantity !== current.receivedQuantity || transfer.outputStartQuantity !== 0
      || parent.productVariantId !== current.productVariantId || parent.productId !== current.productId) {
      fail("SUPPLIER_RETURN_TRANSFORM_UNSUPPORTED", "Only unchanged receipt stock and proven one-to-one transfers can be returned here.", inventoryLotId);
    }
    if (edge.allocationLotId !== parent.id || edge.allocationQuantity !== transfer.sourceQuantity
      || edge.allocationDirection !== 1 || edge.hasAllocationReversal
      || transfer.intervals.reduce((sum, interval) => sum + BigInt(interval.quantity), BigInt(0)) !== BigInt(transfer.sourceQuantity)) {
      fail("SUPPLIER_RETURN_TRANSFER_COST_UNPROVEN", "The transfer lacks its exact original quantity allocation.", inventoryLotId);
    }
    try { validateCostQuantityIntervals(transfer.intervals, parent.receivedQuantity); }
    catch { fail("SUPPLIER_RETURN_TRANSFER_COST_UNPROVEN", "The transfer quantity intervals do not belong to the original source lot.", inventoryLotId); }
    reverseChain.push({ ...transfer, intervals: transfer.intervals.map(interval => ({ ...interval })) });
    current = parent;
  }
  return fail("SUPPLIER_RETURN_SOURCE_LIMIT", "The source chain needs a bounded provenance review before returning stock.", inventoryLotId);
}

/** Selecting a physical return consumes only unreserved on-hand. Picked and
 * packed units have already left on-hand and must not be deducted again. */
export function planSupplierReturnQuantity(input: {
  lot: LotCostRecord;
  quantity: number;
  onHand: number;
  reserved: number;
  basisQuantity: number | null;
  freeIntervals: readonly CostQuantityInterval[];
  hasUnresolvedQuantity: boolean;
}) {
  const integers = [input.quantity, input.onHand, input.reserved];
  if (!integers.every(Number.isSafeInteger) || input.quantity <= 0 || input.quantity > 2_147_483_647
    || input.onHand < 0 || input.reserved < 0 || input.reserved > input.onHand) {
    throw new SupplierReturnStockError("SUPPLIER_RETURN_QUANTITY_INVALID", "A supplier return needs valid whole-unit stock and reservation quantities.");
  }
  if (!hasExactLotCostTotals(input.lot) || input.basisQuantity === null || input.hasUnresolvedQuantity) {
    throw new SupplierReturnStockError("SUPPLIER_RETURN_COST_BASIS_REQUIRED", "Resolve the stock's exact cost quantity evidence before returning it.");
  }
  const totals = lotCostTotals(input.lot);
  if (totals.basisQuantity !== input.basisQuantity
    || input.freeIntervals.reduce((sum, interval) => sum + BigInt(interval.quantity), BigInt(0)) !== BigInt(input.onHand)) {
    throw new SupplierReturnStockError("SUPPLIER_RETURN_COST_QUANTITY_MISMATCH", "Unconsumed cost intervals and physical on-hand do not agree.");
  }
  validateCostQuantityIntervals(input.freeIntervals, totals.basisQuantity);
  const availableQuantity = input.onHand - input.reserved;
  if (input.quantity > availableQuantity) {
    throw new SupplierReturnStockError("SUPPLIER_RETURN_RESERVED_OR_UNAVAILABLE", "The requested quantity exceeds unreserved stock at this location.");
  }
  const intervals = sliceCostQuantityIntervals(input.freeIntervals, 0, input.quantity);
  const amounts = lotCostsForIntervals(input.lot, intervals);
  return {
    availableQuantity,
    intervals,
    costs: {
      productMills: moneyToSafeNumber(amounts.poMills, "supplierReturn.productMills"),
      packagingMills: moneyToSafeNumber(amounts.packagingMills, "supplierReturn.packagingMills"),
      landedMills: moneyToSafeNumber(amounts.landedMills, "supplierReturn.landedMills"),
      totalMills: moneyToSafeNumber(amounts.totalMills, "supplierReturn.totalMills"),
    },
  };
}
