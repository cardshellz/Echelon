import { z } from "zod";

export const SHIPMENT_LINE_INTEGER_MAX = 2_147_483_647;
export const SHIPMENT_LINE_IMPORT_LIMIT = 500;
export const shipmentLineResourceIdSchema = z.number().int().positive().max(SHIPMENT_LINE_INTEGER_MAX);
export const shipmentLineVersionSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected version must be a lowercase SHA-256 token");

// Decimal strings retain the entered precision. Match the actual PostgreSQL
// numeric columns rather than allowing rounding or overflow at persistence.
function dimension(integerDigits: number, scale: number) {
  return z.string().regex(new RegExp(`^(?:0|[1-9]\\d{0,${integerDigits - 1}})(?:\\.\\d{1,${scale}})?$`),
    `Expected a non-negative decimal with at most ${integerDigits} integer and ${scale} fractional digits`).nullable();
}

export const shipmentLineEditableShape = {
  qtyShipped: shipmentLineResourceIdSchema,
  cartonCount: shipmentLineResourceIdSchema.nullable(),
  weightKg: dimension(7, 3),
  lengthCm: dimension(6, 2),
  widthCm: dimension(6, 2),
  heightCm: dimension(6, 2),
  notes: z.string().max(10_000).nullable(),
};
export const SHIPMENT_LINE_EDITABLE_FIELDS = Object.freeze(Object.keys(shipmentLineEditableShape)) as readonly (keyof typeof shipmentLineEditableShape)[];

export const shipmentLineEditableSchema = z.object(shipmentLineEditableShape).partial().strict();
export const shipmentLinePatchSchema = shipmentLineEditableSchema.extend({
  expectedVersion: shipmentLineVersionSchema,
}).strict().refine((body) => SHIPMENT_LINE_EDITABLE_FIELDS.some((field) => body[field] !== undefined), {
  message: "At least one editable shipment line field is required",
});
export const shipmentLineDeleteSchema = z.object({ expectedVersion: shipmentLineVersionSchema }).strict();
export const shipmentLineFromPoSchema = z.object({
  purchaseOrderId: shipmentLineResourceIdSchema,
  lineIds: z.array(shipmentLineResourceIdSchema).min(1).max(SHIPMENT_LINE_IMPORT_LIMIT).optional(),
  lineSelections: z.array(z.object({ poLineId: shipmentLineResourceIdSchema, qty: shipmentLineResourceIdSchema }).strict()).min(1).max(SHIPMENT_LINE_IMPORT_LIMIT).optional(),
}).strict().superRefine((body, context) => {
  if (body.lineIds && body.lineSelections) context.addIssue({ code: "custom", message: "Use either lineIds or lineSelections" });
  const ids = body.lineSelections?.map((line) => line.poLineId) ?? body.lineIds ?? [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate purchase order line selections are not allowed" });
});
export const shipmentPackingListRowSchema = z.object({
  ...shipmentLineEditableShape,
  sku: z.string().trim().min(1).max(100),
  purchaseOrderLineId: shipmentLineResourceIdSchema,
  productVariantId: shipmentLineResourceIdSchema,
}).partial().extend({ qtyShipped: shipmentLineResourceIdSchema }).strict().refine(
  (row) => row.sku !== undefined || row.purchaseOrderLineId !== undefined || row.productVariantId !== undefined,
  { message: "A SKU, product variant, or purchase order line is required" },
);
// Row validation is deliberately separate: valid rows in an import retain the
// existing partial-acceptance contract, with one explicit error per rejected row.
export const shipmentPackingListImportSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(SHIPMENT_LINE_IMPORT_LIMIT),
}).strict();
export const shipmentLineResolveSchema = z.object({}).strict();

export type ShipmentLinePatchCommand = z.infer<typeof shipmentLinePatchSchema>;
export type ShipmentLineFromPoCommand = z.infer<typeof shipmentLineFromPoSchema>;
export type ShipmentPackingListRow = z.infer<typeof shipmentPackingListRowSchema>;
