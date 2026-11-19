import { z } from "zod";
import { boxDimensionMmSchema } from "./dimensions";

export const shippingPackageDimensionsSchema = z.object({
  lengthMm: boxDimensionMmSchema,
  widthMm: boxDimensionMmSchema,
  heightMm: boxDimensionMmSchema,
}).strict();
export type ShippingPackageDimensions = z.infer<typeof shippingPackageDimensionsSchema>;

/** Versioned, normalized evidence inside the immutable shipping observation. */
export const shippingPackageDimensionObservationSchema = z.discriminatedUnion("status", [
  z.object({ version: z.literal(1), status: z.literal("verified"), dimensions: shippingPackageDimensionsSchema }).strict(),
  z.object({ version: z.literal(1), status: z.literal("invalid"), code: z.enum(["SHIPMENT_DIMENSIONS_INVALID", "SHIPMENT_DIMENSIONS_CONFLICT"]) }).strict(),
]);
export type ShippingPackageDimensionObservation = z.infer<typeof shippingPackageDimensionObservationSchema>;

export const shippingPackageDimensionRecordSchema = z.object({
  observation: shippingPackageDimensionObservationSchema,
  observedAt: z.string().datetime(),
  eventHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type StoredShippingPackageDimensions =
  | { status: "verified"; dimensions: ShippingPackageDimensions }
  | { status: "unusable" }
  | { status: "not_recorded" };
