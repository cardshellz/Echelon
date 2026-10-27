import { z } from "zod";
import { shipmentUnitsSchema } from "./shipment-unit-selection";
import { shipmentLineResourceIdSchema, SHIPMENT_LINE_INTEGER_MAX } from "./shipment-line-command";
import { reviewReceivingConfiguration } from "./receiving-configuration";

// A consolidated shipment can contain multiple command-sized imports. Bound
// its complete read snapshot separately from the 500-row command limit.
export const MAX_SHIPMENT_RECEIVING_SETUP_LINES = 10_000;
const id = shipmentLineResourceIdSchema;
const issue = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
export const shipmentReceivingSetupSchema = z.object({
  shipmentId: id,
  ready: z.boolean(),
  issueCount: z.number().int().nonnegative(),
  lines: z.array(z.object({
    lineId: id, purchaseOrderId: id.nullable(), sku: z.string().nullable(), name: z.string(),
    pieces: z.number().int().min(0).max(SHIPMENT_LINE_INTEGER_MAX), units: shipmentUnitsSchema, count: id.nullable(), issue: issue.nullable(),
  }).strict()).max(MAX_SHIPMENT_RECEIVING_SETUP_LINES),
}).strict().superRefine((value, context) => {
  const issues = value.lines.filter(line => line.issue !== null).length;
  if (new Set(value.lines.map(line => line.lineId)).size !== value.lines.length || value.issueCount !== issues
    || value.ready !== (value.lines.length > 0 && issues === 0)) context.addIssue({ code: "custom", message: "Receiving setup is inconsistent." });
  value.lines.forEach((line, index) => {
    const review = reviewReceivingConfiguration({ pieces: line.pieces, variantId: line.units.selectedVariantId,
      recordedUnits: line.units.unitsPerVariantSnapshot, activeVariants: line.units.variants });
    if (line.issue === null ? line.units.issue !== null || !review.ready || line.count !== review.count : line.count !== null) {
      context.addIssue({ code: "custom", path: ["lines", index], message: "The reported receiving count does not match its configuration." });
    }
  });
});
export type ShipmentReceivingSetup = z.infer<typeof shipmentReceivingSetupSchema>;
