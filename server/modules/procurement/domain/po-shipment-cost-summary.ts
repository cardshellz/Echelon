import {
  poShipmentCostSummarySchema,
  type PoShipmentCostSummary,
} from "@shared/procurement/po-shipment-cost-summary";
import { z } from "zod";

const integer = z.number().int().safe();
const id = integer.positive();
const inputSchema = z
  .object({
    poId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    poAmountCents: integer,
    shipmentIds: z.array(id),
    charges: z.array(
      z
        .object({
          id,
          shipmentId: id,
          costType: z.string(),
          currency: z.string().nullable(),
          amountCents: integer.nullable(),
          confirmed: z.boolean(),
          issue: z.string().nullable().optional(),
        })
        .strict(),
    ),
    allocations: z.array(
      z
        .object({
          costId: id,
          poId: integer.nonnegative(),
          lineId: id,
          allocatedCents: integer,
        })
        .strict(),
    ),
    lines: z.array(
      z
        .object({
          id,
          quantity: id,
          sourceTotalMills: integer.nullable(),
          sourceQuantity: id.nullable(),
          evidence: z.string().nullable(),
          applicationStatus: z.string().nullable(),
          issue: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export interface PoShipmentCharge {
  id: number;
  shipmentId: number;
  costType: string;
  currency: string | null;
  amountCents: number | null;
  confirmed: boolean;
  issue?: string | null;
}
export interface PoShipmentChargeAllocation {
  costId: number;
  poId: number;
  lineId: number;
  allocatedCents: number;
}
export interface PoShipmentCostLine {
  id: number;
  quantity: number;
  sourceTotalMills: number | null;
  sourceQuantity: number | null;
  evidence: string | null;
  applicationStatus: string | null;
  issue: string | null;
}

function safeAmount(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < -BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new RangeError(
      "Shipment cost summary exceeds supported integer precision",
    );
  return Number(value);
}

/** Supplier contractual totals and allocated shipment charges remain distinct.
 * Whole-shipment totals cannot be added to every PO in a consolidated shipment.
 */
export function buildPoShipmentCostSummary(input: {
  poId: number;
  currency: string;
  poAmountCents: number;
  shipmentIds: number[];
  charges: PoShipmentCharge[];
  allocations: PoShipmentChargeAllocation[];
  lines: PoShipmentCostLine[];
}): PoShipmentCostSummary {
  inputSchema.parse(input);
  const costIds = new Set(input.charges.map((charge) => charge.id));
  if (
    costIds.size !== input.charges.length ||
    input.charges.some(
      (charge) => !input.shipmentIds.includes(charge.shipmentId),
    ) ||
    input.allocations.some((allocation) => !costIds.has(allocation.costId))
  )
    throw new Error("Shipment cost summary has conflicting source identities.");
  let freight = BigInt(0),
    duty = BigInt(0),
    other = BigInt(0),
    estimated = BigInt(0);
  let unallocated = 0,
    unsupported = 0,
    applied = 0,
    review = 0,
    pending = 0;
  const supportedCostIds = new Set<number>();
  const confirmedCostIds = new Set<number>();
  const allocationsByCost = new Map<number, PoShipmentChargeAllocation[]>();
  const allocationsByLine = new Map<number, PoShipmentChargeAllocation[]>();
  for (const allocation of input.allocations) {
    allocationsByCost.set(allocation.costId, [
      ...(allocationsByCost.get(allocation.costId) ?? []),
      allocation,
    ]);
    allocationsByLine.set(allocation.lineId, [
      ...(allocationsByLine.get(allocation.lineId) ?? []),
      allocation,
    ]);
  }
  for (const charge of input.charges) {
    const allocations = allocationsByCost.get(charge.id) ?? [];
    const total = allocations.reduce(
      (sum, allocation) => sum + BigInt(allocation.allocatedCents),
      BigInt(0),
    );
    if (
      charge.amountCents === null ||
      total !== BigInt(charge.amountCents) ||
      allocations.length === 0
    )
      unallocated++;
    if (charge.currency !== input.currency) {
      unsupported++;
      continue;
    }
    supportedCostIds.add(charge.id);
    if (charge.confirmed && !charge.issue) confirmedCostIds.add(charge.id);
    const amount = allocations
      .filter((allocation) => allocation.poId === input.poId)
      .reduce(
        (sum, allocation) => sum + BigInt(allocation.allocatedCents),
        BigInt(0),
      );
    if (charge.costType === "freight") freight += amount;
    else if (charge.costType === "duty" || charge.costType === "tax")
      duty += amount;
    else other += amount;
    if (!charge.confirmed) estimated += amount;
  }
  for (const line of input.lines) {
    const lineAllocations = allocationsByLine.get(line.id) ?? [];
    const amount = lineAllocations
      .filter((allocation) => supportedCostIds.has(allocation.costId))
      .reduce(
        (sum, allocation) =>
          sum + BigInt(allocation.allocatedCents) * BigInt(100),
        BigInt(0),
      );
    const current =
      line.sourceTotalMills !== null &&
      BigInt(line.sourceTotalMills) === amount &&
      line.sourceQuantity === line.quantity;
    if (line.issue || line.applicationStatus === "review_required") review++;
    else if (
      current &&
      line.evidence === "confirmed" &&
      line.applicationStatus === "applied" &&
      lineAllocations.length > 0 &&
      lineAllocations.every((allocation) =>
        confirmedCostIds.has(allocation.costId),
      )
    )
      applied++;
    else pending++;
  }
  const total = freight + duty + other;
  return poShipmentCostSummarySchema.parse({
    currency: input.currency,
    shipmentCount: new Set(input.shipmentIds).size,
    chargeCount: input.charges.length,
    freightCents: safeAmount(freight),
    dutyCents: safeAmount(duty),
    otherCents: safeAmount(other),
    totalCents: safeAmount(total),
    poAmountCents: input.poAmountCents,
    combinedCostCents:
      unallocated > 0 || unsupported > 0
        ? null
        : safeAmount(BigInt(input.poAmountCents) + total),
    estimatedCents: safeAmount(estimated),
    unallocatedChargeCount: unallocated,
    unsupportedCurrencyCount: unsupported,
    appliedLines: applied,
    reviewLines: review,
    pendingLines: pending,
    inventoryCosting:
      input.charges.length === 0
        ? "no_costs"
        : review > 0 || input.charges.some((charge) => charge.issue)
          ? "review_required"
          : pending > 0 || unallocated > 0 || unsupported > 0
            ? "pending"
            : "applied",
  });
}
