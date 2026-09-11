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
// Raw PostgreSQL BIGINT values are strings. Accept integer strings only, and
// reject precision loss before any monetary arithmetic or JSON serialization.
const cents = z.union([nonnegative, z.string().regex(/^\d{1,19}$/).transform(Number).pipe(nonnegative)]);
const mills = z.union([nonnegative, z.string().regex(/^\d{1,19}$/)])
  .transform((value) => BigInt(value)).pipe(z.bigint().nonnegative().max(BigInt("9223372036854775807")));
const costRowSchema = z.object({
  order_id: identity,
  order_item_id: identity,
  lot_id: identity,
  qty_consumed: identity,
  unit_cost_cents: cents,
  total_cost_cents: cents,
  unit_cost_mills: mills,
  total_cost_mills: mills,
  lot_number: z.string().nullable(),
});
const snapshotSchema = z.object({
  order: z.object({ id: identity, orderNumber: z.string().min(1), totalCents: cents, currency: z.string().regex(/^[A-Z]{3}$/) }),
  items: z.array(z.object({
    id: identity, sku: z.string(), name: z.string(), quantity: nonnegative, totalPriceCents: cents,
  })),
  costs: z.array(costRowSchema),
});
type CostRow = z.infer<typeof costRowSchema>;

function exactNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new OrderCOGSReadError({ fields: [field] });
  return result;
}

function roundedCents(value: bigint, field: string): number {
  return exactNumber((value + BigInt(50)) / BigInt(100), field);
}

function recordedMills(precise: bigint, legacyCents: number): bigint {
  // Older rows were written before the mills mirrors were populated. Preserve
  // the same zero-mills legacy fallback used by existing cost revaluation.
  return precise === BigInt(0) && legacyCents !== 0 ? BigInt(legacyCents) * BigInt(100) : precise;
}

function totalMills(rows: readonly CostRow[]): bigint {
  return rows.reduce((sum, row) => sum + recordedMills(row.total_cost_mills, row.total_cost_cents), BigInt(0));
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
  const lineItems = items.map((item): OrderLineCOGS => {
    const rows = costsByItem.get(item.id) ?? [];
    const cogsMills = totalMills(rows);
    const cogsCents = roundedCents(cogsMills, "line.cogsCents");
    const marginCents = exactNumber(BigInt(item.totalPriceCents) - BigInt(cogsCents), "line.marginCents");
    return {
      orderItemId: item.id, sku: item.sku, productName: item.name, qty: item.quantity,
      revenueCents: item.totalPriceCents, cogsCents, cogsMills: String(cogsMills), marginCents,
      marginPercent: marginPercent(marginCents, item.totalPriceCents),
      lotBreakdown: rows.map((row) => ({
        lotId: row.lot_id, lotNumber: row.lot_number ?? "", qty: row.qty_consumed,
        unitCostCents: roundedCents(recordedMills(row.unit_cost_mills, row.unit_cost_cents), "lot.unitCostCents"),
        totalCostCents: roundedCents(recordedMills(row.total_cost_mills, row.total_cost_cents), "lot.totalCostCents"),
        unitCostMills: String(recordedMills(row.unit_cost_mills, row.unit_cost_cents)),
        totalCostMills: String(recordedMills(row.total_cost_mills, row.total_cost_cents)),
      })),
    };
  });
  // Aggregate the authoritative extended mills before rounding. Summing each
  // lot/line's rounded cent display would lose small costs (e.g. 49 + 49 mills).
  const totalCogsMills = totalMills(costs);
  const totalCogsCents = roundedCents(totalCogsMills, "totalCogsCents");
  const grossMarginCents = exactNumber(BigInt(order.totalCents) - BigInt(totalCogsCents), "grossMarginCents");
  return parseOrderCOGSReport({
    orderId: order.id, orderNumber: order.orderNumber, totalRevenueCents: order.totalCents,
    totalCogsCents, totalCogsMills: String(totalCogsMills), grossMarginCents,
    marginPercent: marginPercent(grossMarginCents, order.totalCents), lineItems,
  });
}
