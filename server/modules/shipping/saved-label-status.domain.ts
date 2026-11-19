import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { normalizeShipStationV1Date } from "@shared/utils/shipstation-date";
import {
  normalizeShipStationShipmentContentsEvidence,
  normalizeTrackingNumber,
  type NormalizedShippingProviderLabelObservation,
} from "./carrier-tracking.domain";

export const savedLabelStatusSourceSchema = z
  .object({
    kind: z.enum(["return", "history"]),
    sourceId: z.number().int().positive().safe(),
    providerReference: z.string().min(1).max(200),
    trackingNumber: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((source, context) => {
    const valid =
      source.kind === "return"
        ? /^se(?:-[a-z0-9]+)+$/.test(source.providerReference)
        : /^[1-9][0-9]*$/.test(source.providerReference);
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["providerReference"],
        message: "Incorrect provider identity namespace",
      });
  });
export type SavedLabelStatusSource = z.infer<
  typeof savedLabelStatusSourceSchema
>;

export const savedLabelStatusFactsSchema = z
  .object({
    providerReference: z.string().min(1).max(200),
    trackingNumber: z.string().trim().min(1).max(200),
    carrierCode: z
      .string()
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
      .max(100),
    serviceCode: z.string().min(1).max(200).nullable(),
    direction: z.enum(["outbound", "return"]),
    voided: z.boolean(),
    voidedAt: z.string().datetime({offset:true}).nullable().default(null),
    verifiedAlias: z
      .object({
        providerApiLabelId: z
          .string()
          .regex(/^se(?:-[a-z0-9]+)+$/)
          .max(200),
        createdAt: z.string().datetime({ offset: true }),
        proofHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SavedLabelStatusFacts = z.infer<typeof savedLabelStatusFactsSchema>;

/** No order, item, address, money or dispatch identity is inferred by status
 * capture. Exact provider reference and tracking must agree with its owner. */
export function normalizeSavedLabelStatusObservation(
  rawSource: SavedLabelStatusSource,
  rawFacts: SavedLabelStatusFacts,
  instant: Date,
): NormalizedShippingProviderLabelObservation {
  const source = savedLabelStatusSourceSchema.parse(rawSource);
  const facts = savedLabelStatusFactsSchema.parse(rawFacts);
  const now = z.date().parse(instant);
  if(facts.voided && facts.voidedAt === null)throw new Error("SAVED_LABEL_STATUS_VOID_TIME_UNAVAILABLE");
  if (
    source.providerReference !== facts.providerReference ||
    normalizeTrackingNumber(source.trackingNumber) !==
      normalizeTrackingNumber(facts.trackingNumber) ||
    facts.direction !== (source.kind === "return" ? "return" : "outbound")
  )
    throw new Error("SAVED_LABEL_STATUS_IDENTITY_MISMATCH");
  const sanitizedPayload = {
    observationSource: "shipstation_status_observation",
    sourceKind: source.kind,
    providerLabelId: facts.providerReference,
    trackingNumber: facts.trackingNumber,
    carrierCode: facts.carrierCode,
    serviceCode: facts.serviceCode,
    direction: facts.direction,
    voided: facts.voided,
    voidedAt: facts.voidedAt,
    ...(facts.verifiedAlias ? { verifiedAlias: facts.verifiedAlias } : {}),
  };
  const hash = createHash("sha256")
    .update(canonicalJson(sanitizedPayload))
    .digest("hex");
  return {
    provider: "shipstation",
    providerLabelId: facts.providerReference,
    providerOrderId: null,
    providerOrderKey: null,
    trackingNumber: facts.trackingNumber,
    normalizedTrackingNumber: normalizeTrackingNumber(facts.trackingNumber),
    labelStatus: facts.voided ? "voided" : "active",
    labelDirection: facts.direction,
    eventType: facts.voided ? "label_voided" : "label_observed",
    carrier: facts.carrierCode,
    serviceCode: facts.serviceCode,
    labelCreatedAt: null,
    voidedAt: facts.voidedAt ? new Date(facts.voidedAt) : null,
    providerOccurredAt: facts.voidedAt ? new Date(facts.voidedAt) : null,
    shipmentContentsEvidence:
      normalizeShipStationShipmentContentsEvidence(undefined),
    observationSource: "shipstation_status_observation",
    sourceObservationHash: hash,
    eventHash: hash,
    sanitizedPayload,
    observedAt: new Date(now),
  };
}

/** A V1 shipment number is not itself a V2 label grant. Verify the proposed
 * alias against provider label details, exact tracking, outbound direction and
 * the same creation instant before using its label-specific tracking endpoint. */
export function verifyHistoricalStatusLabelAlias(
  rawV1: unknown,
  rawV2: unknown,
) {
  const v1 = z
    .object({
      shipmentId: z.number().int().positive().safe(),
      trackingNumber: z.string(),
      isReturnLabel: z.literal(false),
      createDate: z.string(),
    })
    .parse(rawV1);
  const v2 = z
    .object({
      label_id: z.string(),
      tracking_number: z.string(),
      is_return_label: z.literal(false),
      created_at: z.string().datetime({ offset: true }),
    })
    .parse(rawV2);
  const created = normalizeShipStationV1Date(v1.createDate, "createDate");
  if (
    v2.label_id !== `se-${v1.shipmentId}` ||
    normalizeTrackingNumber(v1.trackingNumber) !==
      normalizeTrackingNumber(v2.tracking_number) ||
    created.kind !== "timestamp" ||
    Date.parse(created.iso) !== Date.parse(v2.created_at)
  ) {
    throw new Error("SAVED_LABEL_STATUS_ALIAS_UNVERIFIED");
  }
  return {
    providerApiLabelId: v2.label_id,
    createdAt: v2.created_at,
    proofHash: createHash("sha256")
      .update(
        canonicalJson({
          shipmentId: v1.shipmentId,
          labelId: v2.label_id,
          tracking: normalizeTrackingNumber(v1.trackingNumber),
          createdAt: created.iso,
          direction: "outbound",
        }),
      )
      .digest("hex"),
  };
}
