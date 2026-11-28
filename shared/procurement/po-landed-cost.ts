import { z } from "zod";

export const PO_LANDED_COST_TYPES = [
  "freight",
  "duty",
  "tariff",
  "tax",
  "insurance",
  "brokerage",
  "platform_fee",
  "port_handling",
  "drayage",
  "warehousing",
  "inspection",
  "other",
] as const;

export const PO_LANDED_COST_ALLOCATION_METHODS = [
  "by_value",
  "by_quantity",
  "by_line_count",
] as const;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const resourceIdSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativeCentsSchema = z.number().int().nonnegative().safe();
const isoDateOrDatetimeSchema = z.union([
  z.string().date(),
  z.string().datetime({ offset: true }),
]);

export const poLandedCostCreateSchema = z.object({
  costType: z.enum(PO_LANDED_COST_TYPES),
  description: z.string().trim().max(500).nullable().optional(),
  amountCents: nonnegativeCentsSchema,
  currency: z.literal("USD").default("USD"),
  allocationMethod: z.enum(PO_LANDED_COST_ALLOCATION_METHODS).default("by_value"),
  vendorId: resourceIdSchema.nullable().optional(),
  invoiceNumber: z.string().trim().max(100).nullable().optional(),
  costDate: isoDateOrDatetimeSchema.nullable().optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export const poLandedCostPatchSchema = poLandedCostCreateSchema.partial().strict().refine(
  (payload) => Object.values(payload).some((val) => val !== undefined),
  { message: "At least one editable landed cost field is required." },
);

export const poLandedCostRecordSchema = z.object({
  id: resourceIdSchema,
  purchaseOrderId: resourceIdSchema,
  costType: z.enum(PO_LANDED_COST_TYPES),
  description: z.string().nullable(),
  amountCents: nonnegativeCentsSchema,
  currency: z.literal("USD"),
  allocationMethod: z.enum(PO_LANDED_COST_ALLOCATION_METHODS),
  vendorId: resourceIdSchema.nullable(),
  vendorName: z.string().nullable(),
  vendorInvoiceId: resourceIdSchema.nullable(),
  invoiceNumber: z.string().nullable(),
  costDate: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const poLandedCostLineAllocationSchema = z.object({
  purchaseOrderLineId: resourceIdSchema,
  sku: z.string().nullable(),
  productName: z.string().nullable(),
  basePieces: resourceIdSchema,
  freightCents: nonnegativeCentsSchema,
  dutyCents: nonnegativeCentsSchema,
  otherCents: nonnegativeCentsSchema,
  totalAllocatedCents: nonnegativeCentsSchema,
  allocatedUnitMills: nonnegativeCentsSchema,
}).strict();

export const poLandedCostsResponseSchema = z.object({
  purchaseOrderId: resourceIdSchema,
  currency: z.literal("USD"),
  hasActiveInboundShipment: z.boolean(),
  totalCents: nonnegativeCentsSchema,
  freightCents: nonnegativeCentsSchema,
  dutyCents: nonnegativeCentsSchema,
  otherCents: nonnegativeCentsSchema,
  charges: z.array(poLandedCostRecordSchema),
  lineAllocations: z.array(poLandedCostLineAllocationSchema),
}).strict();

export type PoLandedCostType = (typeof PO_LANDED_COST_TYPES)[number];
export type PoLandedCostAllocationMethod = (typeof PO_LANDED_COST_ALLOCATION_METHODS)[number];
export type PoLandedCostCreateInput = z.infer<typeof poLandedCostCreateSchema>;
export type PoLandedCostPatchInput = z.infer<typeof poLandedCostPatchSchema>;
export type PoLandedCostRecord = z.infer<typeof poLandedCostRecordSchema>;
export type PoLandedCostLineAllocation = z.infer<typeof poLandedCostLineAllocationSchema>;
export type PoLandedCostsResponse = z.infer<typeof poLandedCostsResponseSchema>;
