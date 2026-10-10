// ---------------------------------------------------------------------------
// PO line taxonomy (migration 0563)
// ---------------------------------------------------------------------------
// product     — ordered goods. requires product_id. cost_mills >= 0, qty > 0.
// discount    — flat/percent discount line. no variant. cost_mills <= 0, qty == 1.
// fee         — freight, tooling, surcharge. no variant. cost_mills >= 0, qty >= 1.
// tax         — itemized tax. no variant. cost_mills >= 0, qty == 1.
// rebate      — forward-looking rebate. no variant. cost_mills <= 0, qty == 1.
// adjustment  — catch-all. signed. qty == 1.
export const PO_LINE_TYPES = [
  "product",
  "discount",
  "fee",
  "tax",
  "rebate",
  "adjustment",
] as const;

export type PoLineType = (typeof PO_LINE_TYPES)[number];

export function isPoLineType(value: unknown): value is PoLineType {
  return typeof value === "string" && (PO_LINE_TYPES as readonly string[]).includes(value);
}
