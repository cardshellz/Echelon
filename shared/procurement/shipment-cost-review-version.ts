import type { ShipmentCostException } from "./shipment-cost-exception";

/** Old browser tabs parse strict DTOs; explicitly negotiate additive fields. */
export function shipmentCostReviewResponse<
  T extends { lines: Array<{ exceptionReview?: ShipmentCostException | null }> },
>(result: T, version: string | undefined) {
  if (version === "3") return result;
  return {
    ...result,
    lines: result.lines.map(({ exceptionReview, ...line }) => {
      if (version !== "2") return line;
      if (!exceptionReview) return { ...line, exceptionReview };
      const { reconciliation: _reconciliation, ...review } = exceptionReview;
      return { ...line, exceptionReview: review };
    }),
  };
}
