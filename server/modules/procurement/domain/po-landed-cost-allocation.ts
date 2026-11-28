import {
  allocateShipmentCents,
  buildShipmentAllocationBasis,
  type ShipmentAllocationBasisLine,
} from "./shipment-allocation-basis";
import {
  costFingerprint,
  costInteger,
} from "../../inventory/cost-evidence-values.api";
import type { CostRevisionInput } from "../../inventory/cost-evidence.repository.api";
import type {
  PoLandedCostAllocationMethod,
  PoLandedCostLineAllocation,
  PoLandedCostRecord,
  PoLandedCostType,
} from "@shared/procurement/po-landed-cost";

export interface PoLandedProductLineInput {
  id: number;
  purchaseOrderId: number;
  sku: string | null;
  productName: string | null;
  orderQty: number;
  receivedQty: number;
  status: string;
  totalProductCostCents: number;
  currency: string;
}

export function categorizePoLandedCostType(costType: PoLandedCostType | string): "freight" | "duty" | "other" {
  if (costType === "freight" || costType === "drayage" || costType === "port_handling") {
    return "freight";
  }
  if (costType === "duty" || costType === "tariff" || costType === "tax" || costType === "brokerage") {
    return "duty";
  }
  return "other";
}

export function resolvePoLineCoveragePieces(line: Pick<PoLandedProductLineInput, "orderQty" | "receivedQty" | "status">): number {
  const orderQty = costInteger(line.orderQty, "orderQty", 1);
  const receivedQty = costInteger(line.receivedQty ?? 0, "receivedQty", 0);
  if ((line.status === "received" || line.status === "closed") && receivedQty > 0) {
    return receivedQty;
  }
  return orderQty;
}

export function allocatePoLandedCostsAcrossLines(
  purchaseOrderId: number,
  lines: readonly PoLandedProductLineInput[],
  charges: readonly PoLandedCostRecord[],
): {
  totalCents: number;
  freightCents: number;
  dutyCents: number;
  otherCents: number;
  lineAllocations: PoLandedCostLineAllocation[];
  allocationsByChargeAndLine: Map<string, number>;
} {
  costInteger(purchaseOrderId, "purchaseOrderId", 1);
  const accumulators = new Map<
    number,
    { freightCents: bigint; dutyCents: bigint; otherCents: bigint; basePieces: number; sku: string | null; productName: string | null }
  >();
  for (const line of lines) {
    accumulators.set(line.id, {
      freightCents: BigInt(0),
      dutyCents: BigInt(0),
      otherCents: BigInt(0),
      basePieces: resolvePoLineCoveragePieces(line),
      sku: line.sku,
      productName: line.productName,
    });
  }

  const allocationsByChargeAndLine = new Map<string, number>();
  let totalFreight = BigInt(0);
  let totalDuty = BigInt(0);
  let totalOther = BigInt(0);

  if (lines.length === 0) {
    for (const charge of charges) {
      const amount = BigInt(costInteger(charge.amountCents, "charge.amountCents", 0));
      const cat = categorizePoLandedCostType(charge.costType);
      if (cat === "freight") totalFreight += amount;
      else if (cat === "duty") totalDuty += amount;
      else totalOther += amount;
    }
    const sum = totalFreight + totalDuty + totalOther;
    return {
      totalCents: costInteger(sum.toString(), "totalCents", 0),
      freightCents: costInteger(totalFreight.toString(), "freightCents", 0),
      dutyCents: costInteger(totalDuty.toString(), "dutyCents", 0),
      otherCents: costInteger(totalOther.toString(), "otherCents", 0),
      lineAllocations: [],
      allocationsByChargeAndLine,
    };
  }

  const basisInputs: ShipmentAllocationBasisLine[] = lines.map((line) => {
    const basePieces = resolvePoLineCoveragePieces(line);
    return {
      lineId: line.id,
      qtyShipped: basePieces,
      totalVolumeCbm: null,
      totalWeightKg: null,
      chargeableWeightKg: null,
      poLineId: line.id,
      poOrderQty: line.orderQty,
      poTotalProductCostCents: line.totalProductCostCents,
      poCurrency: line.currency,
    };
  });

  for (const charge of charges) {
    const effectiveCents = costInteger(charge.amountCents, "charge.amountCents", 0);
    const cat = categorizePoLandedCostType(charge.costType);
    if (cat === "freight") totalFreight += BigInt(effectiveCents);
    else if (cat === "duty") totalDuty += BigInt(effectiveCents);
    else totalOther += BigInt(effectiveCents);

    if (effectiveCents === 0) {
      for (const line of lines) {
        allocationsByChargeAndLine.set(`${charge.id}:${line.id}`, 0);
      }
      continue;
    }

    const method: PoLandedCostAllocationMethod = charge.allocationMethod;
    const basis = buildShipmentAllocationBasis(basisInputs, method);
    const distributed = allocateShipmentCents(effectiveCents, basis);
    for (const share of distributed) {
      allocationsByChargeAndLine.set(`${charge.id}:${share.lineId}`, share.allocatedCents);
      const acc = accumulators.get(share.lineId)!;
      if (cat === "freight") acc.freightCents += BigInt(share.allocatedCents);
      else if (cat === "duty") acc.dutyCents += BigInt(share.allocatedCents);
      else acc.otherCents += BigInt(share.allocatedCents);
    }
  }

  const lineAllocations: PoLandedCostLineAllocation[] = lines.map((line) => {
    const acc = accumulators.get(line.id)!;
    const lineTotal = acc.freightCents + acc.dutyCents + acc.otherCents;
    const totalMills = lineTotal * BigInt(100);
    const denom = BigInt(acc.basePieces);
    const unitMills = (totalMills * BigInt(2) + denom) / (denom * BigInt(2));
    return {
      purchaseOrderLineId: line.id,
      sku: acc.sku,
      productName: acc.productName,
      basePieces: acc.basePieces,
      freightCents: costInteger(acc.freightCents.toString(), "line.freightCents", 0),
      dutyCents: costInteger(acc.dutyCents.toString(), "line.dutyCents", 0),
      otherCents: costInteger(acc.otherCents.toString(), "line.otherCents", 0),
      totalAllocatedCents: costInteger(lineTotal.toString(), "line.totalAllocatedCents", 0),
      allocatedUnitMills: costInteger(unitMills.toString(), "line.allocatedUnitMills", 0),
    };
  });

  const grandTotal = totalFreight + totalDuty + totalOther;
  return {
    totalCents: costInteger(grandTotal.toString(), "totalCents", 0),
    freightCents: costInteger(totalFreight.toString(), "freightCents", 0),
    dutyCents: costInteger(totalDuty.toString(), "dutyCents", 0),
    otherCents: costInteger(totalOther.toString(), "otherCents", 0),
    lineAllocations,
    allocationsByChargeAndLine,
  };
}

