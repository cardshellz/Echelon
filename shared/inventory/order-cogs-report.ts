import { z } from "zod";

const integer = z.number().int().safe();
const identity = integer.positive();
const nonnegative = integer.nonnegative();
const MILLS_PATTERN = /^\d{1,19}$/;
const MAX_STORED_MILLS = BigInt("9223372036854775807");

function isMills(value: unknown): value is string {
  return typeof value === "string" && MILLS_PATTERN.test(value)
    && BigInt(value) <= MAX_STORED_MILLS;
}

// Exact costs are additive metadata. Older successful responses contain only
// integer cents and remain readable; provided mills must never lose precision.
const mills = z.string().refine(isMills, "Expected exact nonnegative integer mills").optional();
const lotSchema = z.object({
  lotId: identity,
  lotNumber: z.string(),
  qty: identity,
  unitCostCents: nonnegative,
  totalCostCents: nonnegative,
  unitCostMills: mills,
  totalCostMills: mills,
}).passthrough();

const lineSchema = z.object({
  orderItemId: identity,
  sku: z.string(),
  productName: z.string(),
  qty: nonnegative,
  revenueCents: nonnegative,
  cogsCents: nonnegative,
  cogsMills: mills,
  marginCents: integer,
  marginPercent: z.number().finite(),
  lotBreakdown: z.array(lotSchema),
}).passthrough();

function verifyDifference(
  context: z.RefinementCtx, path: (string | number)[], revenue: number, costs: number, margin: number,
) {
  // Refinements may execute after Zod records a fractional/unsafe number issue.
  // Never pass those already-invalid values to BigInt.
  if (![revenue, costs, margin].every(Number.isSafeInteger)) return;
  if (BigInt(revenue) - BigInt(costs) !== BigInt(margin)) {
    context.addIssue({ code: "custom", path, message: "Margin does not match recorded revenue and cost" });
  }
}

function verifyRoundedMills(
  context: z.RefinementCtx, path: (string | number)[], value: unknown, cents: number,
) {
  if (!isMills(value) || !Number.isSafeInteger(cents)) return;
  if ((BigInt(value) + BigInt(50)) / BigInt(100) !== BigInt(cents)) {
    context.addIssue({ code: "custom", path, message: "Cent display does not match the exact recorded cost" });
  }
}

function verifyMillsSum(
  context: z.RefinementCtx, path: (string | number)[], total: unknown, children: unknown[],
) {
  if (!isMills(total) || !children.every(isMills)) return;
  if (children.reduce((sum, value) => sum + BigInt(value), BigInt(0)) !== BigInt(total)) {
    context.addIssue({ code: "custom", path, message: "Exact recorded costs do not reconcile" });
  }
}

export const orderCOGSReportSchema = z.object({
  orderId: identity,
  orderNumber: z.string().min(1),
  totalRevenueCents: nonnegative,
  totalCogsCents: nonnegative,
  totalCogsMills: mills,
  grossMarginCents: integer,
  marginPercent: z.number().finite(),
  lineItems: z.array(lineSchema),
}).passthrough().superRefine((report, context) => {
  if (new Set(report.lineItems.map((line) => line.orderItemId)).size !== report.lineItems.length) {
    context.addIssue({ code: "custom", path: ["lineItems"], message: "Duplicate order item" });
  }
  verifyDifference(context, ["grossMarginCents"], report.totalRevenueCents, report.totalCogsCents, report.grossMarginCents);
  verifyRoundedMills(context, ["totalCogsCents"], report.totalCogsMills, report.totalCogsCents);
  // Order and line cents round independently. Only reconcile exact mills;
  // summing rounded children would reject valid fractional-cent allocations.
  verifyMillsSum(context, ["totalCogsMills"], report.totalCogsMills, report.lineItems.map((line) => line.cogsMills));
  report.lineItems.forEach((line, index) => {
    const path = ["lineItems", index];
    verifyDifference(context, [...path, "marginCents"], line.revenueCents, line.cogsCents, line.marginCents);
    verifyRoundedMills(context, [...path, "cogsCents"], line.cogsMills, line.cogsCents);
    verifyMillsSum(context, [...path, "cogsMills"], line.cogsMills, line.lotBreakdown.map((lot) => lot.totalCostMills));
    line.lotBreakdown.forEach((lot, lotIndex) => {
      verifyRoundedMills(context, [...path, "lotBreakdown", lotIndex, "unitCostCents"], lot.unitCostMills, lot.unitCostCents);
      verifyRoundedMills(context, [...path, "lotBreakdown", lotIndex, "totalCostCents"], lot.totalCostMills, lot.totalCostCents);
    });
  });
});

export type OrderCOGSResult = z.infer<typeof orderCOGSReportSchema>;
export type OrderLineCOGS = z.infer<typeof lineSchema>;

export class OrderCOGSResponseError extends Error {
  readonly code = "ORDER_COGS_RESPONSE_INVALID";
  constructor(readonly fields: string[]) {
    super("The order cost response is incomplete or invalid. Retry to load the recorded totals.");
    this.name = "OrderCOGSResponseError";
  }
}

export function parseOrderCOGSReport(value: unknown): OrderCOGSResult {
  const result = orderCOGSReportSchema.safeParse(value);
  if (!result.success) throw new OrderCOGSResponseError(result.error.issues.map((issue) => issue.path.join(".")));
  return result.data;
}

// Recognize only the documented error code; never present arbitrary server
// messages or unvalidated currency text as instructions to the operator.
export const unsupportedOrderCOGSCurrencySchema = z.object({
  code: z.literal("ORDER_COGS_CURRENCY_UNSUPPORTED"),
}).passthrough();
