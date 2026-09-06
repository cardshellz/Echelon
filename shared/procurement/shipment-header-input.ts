import { z } from "zod";

// List/PO creation and detail editing currently expose different vocabularies.
// Preserve both; this input boundary does not translate transport modes.
export const SHIPMENT_HEADER_MODES = [
  "sea_fcl", "sea_lcl", "air", "ground", "ltl", "ftl", "parcel", "courier",
  "ocean", "truck", "rail",
] as const;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const text = (length: number) => z.string().max(length).nullable().optional();
const date = z.union([
  z.string().date(),
  z.string().datetime({ offset: true }),
]).nullable().optional();

// Match the existing NUMERIC columns without parsing through floating point.
function nonnegativeDecimal(precision: number, scale: number) {
  const integerDigits = precision - scale;
  const pattern = new RegExp(`^(?:0|[1-9][0-9]{0,${integerDigits - 1}})(?:\\.[0-9]{1,${scale}})?$`);
  return z.string().regex(pattern, `Expected a nonnegative decimal with at most ${integerDigits} integer and ${scale} fractional digits`).nullable().optional();
}

// Deliberately separate from InsertInboundShipment: status, actors, allocation
// defaults, lifecycle timestamps and recomputed totals are service-owned fields.
const editableShape = {
  mode: z.enum(SHIPMENT_HEADER_MODES).or(z.literal("")).nullable().optional(),
  carrierName: text(100),
  forwarderName: text(100),
  shipperName: text(200),
  bookingReference: text(100),
  originPort: text(100),
  destinationPort: text(100),
  originCountry: text(50),
  destinationCountry: text(50),
  containerNumber: text(30),
  sealNumber: text(30),
  containerSize: text(10),
  containerCapacityCbm: nonnegativeDecimal(8, 2),
  bolNumber: text(100),
  houseBol: text(100),
  trackingNumber: text(200),
  etd: date,
  eta: date,
  warehouseId: z.number().int().positive().max(POSTGRES_INTEGER_MAX).nullable().optional(),
  grossWeightKg: nonnegativeDecimal(12, 3),
  totalGrossVolumeCbm: nonnegativeDecimal(12, 6),
  palletCount: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX).nullable().optional(),
  notes: z.string().nullable().optional(),
  internalNotes: z.string().nullable().optional(),
};

export const SHIPMENT_HEADER_EDITABLE_FIELDS = Object.freeze(Object.keys(editableShape)) as readonly (keyof typeof editableShape)[];

export const shipmentHeaderCreateSchema = z.object({
  ...editableShape,
  shipmentNumber: z.string().trim().min(1).max(30).optional(),
}).strict();

export const shipmentHeaderPatchSchema = z.object(editableShape).strict().refine(
  (input) => SHIPMENT_HEADER_EDITABLE_FIELDS.some((field) => input[field] !== undefined),
  { message: "At least one editable shipment field is required" },
);

export type ShipmentHeaderCreateInput = z.infer<typeof shipmentHeaderCreateSchema>;
export type ShipmentHeaderPatchInput = z.infer<typeof shipmentHeaderPatchSchema>;
