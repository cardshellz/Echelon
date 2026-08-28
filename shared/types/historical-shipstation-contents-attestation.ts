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

function rejectDuplicateWmsOrderIds(
  orders: ReadonlyArray<{ wmsOrderId: number }>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<number>();
  orders.forEach((order, index) => {
    if (seen.has(order.wmsOrderId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "wmsOrderId"],
        message: "duplicates a WMS order identity",
      });
    }
    seen.add(order.wmsOrderId);
  });
}

function rejectDuplicateShipmentReferences(
  shipments: ReadonlyArray<{ source: string; shipmentId: string }>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  shipments.forEach((shipment, index) => {
    const key = `${shipment.source}:${shipment.shipmentId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "duplicates a linked shipment identity",
      });
    }
    seen.add(key);
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

export const historicalShipStationContentsReviewContextSchema = z.object({
  trackingNumber: exactNonblankText(200),
  shipStationOrderId: exactNonblankText(200).nullable(),
  wmsOrders: z.array(z.object({
    wmsOrderId: positivePostgresIntegerSchema,
    orderNumber: exactNonblankText(50),
  }).strict()).max(100).superRefine(rejectDuplicateWmsOrderIds),
  linkedShipments: z.array(z.object({
    source: z.enum(["physical_shipment", "legacy_wms_shipment"]),
    shipmentId: historicalShipStationContentsLabelIdSchema,
  }).strict()).max(100).superRefine(rejectDuplicateShipmentReferences),
  linePresentations: z.array(z.object({
    wmsShipmentItemId: positivePostgresIntegerSchema,
    itemName: exactNonblankText(500).nullable(),
  }).strict()).max(MAX_PACKAGE_LINES).superRefine(rejectDuplicateWmsShipmentItemIds),
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
  reviewContext: historicalShipStationContentsReviewContextSchema,
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

export type HistoricalShipStationContentsReviewContext = z.infer<
  typeof historicalShipStationContentsReviewContextSchema
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
