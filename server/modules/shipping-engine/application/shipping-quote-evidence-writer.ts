import { z } from "zod";

const shippingQuoteEvidenceInputSchema = z.object({
  source: z.literal("shadow"),
  evidenceKind: z.string().trim().min(1).max(100),
  evidenceKey: z.string().trim().min(1).max(255),
  destinationCountry: z.string().trim().regex(/^[A-Za-z]{2}$/),
  destinationPostalCode: z.string().trim().min(1).max(20).nullable(),
  resolvedZone: z.string().trim().min(1).max(40).nullable(),
  requestHash: z.string().trim().min(1).max(128).nullable(),
  requestPayload: z.record(z.string(), z.unknown()),
  packing: z.record(z.string(), z.unknown()).nullable(),
  rates: z.record(z.string(), z.unknown()).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.date(),
}).strict();

export type ShippingQuoteEvidenceInput = z.infer<
  typeof shippingQuoteEvidenceInputSchema
>;

export interface ShippingQuoteEvidenceWriteResult {
  snapshotId: number;
  created: boolean;
}

export interface ShippingQuoteEvidenceWriter {
  persistOnce(
    input: ShippingQuoteEvidenceInput,
  ): Promise<ShippingQuoteEvidenceWriteResult>;
}

export function normalizeShippingQuoteEvidenceInput(
  input: ShippingQuoteEvidenceInput,
): ShippingQuoteEvidenceInput {
  const parsed = shippingQuoteEvidenceInputSchema.parse(input);
  return {
    ...parsed,
    destinationCountry: parsed.destinationCountry.toUpperCase(),
    destinationPostalCode:
      parsed.destinationPostalCode?.toUpperCase() ?? null,
  };
}
