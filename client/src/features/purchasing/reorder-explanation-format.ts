import { purchaseOrderRoundingSchema } from "@shared/procurement/purchase-order-rounding";

const percentFormat = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });

/** The forecast stores normalized fractions, not whole percentage points. */
export function formatForecastWeight(weight: unknown): string {
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) return "Weight unavailable";
  if (weight === 0) return "0%";
  if (weight > 0 && weight < 0.0001) return "<0.01%";
  return percentFormat.format(weight);
}

/** Never infer a historical rounding rule from the recommendation's current supplier mapping. */
export function formatOrderRounding(value: unknown): string {
  const parsed = purchaseOrderRoundingSchema.safeParse(value);
  if (!parsed.success) return "Rounding basis not recorded";
  const { incrementPieces, source } = parsed.data;
  if (source === "base_piece") return "Round up to whole pieces (no larger supplier increment recorded)";
  const sourceLabel = source === "supplier_quote" ? "supplier quote" : "supplier case pack";
  return `Round up in ${incrementPieces.toLocaleString("en-US")}-piece increments (${sourceLabel})`;
}