export function buildPoLandedCostRevisionInputs(
  purchaseOrderId: number,
  lines: readonly PoLandedProductLineInput[],
  charges: readonly PoLandedCostRecord[],
): Array<{ lineId: number; input: CostRevisionInput; sourceEvidence: unknown }> {
  const allocated = allocatePoLandedCostsAcrossLines(purchaseOrderId, lines, charges);
  const byLine = new Map(allocated.lineAllocations.map((row) => [row.purchaseOrderLineId, row]));

  return lines.map((line) => {
    const lineShare = byLine.get(line.id)!;
    const totalMills = costInteger(
      (BigInt(lineShare.totalAllocatedCents) * BigInt(100)).toString(),
      "poLanded.totalMills",
      0,
    );
    const chargeSnapshot = charges.map((c) => ({
      id: c.id,
      costType: c.costType,
      amountCents: c.amountCents,
      currency: c.currency,
      allocationMethod: c.allocationMethod,
      vendorId: c.vendorId,
      vendorInvoiceId: c.vendorInvoiceId,
      allocatedCents: allocated.allocationsByChargeAndLine.get(`${c.id}:${line.id}`) ?? 0,
    }));

    const sources: CostRevisionInput["sources"] =
      charges.length > 0
        ? charges.map((charge) => ({
            kind: "shipment_cost" as const,
            documentId: purchaseOrderId,
            lineId: charge.id,
            version: costFingerprint({
              scope: "po_landed_cost",
              purchaseOrderId,
              purchaseOrderLineId: line.id,
              basePieces: lineShare.basePieces,
              charge: {
                id: charge.id,
                costType: charge.costType,
                amountCents: charge.amountCents,
                currency: charge.currency,
                allocationMethod: charge.allocationMethod,
                vendorId: charge.vendorId,
                vendorInvoiceId: charge.vendorInvoiceId,
              },
              allocatedCents: allocated.allocationsByChargeAndLine.get(`${charge.id}:${line.id}`) ?? 0,
            }),
          }))
        : [
            {
              kind: "purchase_order_line" as const,
              documentId: purchaseOrderId,
              lineId: line.id,
              version: costFingerprint({
                scope: "po_landed_cost_cleared",
                purchaseOrderId,
                purchaseOrderLineId: line.id,
                basePieces: lineShare.basePieces,
              }),
            },
          ];

    const input: CostRevisionInput = {
      contractVersion: 1,
      component: "landed",
      scope: {
        kind: "purchase_order_line",
        purchaseOrderId,
        purchaseOrderLineId: line.id,
      },
      sources,
      currency: "USD",
      totalMills,
      basePieces: lineShare.basePieces,
      evidence: "confirmed",
      packagingTreatment: "not_applicable",
      issue: null,
      manualOverride: null,
    };

    return {
      lineId: line.id,
      input,
      sourceEvidence: {
        kind: "po_landed_costs",
        purchaseOrderId,
        purchaseOrderLineId: line.id,
        basePieces: lineShare.basePieces,
        charges: chargeSnapshot,
      },
    };
  });
}
