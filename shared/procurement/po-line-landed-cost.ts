import { z } from "zod";

const cents = z.number().int().safe();
const id = z.number().int().positive().safe();
const optionalHeaderCents = cents.nullish().transform((value) => value ?? 0);
const inputSchema = z.object({
  poHeader: z.object({
    totalCents: cents,
    discountCents: optionalHeaderCents,
    taxCents: optionalHeaderCents,
    shippingCostCents: optionalHeaderCents,
  }),
  poLines: z.array(
    z.object({
      id,
      orderQty: z.number().int().nonnegative().safe(),
      lineTotalCents: cents,
      status: z.string().optional(),
    }),
  ),
  costs: z.object({
    summary: z.object({
      totalCents: cents,
      poAmountCents: cents,
      combinedCostCents: cents.nullable(),
    }),
    lines: z.array(
      z.object({
        lineId: id,
        purchaseOrderLineId: id.nullable().optional(),
        allocatedCents: cents,
      }),
    ),
  }),
});

export interface PoLandedCostLine {
  purchaseOrderLineId: number;
  pieces: number;
  supplierCents: number;
  shipmentCents: number;
  totalCents: number;
}
export type PoLineLandedCosts =
  | {
      status: "complete";
      lines: PoLandedCostLine[];
      poLevelAdjustmentCents: number;
    }
  | { status: "unavailable"; reason: string };

function safeCents(amount: bigint): number | null {
  return amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    amount < BigInt(-Number.MAX_SAFE_INTEGER)
    ? null
    : Number(amount);
}

/** Read projection only: use the saved charge allocations, never split a whole
 * shipment again or match by SKU. Supplier line totals already include packaging,
 * line discounts and tax. PO-level adjustments are kept separate rather than
 * inventing an allocation policy for them. */
export function projectPoLineLandedCosts(input: unknown): PoLineLandedCosts {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    return {
      status: "unavailable",
      reason: "Line cost details are unavailable.",
    };
  const { poHeader, costs } = parsed.data;
  // The purchasing total owner excludes cancelled lines and treats absent
  // header charges as zero. Check those same saved amounts; a difference is
  // not evidence of a new charge or discount.
  const poLines = parsed.data.poLines.filter(
    (line) => line.status !== "cancelled",
  );
  if (costs.summary.combinedCostCents === null)
    return {
      status: "unavailable",
      reason:
        "Complete the shipment charge allocation and currency review to calculate landed costs.",
    };
  if (
    BigInt(costs.summary.combinedCostCents) !==
    BigInt(costs.summary.poAmountCents) + BigInt(costs.summary.totalCents)
  )
    return {
      status: "unavailable",
      reason:
        "The supplier and shipment amounts do not reconcile to the landed total.",
    };
  const lineIds = new Set(poLines.map((line) => line.id));
  const shipmentLineIds = new Set(costs.lines.map((line) => line.lineId));
  if (
    lineIds.size !== poLines.length ||
    shipmentLineIds.size !== costs.lines.length ||
    costs.lines.some(
      (line) =>
        line.purchaseOrderLineId == null ||
        !lineIds.has(line.purchaseOrderLineId),
    )
  )
    return {
      status: "unavailable",
      reason: "Shipment charges are missing a unique purchase order line link.",
    };
  const allocated = new Map<number, bigint>();
  let allocatedTotal = BigInt(0);
  for (const line of costs.lines) {
    const amount = BigInt(line.allocatedCents);
    allocated.set(
      line.purchaseOrderLineId!,
      (allocated.get(line.purchaseOrderLineId!) ?? BigInt(0)) + amount,
    );
    allocatedTotal += amount;
  }
  if (allocatedTotal !== BigInt(costs.summary.totalCents))
    return {
      status: "unavailable",
      reason:
        "The saved line allocations do not cover the shipment charge total.",
    };
  const lines: PoLandedCostLine[] = [];
  let supplierTotal = BigInt(0);
  for (const line of poLines) {
    const shipment = allocated.get(line.id) ?? BigInt(0);
    const shipmentCents = safeCents(shipment);
    const totalCents = safeCents(BigInt(line.lineTotalCents) + shipment);
    if (shipmentCents === null || totalCents === null)
      return {
        status: "unavailable",
        reason: "The landed amount exceeds the supported currency range.",
      };
    supplierTotal += BigInt(line.lineTotalCents);
    lines.push({
      purchaseOrderLineId: line.id,
      pieces: line.orderQty,
      supplierCents: line.lineTotalCents,
      shipmentCents,
      totalCents,
    });
  }
  const adjustment = safeCents(
    BigInt(poHeader.taxCents) +
      BigInt(poHeader.shippingCostCents) -
      BigInt(poHeader.discountCents),
  );
  if (adjustment === null)
    return {
      status: "unavailable",
      reason: "The supplier adjustment exceeds the supported currency range.",
    };
  if (
    poHeader.totalCents !== costs.summary.poAmountCents ||
    supplierTotal + BigInt(adjustment) !== BigInt(poHeader.totalCents)
  )
    return {
      status: "unavailable",
      reason:
        "The PO line amounts do not reconcile to the current PO total. Reload costs before using the landed line amounts.",
    };
  return { status: "complete", lines, poLevelAdjustmentCents: adjustment };
}

/** Display-only half-up rounding to six decimals. Exact line cents remain the
 * authority; this rate must never be multiplied back to create a posting. */
export function formatLandedCostPerPiece(
  amountCents: number,
  pieces: number,
  currency: string,
): string | null {
  if (
    !Number.isSafeInteger(amountCents) ||
    !Number.isSafeInteger(pieces) ||
    pieces <= 0 ||
    !/^[A-Z]{3}$/.test(currency)
  )
    return null;
  const signed = BigInt(amountCents);
  const magnitude = signed < BigInt(0) ? -signed : signed;
  const divisor = BigInt(pieces);
  const micros = (magnitude * BigInt(10000) + divisor / BigInt(2)) / divisor;
  const whole = micros / BigInt(1000000);
  const fraction = String(micros % BigInt(1000000)).padStart(6, "0");
  const displayWhole =
    signed < BigInt(0) ? (whole === BigInt(0) ? -0 : -whole) : whole;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  })
    .formatToParts(displayWhole)
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}
