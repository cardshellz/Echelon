import { z } from "zod";

const safeInteger = z.number().int().safe();
const quantity = safeInteger.nonnegative();
const identity = safeInteger.positive();
const INTEGER_MONEY_PATTERN = /^-?\d{1,19}$/;
const MIN_STORED_MONEY = BigInt("-9223372036854775808");
const MAX_STORED_MONEY = BigInt("9223372036854775807");
const isoOrLocalDateTime = z.string().datetime({ offset: true, local: true });
// Raw Drizzle PostgreSQL reads preserve timestamp-without-time-zone strings
// (a space separator and no offset). Validate that representation without
// changing the existing date semantics or serialized DTO.
const recordedDateTime = z.union([
  z.string().refine((value) => isoOrLocalDateTime.safeParse(value.replace(" ", "T")).success, "Invalid recorded timestamp"),
  z.date(),
]);

// PostgreSQL BIGINT columns arrive as strings in raw lot queries. Keep those
// values exact; validation must not coerce them through a JavaScript number.
const storedMoney = z.union([
  safeInteger,
  z.string().refine((value) => {
    if (!INTEGER_MONEY_PATTERN.test(value)) return false;
    const amount = BigInt(value);
    return amount >= MIN_STORED_MONEY && amount <= MAX_STORED_MONEY;
  }, "Money exceeds PostgreSQL BIGINT precision"),
]).nullable();

const valuationProduct = z.object({
  productId: identity,
  productName: z.string(),
  baseSku: z.string(),
  totalQty: quantity,
  avgCostPerPiece: safeInteger,
  totalValueCents: safeInteger,
  activeLots: quantity,
  zeroCostQty: quantity,
  hasLandedPending: z.boolean(),
}).passthrough();

// Extra fields remain compatible with additive API releases, while every
// field needed to distinguish a recorded zero from missing data is required.
export const inventoryValuationReportSchema = z.object({
  totalValueCents: safeInteger,
  totalQty: quantity,
  zeroCostQty: quantity,
  provisionalQty: quantity,
  landedPendingLots: quantity,
  landedPendingValueCents: safeInteger,
  byProduct: z.array(valuationProduct),
}).passthrough().superRefine((report, context) => {
  const productIds = report.byProduct.map((product) => product.productId);
  if (new Set(productIds).size !== productIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["byProduct"], message: "Duplicate product valuation" });
  }
  // These totals are sums of the returned groups in the existing service.
  // Check them exactly without changing valuation or rounding any money.
  for (const field of ["totalValueCents", "totalQty", "zeroCostQty"] as const) {
    // Zod can run refinements after a numeric range/int check fails. Avoid
    // converting an already-invalid fractional value to BigInt.
    if (!Number.isSafeInteger(report[field]) || !report.byProduct.every((product) => Number.isSafeInteger(product[field]))) continue;
    const sum = report.byProduct.reduce((total, product) => total + BigInt(product[field]), BigInt(0));
    if (sum !== BigInt(report[field])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Summary does not match the returned product valuations" });
    }
  }
});

export const costLotReportSchema = z.object({
  id: identity,
  lot_number: z.string(),
  product_id: identity,
  product_name: z.string(),
  base_sku: z.string().nullable(),
  sku: z.string().nullable(),
  qty_on_hand: quantity,
  qty_received: quantity.nullable(),
  units_per_variant: identity,
  po_unit_cost_mills: storedMoney,
  landed_cost_mills: storedMoney,
  total_unit_cost_mills: storedMoney,
  unit_cost_mills: storedMoney,
  po_unit_cost_cents: storedMoney,
  landed_cost_cents: storedMoney,
  total_unit_cost_cents: storedMoney,
  unit_cost_cents: storedMoney,
  cost_provisional: z.union([z.literal(0), z.literal(1)]),
  cost_source: z.string().nullable(),
  received_at: recordedDateTime.nullish(),
  age_days: z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]).nullish(),
  batch_number: z.string().nullish(),
  inbound_shipment_id: identity.nullish(),
}).passthrough();

export const costLotsReportSchema = z.object({
  lots: z.array(costLotReportSchema),
  total: quantity,
// The existing owner reads count and page separately. A committed insertion
// between those reads can make this page larger than the earlier count; that
// is not a malformed report and must not turn a successful read into an error.
}).passthrough();

export type InventoryValuationReport = z.infer<typeof inventoryValuationReportSchema>;
export type CostLotReport = z.infer<typeof costLotReportSchema>;
export type CostLotsReport = z.infer<typeof costLotsReportSchema>;

export class CostReportResponseError extends Error {
  readonly code = "COST_REPORT_RESPONSE_INVALID";

  constructor(readonly report: "valuation" | "lots", readonly fields: string[]) {
    super(`The ${report === "valuation" ? "inventory valuation" : "cost lot"} response is incomplete or invalid. Retry to load the report again.`);
    this.name = "CostReportResponseError";
  }
}

export function parseInventoryValuationReport(value: unknown): InventoryValuationReport {
  const result = inventoryValuationReportSchema.safeParse(value);
  if (!result.success) {
    throw new CostReportResponseError("valuation", result.error.issues.map((issue) => issue.path.join(".")));
  }
  return result.data;
}

export function parseCostLotsReport(value: unknown): CostLotsReport {
  const result = costLotsReportSchema.safeParse(value);
  if (!result.success) {
    throw new CostReportResponseError("lots", result.error.issues.map((issue) => issue.path.join(".")));
  }
  return result.data;
}
