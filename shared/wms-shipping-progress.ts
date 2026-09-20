import { z } from "zod";
import { WMS_WAREHOUSE_STATUS_VALUES, type WmsWarehouseStatus } from "./enums/order-status";

const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const lineSchema = z.object({
  id: z.number().int().positive().safe(),
  requiresShipping: z.boolean(),
  cancelled: z.boolean(),
  quantity,
  authorizedQuantity: quantity.nullable(),
  pickedQuantity: quantity,
  shippedQuantity: quantity,
}).strict();

export type WmsShippingProgressLine = z.infer<typeof lineSchema>;

export class WmsShippingProgressError extends Error {
  readonly code = "INVALID_SHIPPING_PROGRESS_EVIDENCE";
  constructor(message: string, public readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "WmsShippingProgressError";
  }
}

const progressSchema = z.object({
  status: z.enum(WMS_WAREHOUSE_STATUS_VALUES),
  lines: z.array(lineSchema),
});

/**
 * Shipping completion is coverage of physical ORDER LINES, not completion of
 * whatever shipment headers happen to exist. Missing shipments are zero
 * coverage; extra units on one line cannot cover a different line. A cancelled
 * shipment is not a cancelled order line, and a short/backorder is still demand.
 * Callers supply quantities from shipment evidence, never mutable order totals.
 */
export function deriveWmsShippingProgress(
  currentStatus: WmsWarehouseStatus | "pending",
  input: readonly WmsShippingProgressLine[],
): WmsWarehouseStatus {
  // Older persisted WMS records used 'pending' for the pre-pick state.
  // Recognize that explicit legacy value, not arbitrary unknown statuses.
  const parsed = progressSchema.safeParse({
    status: currentStatus === "pending" ? "ready" : currentStatus,
    lines: input,
  });
  if (!parsed.success) {
    throw new WmsShippingProgressError("Invalid WMS shipping progress evidence", { issues: parsed.error.issues });
  }
  const { status, lines } = parsed.data;
  if (new Set(lines.map(line => line.id)).size !== lines.length) {
    throw new WmsShippingProgressError("Duplicate order line in WMS shipping progress evidence");
  }
  const physical = lines.filter(line => line.requiresShipping && !line.cancelled)
    .map(line => ({
      ...line,
      required: Math.min(line.quantity, line.authorizedQuantity ?? line.quantity),
    }))
    .filter(line => line.required > 0);

  if (physical.length === 0) return status;
  if (physical.every(line => line.shippedQuantity >= line.required)) return "shipped";
  // Preserve explicit cancellation unless complete physical shipment evidence
  // proves the goods left despite cancellation (the existing truth-wins rule).
  if (status === "cancelled") return status;
  if (physical.some(line => line.shippedQuantity > 0)) return "partially_shipped";

  if (["on_hold", "exception", "awaiting_3pl", "picking"].includes(status)) return status;
  if (physical.every(line => line.pickedQuantity >= line.required)) {
    return ["picked", "packing", "packed", "completed", "ready_to_ship"].includes(status)
      ? status : "in_progress";
  }
  return physical.some(line => line.pickedQuantity > 0) ? "in_progress" : "ready";
}
