import { z } from "zod";
import {
  WMS_WAREHOUSE_STATUS_VALUES,
  type WmsWarehouseStatus,
} from "./enums/order-status";
import { isUnmappedOrderLine } from "./unmapped-order-line";

// Warehouse settings already support staged handoff (inventory.schema.ts).
export type WmsPickingStatus = WmsWarehouseStatus | "staged";
const pickingStatus = z.enum([...WMS_WAREHOUSE_STATUS_VALUES, "staged"]);

const quantity = z.number().int().nonnegative().max(2_147_483_647);
export const wmsPickingProgressLineSchema = z
  .object({
    id: z.number().int().positive().safe(),
    sku: z.string(),
    quantity,
    pickedQuantity: quantity,
    requiresShipping: z.boolean(),
    onHold: z.boolean(),
    status: z.enum([
      "pending",
      "in_progress",
      "completed",
      "short",
      "cancelled",
    ]),
    inventoryTracking: z.boolean().nullable(),
    catalogProductId: z.number().int().positive().nullable(),
    productId: z.number().int().positive().nullable().optional(),
    location: z.string().nullable(),
  })
  .strict();
const lineSchema = wmsPickingProgressLineSchema;
export type WmsPickingProgressLine = z.infer<typeof lineSchema>;

export function pickingReadinessBlockers(
  input: readonly WmsPickingProgressLine[],
): string[] {
  const lines = z.array(lineSchema).parse(input);
  if (new Set(lines.map((line) => line.id)).size !== lines.length)
    throw new Error("Duplicate line in WMS picking progress.");
  const physical = lines.filter(
    (line) =>
      line.requiresShipping && !line.onHold && line.status !== "cancelled",
  );
  const blockers: string[] =
    physical.length === 0 ? ["order has no shippable items"] : [];
  for (const line of physical) {
    if (line.status === "short") {
      blockers.push(`${line.sku} is short-picked`);
      continue;
    }
    if (line.status !== "completed")
      blockers.push(`${line.sku} is ${line.status}`);
    if (line.pickedQuantity !== line.quantity)
      blockers.push(
        `${line.sku} picked ${line.pickedQuantity}/${line.quantity}`,
      );
    if (
      !(line.inventoryTracking === false && line.catalogProductId !== null) &&
      !isUnmappedOrderLine({ ...line, productId: line.productId }) &&
      (!line.location ||
        ["U", "UNASSIGNED"].includes(line.location.trim().toUpperCase()))
    ) {
      blockers.push(`${line.sku} has no pick bin`);
    }
  }
  return blockers;
}

/** Picks never manufacture shipment evidence or undo a terminal shipping/cancel state. */
export function deriveWmsPickingProgress(input: {
  currentStatus: unknown;
  postPickStatus: string;
  lines: readonly WmsPickingProgressLine[];
  additionalBlockers: readonly string[];
}): {
  status: WmsPickingStatus;
  pickedCount: number;
  itemCount: number;
  unitCount: number;
  completeNonShipping: boolean;
} {
  const currentStatus = pickingStatus.parse(input.currentStatus);
  const postPickStatus = pickingStatus.parse(input.postPickStatus);
  if (
    !["ready_to_ship", "picked", "staged", "packing", "packed"].includes(
      postPickStatus,
    )
  ) {
    throw new Error(
      "A picking projection requires an explicit packing or shipping handoff state.",
    );
  }
  const lines = z.array(lineSchema).parse(input.lines);
  if (new Set(lines.map((line) => line.id)).size !== lines.length)
    throw new Error("Duplicate line in WMS picking progress.");
  const additionalBlockers = z
    .array(z.string().min(1))
    .parse(input.additionalBlockers);
  const counts = {
    pickedCount: lines
      .filter((line) => line.requiresShipping)
      .reduce((sum, line) => sum + line.pickedQuantity, 0),
    itemCount: lines.length,
    unitCount: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
  for (const [field, value] of Object.entries(counts))
    quantity.parse(value, { path: [field] });
  if (
    [
      "shipped",
      "partially_shipped",
      "cancelled",
      "completed",
      "on_hold",
      "awaiting_3pl",
    ].includes(currentStatus)
  ) {
    return { ...counts, status: currentStatus, completeNonShipping: false };
  }
  if (lines.length > 0 && lines.every((line) => line.status === "cancelled")) {
    return { ...counts, status: "cancelled", completeNonShipping: false };
  }
  const active = lines.filter(
    (line) =>
      line.requiresShipping && !line.onHold && line.status !== "cancelled",
  );
  const done =
    active.length > 0 &&
    active.every((line) => ["completed", "short"].includes(line.status));
  if (!done)
    return {
      ...counts,
      status:
        currentStatus === "exception"
          ? "exception"
          : currentStatus === "ready" && counts.pickedCount === 0
            ? "ready"
            : "in_progress",
      completeNonShipping: false,
    };
  const blockers = [...pickingReadinessBlockers(lines), ...additionalBlockers];
  if (
    blockers.length === 0 &&
    ["picked", "staged", "packing", "packed"].includes(currentStatus)
  ) {
    return { ...counts, status: currentStatus, completeNonShipping: true };
  }
  return {
    ...counts,
    status: blockers.length > 0 ? "exception" : postPickStatus,
    completeNonShipping: blockers.length === 0,
  };
}
