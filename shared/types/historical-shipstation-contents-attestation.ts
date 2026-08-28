import { z } from "zod";

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_PACKAGE_LINES = 500;

const positivePostgresIntegerSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const exactNonblankText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim() === value, "must not contain surrounding whitespace");
function rejectDuplicateWmsShipmentItemIds(
  lines: ReadonlyArray<{ wmsShipmentItemId: number }>,
  context: z.RefinementCtx,
): void {
  const firstIndexById = new Map<number, number>();

  lines.forEach((line, index) => {
    const firstIndex = firstIndexById.get(line.wmsShipmentItemId);
    if (firstIndex !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "wmsShipmentItemId"],
        message: `duplicates the WMS shipment item identity at index ${firstIndex}`,
      });
      return;
    }

    firstIndexById.set(line.wmsShipmentItemId, index);
  });
}


export const HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_API_PATH =
  "/api/shipping/admin/historical-contents-attestations";

export const historicalShipStationContentsLabelIdSchema = z.string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAX, {
    message: "must fit a positive PostgreSQL bigint",
  });

export const historicalShipStationExpectedContentsLineSchema = z.object({
  wmsShipmentItemId: positivePostgresIntegerSchema,
  sku: exactNonblankText(100),
  quantity: positivePostgresIntegerSchema,
}).strict();

export const historicalShipStationExpectedContentsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    source: z.enum(["physical_shipment", "legacy_wms_shipment"]),
    lines: z.array(historicalShipStationExpectedContentsLineSchema)
      .min(1)
      .max(MAX_PACKAGE_LINES)
      .superRefine(rejectDuplicateWmsShipmentItemIds),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "no_linked_package",
      "ambiguous_linked_package",
      "linked_package_contents_unavailable",
    ]),
  }).strict(),
]);

export const historicalShipStationAttestedContentsLineSchema = z.object({
  wmsShipmentItemId: positivePostgresIntegerSchema,
  quantity: positivePostgresIntegerSchema,
}).strict();

export const historicalShipStationContentsAttestationPreviewSchema = z.object({
  shippingProviderLabelId: historicalShipStationContentsLabelIdSchema,
  providerShipmentId: positiveSafeIntegerSchema,
  providerContentsStatus: z.enum([
    "authoritative",
    "omitted",
    "empty",
    "unrecognized",
    "malformed",
    "mixed",
  ]),
  recoveryStatus: z.enum([
    "provider_line_keys_authoritative",
    "exact_unique_wms_match",
  ]),
  previewEvidenceHash: sha256Schema,
  providerEvidenceHash: sha256Schema,
  expectedContents: historicalShipStationExpectedContentsSchema,
  attestedContents: z.array(historicalShipStationAttestedContentsLineSchema)
    .min(1)
    .max(MAX_PACKAGE_LINES)
    .superRefine(rejectDuplicateWmsShipmentItemIds),
}).strict();

export const historicalShipStationContentsAttestationPreviewResponseSchema = z.object({
  preview: historicalShipStationContentsAttestationPreviewSchema,
}).strict();

export const historicalShipStationContentsAttestationRequestSchema = z.object({
  expectedPreviewEvidenceHash: sha256Schema,
  reason: exactNonblankText(500),
}).strict();

export const historicalShipStationContentsAttestationResultSchema = z.object({
  kind: z.enum(["created", "already_persisted"]),
  attestationId: historicalShipStationContentsLabelIdSchema,
  shippingProviderLabelId: historicalShipStationContentsLabelIdSchema,
  previewEvidenceHash: sha256Schema,
  resolvedEventCount: nonnegativeSafeIntegerSchema,
}).strict();

export const historicalShipStationContentsAttestationResponseSchema = z.object({
  attestation: historicalShipStationContentsAttestationResultSchema,
}).strict();

export type HistoricalShipStationContentsAttestationPreview = z.infer<
  typeof historicalShipStationContentsAttestationPreviewSchema
>;

export type HistoricalShipStationContentsAttestationPreviewResponse = z.infer<
  typeof historicalShipStationContentsAttestationPreviewResponseSchema
>;

export type HistoricalShipStationContentsAttestationRequest = z.infer<
  typeof historicalShipStationContentsAttestationRequestSchema
>;

export type HistoricalShipStationContentsAttestationResult = z.infer<
  typeof historicalShipStationContentsAttestationResultSchema
>;

export type HistoricalShipStationContentsAttestationResponse = z.infer<
  typeof historicalShipStationContentsAttestationResponseSchema
>;
