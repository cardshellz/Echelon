import { z } from "zod";
import { parseOrderCOGSReport, type OrderCOGSResult, type OrderLineCOGS } from "@shared/inventory/order-cogs-report";
export type { OrderCOGSResult, OrderLineCOGS } from "@shared/inventory/order-cogs-report";

export class OrderCOGSReadError extends Error {
  readonly code = "ORDER_COGS_INVALID_DATA";

  constructor(readonly context: { fields: string[] }) {
    super("Recorded order costs or financial totals are incomplete or outside the supported range.");
    this.name = "OrderCOGSReadError";
  }
}

export class OrderCOGSCurrencyError extends Error {
  readonly code = "ORDER_COGS_CURRENCY_UNSUPPORTED";
  constructor(readonly currency: string) {
    super(`Order currency ${currency} cannot be compared with USD inventory costs without a recorded currency conversion.`);
    this.name = "OrderCOGSCurrencyError";
  }
}

const integer = z.number().int().safe();
const identity = integer.positive();
const nonnegative = integer.nonnegative();
const nonzeroSignedQty = z.union([
  integer.refine((n) => n !== 0),
  z.string().regex(/^-?[1-9]\d{0,9}$/).transform(Number).pipe(integer.refine((n) => n !== 0)),
]);
// Raw PostgreSQL BIGINT values are strings. Accept integer strings only, and
// reject precision loss before any monetary arithmetic or JSON serialization.
const cents = z.union([nonnegative, z.string().regex(/^\d{1,19}$/).transform(Number).pipe(nonnegative)]);
const signedCents = z.union([integer, z.string().regex(/^-?\d{1,19}$/).transform(Number).pipe(integer)]);
const MAX_STORED_MILLS = BigInt("9223372036854775807");
const mills = z.union([nonnegative, z.string().regex(/^\d{1,19}$/)])
  .transform((value) => BigInt(value))
  .pipe(z.bigint().nonnegative().max(MAX_STORED_MILLS));
const signedMills = z.union([integer, z.string().regex(/^-?\d{1,19}$/)])
  .transform((value) => BigInt(value))
  .pipe(z.bigint().min(-MAX_STORED_MILLS).max(MAX_STORED_MILLS));

const costRowSchema = z.object({
  order_id: identity,
  order_item_id: identity,
  lot_id: identity,
  qty_consumed: nonzeroSignedQty,
  unit_cost_cents: cents,
  total_cost_cents: signedCents,
  unit_cost_mills: mills,
  total_cost_mills: signedMills,
  lot_number: z.string().nullable(),
}).superRefine((row, ctx) => {
  // Positive consumption rows must never carry negative extended costs;
  // negative compensating rows (canonical unpicks / restocked returns) must carry <= 0 extended costs.
  if (row.qty_consumed > 0) {
    if (row.total_cost_cents < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["total_cost_cents"], message: "Positive consumption cannot have negative cost cents" });
    }
    if (row.total_cost_mills < BigInt(0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["total_cost_mills"], message: "Positive consumption cannot have negative cost mills" });
    }
  } else {
    if (row.total_cost_cents > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["total_cost_cents"], message: "Compensating reversal cannot have positive cost cents" });
    }
    if (row.total_cost_mills > BigInt(0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["total_cost_mills"], message: "Compensating reversal cannot have positive cost mills" });
    }
  }
});

const snapshotSchema = z.object({
  order: z.object({ id: identity, orderNumber: z.string().min(1), totalCents: cents, currency: z.string().regex(/^[A-Z]{3}$/) }),
  items: z.array(z.object({
    id: identity, sku: z.string(), name: z.string(), quantity: nonnegative, totalPriceCents: cents,
  })),
  costs: z.array(costRowSchema),
});
type CostRow = z.infer<typeof costRowSchema>;

interface NetLotCostLayer {
  lotId: number;
  lotNumber: string;
  qty: number;
  unitCostMills: bigint;
  totalCostMills: bigint;
}

function exactNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new OrderCOGSReadError({ fields: [field] });
  return result;
}

function roundedCents(value: bigint, field: string): number {
  return exactNumber((value + BigInt(50)) / BigInt(100), field);
}

function recordedUnitMills(precise: bigint, legacyCents: number): bigint {
  return precise === BigInt(0) && legacyCents !== 0 ? BigInt(legacyCents) * BigInt(100) : precise;
}

function recordedTotalMills(precise: bigint, legacyCents: number): bigint {
  // Older rows were written before the mills mirrors were populated. Preserve
  // the same zero-mills legacy fallback used by existing cost revaluation.
  return precise === BigInt(0) && legacyCents !== 0 ? BigInt(legacyCents) * BigInt(100) : precise;
}

