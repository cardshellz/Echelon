/** Callers validate their date representation before selecting a source. A line
 * promise is the most specific supplier date; a line request overrides the
 * header, and a confirmed header date supersedes the original header request. */
export function resolvePurchaseOrderArrival(input: {
  promisedDate: string | null;
  expectedDate: string | null;
  confirmedDate: string | null;
  purchaseExpectedDate: string | null;
}): { date: string | null; source: "line_promised" | "line_expected" | "purchase_confirmed" | "purchase_expected" | null } {
  if (input.promisedDate !== null) return { date: input.promisedDate, source: "line_promised" };
  if (input.expectedDate !== null) return { date: input.expectedDate, source: "line_expected" };
  if (input.confirmedDate !== null) return { date: input.confirmedDate, source: "purchase_confirmed" };
  return { date: input.purchaseExpectedDate, source: input.purchaseExpectedDate === null ? null : "purchase_expected" };
}

