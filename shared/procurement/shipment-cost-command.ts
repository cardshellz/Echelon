import { z } from "zod";

// Tax uses the existing charge/allocation owner with an explicit saved rule.
export const SHIPMENT_COST_TYPES = [
  "freight", "dimensions_adjustment", "duty", "tax", "insurance", "brokerage",
  "platform_fee", "port_handling", "drayage", "warehousing", "inspection", "other",
] as const;

export const SHIPMENT_COST_ALLOCATION_METHODS = [
  "by_volume", "by_weight", "by_chargeable_weight", "by_value", "by_line_count",
] as const;

// Existing AP shipment projections accept signed seller credits. Validation must
// preserve them; whether a cost can be allocated belongs to the costing owner.
const cents = z.number().int().safe().nullable();
const POSTGRES_INTEGER_MAX = 2_147_483_647;
export const shipmentCostResourceIdSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const evidenceDate = z.union([
  z.string().date(),
  z.string().datetime({ offset: true }),
]);

const editableShape = {
  costType: z.enum(SHIPMENT_COST_TYPES),
  taxTypeId: shipmentCostResourceIdSchema.nullable(),
  description: z.string().nullable(),
  estimatedCents: cents,
  actualCents: cents,
  // C1 follows the existing USD accounting boundary; no FX calculation occurs here.
  currency: z.literal("USD"),
  exchangeRate: z.literal("1"),
  allocationMethod: z.enum(SHIPMENT_COST_ALLOCATION_METHODS).nullable(),
  vendorId: shipmentCostResourceIdSchema.nullable(),
  performedByVendorId: shipmentCostResourceIdSchema.nullable(),
  performedByName: z.string().nullable(),
  invoiceDate: evidenceDate.nullable(),
  notes: z.string().nullable(),
};

export const SHIPMENT_COST_EDITABLE_FIELDS = Object.freeze(Object.keys(editableShape)) as readonly (keyof typeof editableShape)[];
export const shipmentCostVersionSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected version must be a lowercase SHA-256 token");
const reason = z.string().trim().min(1, "Reason cannot be blank").optional();
const editableSchema = z.object(editableShape).partial();

export const shipmentCostCreateSchema = editableSchema.extend({
  costType: editableShape.costType,
  reason,
}).strict().superRefine((value, context) => {
  if (["tax", "duty"].includes(value.costType) && value.taxTypeId == null) context.addIssue({ code: "custom", path: ["taxTypeId"], message: "Choose a configured tax type." });
  if (value.taxTypeId != null && !["duty", "tax"].includes(value.costType)) context.addIssue({ code: "custom", path: ["taxTypeId"], message: "Only tax and duty charges use a tax type." });
  if (value.taxTypeId != null && [value.actualCents, value.estimatedCents].some(amount => amount != null && amount < 0))
    context.addIssue({ code: "custom", message: "Record a supplier tax credit against its original charge; a tax charge cannot assume a refund allocation." });
});

export const shipmentCostPatchSchema = editableSchema.extend({
  expectedVersion: shipmentCostVersionSchema,
  reason,
}).strict().refine(
  (command) => SHIPMENT_COST_EDITABLE_FIELDS.some((field) => command[field] !== undefined),
  { message: "At least one editable cost field is required" },
);

export const shipmentCostDeleteSchema = z.object({
  expectedVersion: shipmentCostVersionSchema,
  reason,
}).strict();

export type ShipmentCostCreateCommand = z.infer<typeof shipmentCostCreateSchema>;
export type ShipmentCostPatchCommand = z.infer<typeof shipmentCostPatchSchema>;
export type ShipmentCostDeleteCommand = z.infer<typeof shipmentCostDeleteSchema>;
