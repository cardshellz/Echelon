import { z } from "zod";

export const SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS = 1024;
export const SHIPMENT_ALLOCATION_MAX_SOURCE_QUANTITY = 2_147_483_647;
// Sum denominators can grow when many partial PO quantities are coprime.
// Bound exact evidence and BigInt work instead of silently approximating it.
const unsignedInteger = z.string().max(SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS).regex(/^(0|[1-9][0-9]*)$/);
const positiveInteger = z.string().max(SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS).regex(/^[1-9][0-9]*$/);
const productTotal = z.string().max(String(Number.MAX_SAFE_INTEGER).length).regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)), "Product total exceeds the supported exact range");
const resourceId = z.number().int().positive().max(SHIPMENT_ALLOCATION_MAX_SOURCE_QUANTITY);

/** Ratios are serialized as integers; a repeating decimal is never authority. */
export const shipmentAllocationRatioSchema = z.object({
  numerator: unsignedInteger,
  denominator: positiveInteger,
}).strict();
export type ShipmentAllocationRatio = z.infer<typeof shipmentAllocationRatioSchema>;

export const shipmentAllocationSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("po_product_total"),
    poLineId: resourceId,
    orderQty: resourceId,
    qtyShipped: resourceId,
    totalProductCostCents: productTotal,
    currency: z.literal("USD"),
  }).strict(),
  z.object({
    kind: z.literal("dimension"),
    field: z.enum(["totalVolumeCbm", "totalWeightKg", "chargeableWeightKg"]),
    value: z.string().max(64).nullable(),
  }).strict(),
  z.object({ kind: z.literal("line_count") }).strict(),
]);
export type ShipmentAllocationSource = z.infer<typeof shipmentAllocationSourceSchema>;

export const shipmentAllocationEvidenceSchema = z.object({
  version: z.literal(2),
  lineId: resourceId,
  method: z.enum(["by_volume", "by_weight", "by_chargeable_weight", "by_value", "by_line_count"]),
  source: shipmentAllocationSourceSchema,
  rawRatio: shipmentAllocationRatioSchema,
  ratio: shipmentAllocationRatioSchema,
  totalRatio: shipmentAllocationRatioSchema,
  usedFallback: z.boolean(),
}).strict();
export type ShipmentAllocationEvidence = z.infer<typeof shipmentAllocationEvidenceSchema>;

/** Old provisional equal-split rows are retained as history, never current
 * evidence that weight/volume allocation has been completed. */
export function isUnresolvedPhysicalAllocation(evidence: unknown): boolean {
  if (evidence == null) return false; // Pre-evidence rows require their existing source checks.
  const parsed = shipmentAllocationEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return true;
  return ["by_volume", "by_weight", "by_chargeable_weight"].includes(parsed.data.method)
    && (parsed.data.usedFallback || parsed.data.rawRatio.numerator === "0");
}