function netItemCostLayers(rows: readonly CostRow[]): NetLotCostLayer[] {
  const hasCompensatingRows = rows.some((row) => row.qty_consumed < 0);
  if (!hasCompensatingRows) {
    // Preserve exact 1:1 row breakdown when no unpick or return reversal exists
    // (same lot picked twice on the same line stays distinct in lotBreakdown).
    return rows.map((row) => ({
      lotId: row.lot_id,
      lotNumber: row.lot_number ?? "",
      qty: row.qty_consumed,
      unitCostMills: recordedUnitMills(row.unit_cost_mills, row.unit_cost_cents),
      totalCostMills: recordedTotalMills(row.total_cost_mills, row.total_cost_cents),
    }));
  }

  const byLot = new Map<number, {
    lotId: number;
    lotNumber: string;
    qty: bigint;
    totalCostMills: bigint;
    lastPositiveUnitMills: bigint;
  }>();
  for (const row of rows) {
    const unitMills = recordedUnitMills(row.unit_cost_mills, row.unit_cost_cents);
    const extMills = recordedTotalMills(row.total_cost_mills, row.total_cost_cents);
    const existing = byLot.get(row.lot_id) ?? {
      lotId: row.lot_id,
      lotNumber: row.lot_number ?? "",
      qty: BigInt(0),
      totalCostMills: BigInt(0),
      lastPositiveUnitMills: unitMills,
    };
    existing.qty += BigInt(row.qty_consumed);
    existing.totalCostMills += extMills;
    if (row.qty_consumed > 0) {
      existing.lastPositiveUnitMills = unitMills;
    }
    if (!existing.lotNumber && row.lot_number) {
      existing.lotNumber = row.lot_number;
    }
    byLot.set(row.lot_id, existing);
  }

  const netLayers: NetLotCostLayer[] = [];
  for (const entry of byLot.values()) {
    if (entry.qty < BigInt(0) || entry.totalCostMills < BigInt(0)) {
      throw new OrderCOGSReadError({ fields: ["costs.qty_consumed"] });
    }
    if (entry.qty === BigInt(0)) {
      if (entry.totalCostMills !== BigInt(0)) {
        throw new OrderCOGSReadError({ fields: ["costs.total_cost_mills"] });
      }
      continue;
    }
    const qty = exactNumber(entry.qty, "lot.qty");
    const derivedUnitMills =
      entry.lastPositiveUnitMills * entry.qty === entry.totalCostMills
        ? entry.lastPositiveUnitMills
        : (entry.totalCostMills * BigInt(2) + entry.qty) / (entry.qty * BigInt(2));
    netLayers.push({
      lotId: entry.lotId,
      lotNumber: entry.lotNumber,
      qty,
      unitCostMills: derivedUnitMills,
      totalCostMills: entry.totalCostMills,
    });
  }
  return netLayers;
}

function marginPercent(margin: number, revenue: number): number {
  if (revenue === 0) return 0;
  const numerator = BigInt(margin) * BigInt(10_000);
  const denominator = BigInt(revenue);
  const magnitude = numerator < BigInt(0) ? -numerator : numerator;
  // Percentages alone become decimals for display. Money remains integer cents;
  // round the percentage to two decimals, with half ties away from zero.
  const basisPoints = (magnitude * BigInt(2) + denominator) / (denominator * BigInt(2));
  return exactNumber(numerator < BigInt(0) ? -basisPoints : basisPoints, "marginPercent") / 100;
}

/** Assemble a report from recorded WMS financial snapshots and live COGS rows.
 * The order total intentionally preserves the existing API's order-total basis.
 * Line revenue uses the recorded extended amount: multiplying a rounded unit
 * price can lose line-level discount/rounding cents. Missing prices are errors.
 */
export function buildOrderCOGSReport(value: unknown): OrderCOGSResult {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrderCOGSReadError({ fields: parsed.error.issues.map((issue) => issue.path.join(".")) });
  }
  const { order, items, costs } = parsed.data;
  if (order.currency !== "USD") throw new OrderCOGSCurrencyError(order.currency);
  const itemIds = new Set(items.map((item) => item.id));
  if (itemIds.size !== items.length) throw new OrderCOGSReadError({ fields: ["items.id"] });
  const costsByItem = new Map<number, CostRow[]>();
  for (const row of costs) {
    if (row.order_id !== order.id || !itemIds.has(row.order_item_id)) {
      throw new OrderCOGSReadError({ fields: ["costs.order_item_id"] });
    }
    const rows = costsByItem.get(row.order_item_id) ?? [];
    rows.push(row);
    costsByItem.set(row.order_item_id, rows);
  }
  let totalCogsMills = BigInt(0);
  const lineItems = items.map((item): OrderLineCOGS => {
    const netLayers = netItemCostLayers(costsByItem.get(item.id) ?? []);
    const cogsMills = netLayers.reduce((sum, layer) => sum + layer.totalCostMills, BigInt(0));
    if (cogsMills > MAX_STORED_MILLS) {
      throw new OrderCOGSReadError({ fields: ["line.cogsMills"] });
    }
    totalCogsMills += cogsMills;
    const cogsCents = roundedCents(cogsMills, "line.cogsCents");
    const marginCents = exactNumber(BigInt(item.totalPriceCents) - BigInt(cogsCents), "line.marginCents");
    return {
      orderItemId: item.id, sku: item.sku, productName: item.name, qty: item.quantity,
      revenueCents: item.totalPriceCents, cogsCents, cogsMills: String(cogsMills), marginCents,
      marginPercent: marginPercent(marginCents, item.totalPriceCents),
      lotBreakdown: netLayers.map((layer) => ({
        lotId: layer.lotId, lotNumber: layer.lotNumber, qty: layer.qty,
        unitCostCents: roundedCents(layer.unitCostMills, "lot.unitCostCents"),
        totalCostCents: roundedCents(layer.totalCostMills, "lot.totalCostCents"),
        unitCostMills: String(layer.unitCostMills),
        totalCostMills: String(layer.totalCostMills),
      })),
    };
  });
  if (totalCogsMills > MAX_STORED_MILLS) {
    throw new OrderCOGSReadError({ fields: ["totalCogsMills"] });
  }
  const totalCogsCents = roundedCents(totalCogsMills, "totalCogsCents");
  const grossMarginCents = exactNumber(BigInt(order.totalCents) - BigInt(totalCogsCents), "grossMarginCents");
  return parseOrderCOGSReport({
    orderId: order.id, orderNumber: order.orderNumber, totalRevenueCents: order.totalCents,
    totalCogsCents, totalCogsMills: String(totalCogsMills), grossMarginCents,
    marginPercent: marginPercent(grossMarginCents, order.totalCents), lineItems,
  });
}
