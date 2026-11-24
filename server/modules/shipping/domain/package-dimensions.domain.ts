import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { shippingPackageDimensionObservationSchema, shippingPackageDimensionRecordSchema, type StoredShippingPackageDimensions } from "@shared/shipping/package-dimensions";

export interface ShippingPackageDimensionFacts {
  labelStatus: string;
  labelDirection: string;
  trackingNumber: string;
  recorded: boolean;
  measurement: unknown;
  evidence: unknown;
}

/** A saved size is usable only for the same active outbound package and an
 * intact immutable evidence link. This establishes facts, not return eligibility. */
export function resolveShippingPackageDimensions(facts: ShippingPackageDimensionFacts | null, trackingNumber: string): StoredShippingPackageDimensions {
  if (facts === null) return { status: "not_recorded" };
  if (facts.labelStatus !== "active" || facts.labelDirection !== "outbound" || facts.trackingNumber !== trackingNumber)
    return { status: "unusable" };
  if (!facts.recorded) return { status: "not_recorded" };
  const parsed = shippingPackageDimensionRecordSchema.safeParse(facts.measurement);
  if (!parsed.success || parsed.data.observation.status !== "verified"
    || canonicalJson(parsed.data.observation) !== canonicalJson(facts.evidence)) return { status: "unusable" };
  return { status: "verified", dimensions: parsed.data.observation.dimensions };
}

/** Materialize the latest observed measurement beside its immutable event hash.
 * The label owner calls this while holding its existing transaction lock. A
 * replay may refresh the observation time without rewriting an immutable event.
 * Equal-time contradictory evidence is ambiguous, never last-writer-wins. */
export function retainShippingPackageDimensionsMetadata(rawMetadata: unknown, rawObservation: unknown, observedAt: Date, eventHash: string): Record<string, unknown> {
  const metadata = z.record(z.unknown()).parse(rawMetadata ?? {});
  if (rawObservation === undefined) return { ...metadata };
  const observation = shippingPackageDimensionObservationSchema.parse(rawObservation);
  const incoming = shippingPackageDimensionRecordSchema.parse({ observation,
    observedAt: z.date().parse(observedAt).toISOString(), eventHash });
  const previous = shippingPackageDimensionRecordSchema.safeParse(metadata.packageDimensions);
  if (previous.success) {
    const comparison = Date.parse(previous.data.observedAt) - observedAt.getTime();
    if (comparison > 0) return { ...metadata };
    if (comparison === 0 && canonicalJson(previous.data.observation) !== canonicalJson(observation)) {
      return { ...metadata, packageDimensions: { ...incoming,
        observation: { version: 1, status: "invalid", code: "SHIPMENT_DIMENSIONS_CONFLICT" } } };
    }
  }
  return { ...metadata, packageDimensions: incoming };
}
