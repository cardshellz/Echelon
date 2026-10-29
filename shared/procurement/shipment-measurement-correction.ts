import { z } from "zod";
import { shipmentLineEditableSchema, shipmentLineResourceIdSchema, shipmentLineVersionSchema } from "./shipment-line-command";
import { poAmendmentImpactSchema } from "./po-amendment-impact";

/** Measurements describe physical shipping cartons or individual pieces. They
 * never change the receiving configuration or any commercial/stock quantity. */
export const shipmentMeasurementsSchema = shipmentLineEditableSchema.pick({
  cartonCount: true, dimensionBasis: true, weightKg: true, lengthCm: true, widthCm: true, heightCm: true,
}).required();
const correctedMeasurements = shipmentMeasurementsSchema.extend({ dimensionBasis: z.enum(["carton", "piece"]) }).superRefine((value, ctx) => {
  if (value.dimensionBasis === "carton" && value.cartonCount === null)
    ctx.addIssue({ code: "custom", path: ["cartonCount"], message: "Enter the number of physical shipping cartons." });
});
export const shipmentMeasurementReviewRequestSchema = z.object({
  sourceVersion: shipmentLineVersionSchema,
  reason: z.string().trim().min(10).max(2000),
  lines: z.array(z.object({ lineId: shipmentLineResourceIdSchema, measurements: correctedMeasurements }).strict()).min(1).max(500),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.lines.map(line => line.lineId)).size !== request.lines.length)
    ctx.addIssue({ code: "custom", path: ["lines"], message: "Each shipment line may be corrected only once." });
});
export const shipmentMeasurementApprovalSchema = shipmentMeasurementReviewRequestSchema.innerType().extend({
  previewVersion: shipmentLineVersionSchema, evidenceConfirmed: z.literal(true),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.lines.map(line => line.lineId)).size !== request.lines.length)
    ctx.addIssue({ code: "custom", path: ["lines"], message: "Each shipment line may be corrected only once." });
});
const totals = z.object({ totalWeightKg: z.string(), totalVolumeCbm: z.string(), chargeableWeightKg: z.string() }).strict();
const nullableMoneyPair = z.object({ before: z.number().int().safe().nullable(), after: z.number().int().safe().nullable() }).strict();
const line = z.object({
  lineId: shipmentLineResourceIdSchema, sku: z.string().nullable(), purchaseOrderId: shipmentLineResourceIdSchema.nullable(),
  shippedPieces: z.number().int().positive().safe(), measurements: shipmentMeasurementsSchema,
}).strict();
export const shipmentMeasurementImpactSchema = poAmendmentImpactSchema.pick({ lots: true, orderCosts: true, historicalCosts: true, applications: true });
export const shipmentMeasurementPreviewSchema = z.object({
  shipmentId: shipmentLineResourceIdSchema, shipmentNumber: z.string(), status: z.string(),
  sourceVersion: shipmentLineVersionSchema, previewVersion: shipmentLineVersionSchema, reason: z.string(),
  chargeCents: z.number().int().safe(),
  lines: z.array(line.omit({ measurements: true }).extend({
    before: shipmentMeasurementsSchema, after: shipmentMeasurementsSchema,
    physicalTotals: z.object({ before: totals, after: totals }).strict(),
    allocatedCents: nullableMoneyPair, landedTotalCents: nullableMoneyPair,
  }).strict()),
  impact: shipmentMeasurementImpactSchema,
}).strict();
export const shipmentMeasurementContextSchema = z.object({
  shipmentId: shipmentLineResourceIdSchema, shipmentNumber: z.string(), status: z.string(),
  sourceVersion: shipmentLineVersionSchema, canApprove: z.boolean(), blockedReason: z.string().nullable(), lines: z.array(line),
  approvals: z.array(z.object({ id: z.number().int().positive().safe(), actorId: z.string(), actorName: z.string(),
    approvedAt: z.string().datetime({ offset: true }), preview: shipmentMeasurementPreviewSchema }).strict()),
}).strict();
export type ShipmentMeasurements = z.infer<typeof shipmentMeasurementsSchema>;
export type ShipmentMeasurementReviewRequest = z.infer<typeof shipmentMeasurementReviewRequestSchema>;
export type ShipmentMeasurementApproval = z.infer<typeof shipmentMeasurementApprovalSchema>;
export type ShipmentMeasurementPreview = z.infer<typeof shipmentMeasurementPreviewSchema>;
export type ShipmentMeasurementContext = z.infer<typeof shipmentMeasurementContextSchema>;
