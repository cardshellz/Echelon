import { z } from "zod";
import { shipmentLineEditableSchema, shipmentLinePackingSchema, shipmentLineResourceIdSchema as id, shipmentLineVersionSchema as version } from "./shipment-line-command";
import { shipmentUnitSelectionSchema, shipmentUnitsSchema } from "./shipment-unit-selection";
const addition = z.object({ clientKey: z.string().uuid(), purchaseOrderId: id, purchaseOrderLineId: id,
  quantityPieces: id, unitSelection: shipmentUnitSelectionSchema.optional(), packing: shipmentLinePackingSchema.optional() }).strict();
const shape = { sourceVersion: version, reason: z.string().trim().min(10).max(2000),
  changes: z.array(z.object({ lineId: id, fields: shipmentLineEditableSchema, unitSelection: shipmentUnitSelectionSchema.optional() }).strict()).max(100),
  removals: z.array(id).max(100), additions: z.array(addition).max(100) };
function operations(input: { changes: { lineId: number; fields: object; unitSelection?: unknown }[]; removals: number[]; additions: z.infer<typeof addition>[] }, ctx: z.RefinementCtx) {
  if (!input.changes.length && !input.removals.length && !input.additions.length) ctx.addIssue({ code: "custom", message: "Add, remove or edit a line first." });
  const ids = [...input.changes.map(line => line.lineId), ...input.removals];
  if (new Set(ids).size !== ids.length || new Set(input.additions.map(line => line.clientKey)).size !== input.additions.length
    || new Set(input.additions.map(line => line.purchaseOrderLineId)).size !== input.additions.length) ctx.addIssue({ code: "custom", message: "Each line may appear only once." });
  if (input.changes.some(line => !Object.keys(line.fields).length && line.unitSelection === undefined)) ctx.addIssue({ code: "custom", message: "Enter the fields to change." });
}
export const shipmentEditorRequestSchema = z.object(shape).strict().superRefine(operations);
export const shipmentEditorApprovalSchema = z.object({ ...shape, previewVersion: version, approvalConfirmed: z.literal(true) }).strict().superRefine(operations);
const line = z.object({ key: z.string(), id: id.nullable(), sku: z.string().nullable(), name: z.string(),
  purchaseOrderId: id.nullable(), purchaseOrderLineId: id.nullable(), poNumber: z.string().nullable(),
  fields: shipmentLineEditableSchema, shipmentUnits: shipmentUnitsSchema.optional(), allocatedCostCents: z.number().int().safe(),
  totalWeightKg: z.string().nullable(), totalVolumeCbm: z.string().nullable() }).strict();
export const shipmentEditorContextSchema = z.object({ shipmentId: id, shipmentNumber: z.string(), status: z.string(),
  sourceVersion: version, canApprove: z.boolean(), blockedReason: z.string().nullable(), lines: z.array(line),
  charges: z.array(z.object({ currency: z.string(), cents: z.number().int().safe() }).strict()),
  receipts: z.array(z.object({ id, number: z.string() }).strict()) }).strict();
export const shipmentEditorReviewSchema = z.object({ shipmentId: id, sourceVersion: version, reason: z.string(),
  before: z.array(line), after: z.array(line), charges: shipmentEditorContextSchema.shape.charges,
  costShares: z.array(z.object({ purchaseOrderId: id.nullable(), poNumber: z.string().nullable(), beforeCents: z.number().int().safe(), afterCents: z.number().int().safe() }).strict()),
}).strict();
export const shipmentEditorPreviewSchema = z.object({ previewVersion: version, review: shipmentEditorReviewSchema }).strict();
export const shipmentEditorResultSchema = z.object({ auditId: z.number().int().positive().safe(), actorName: z.string(), approvedAt: z.string().datetime(),
  preview: shipmentEditorPreviewSchema }).strict();
export type ShipmentEditorRequest = z.infer<typeof shipmentEditorRequestSchema>;
export type ShipmentEditorContext = z.infer<typeof shipmentEditorContextSchema>;
export type ShipmentEditorPreview = z.infer<typeof shipmentEditorPreviewSchema>;
export type ShipmentEditorResult = z.infer<typeof shipmentEditorResultSchema>;
