import type { ShipmentCostException } from "./shipment-cost-exception";

/** Old browser tabs parse strict DTOs; explicitly negotiate additive fields. */
export function shipmentCostReviewResponse<
  T extends { lines: Array<{ exceptionReview?: ShipmentCostException | null; purchaseOrderLineId?: number | null }> },
>(result: T, version: string | undefined, includePoLineLinks = false) {
  if (version === "3" && includePoLineLinks) return result;
  return {
    ...result,
    lines: result.lines.map(({ exceptionReview, purchaseOrderLineId, ...fields }) => {
      const line = includePoLineLinks && purchaseOrderLineId !== undefined ? { ...fields, purchaseOrderLineId } : fields;
      if (version === "3") return exceptionReview === undefined ? line : { ...line, exceptionReview };
      if (version !== "2") return line;
      if (!exceptionReview) return { ...line, exceptionReview };
      const { reconciliation: _reconciliation, ...review } = exceptionReview;
      return { ...line, exceptionReview: review };
    }),
  };
}
