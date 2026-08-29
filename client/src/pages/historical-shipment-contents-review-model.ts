import {
  historicalShipStationContentsAttestationRequestSchema,
  historicalShipStationContentsLabelIdSchema,
  type HistoricalShipStationContentsAttestationPreview,
  type HistoricalShipStationContentsAttestationRequest,
} from "@shared/types/historical-shipstation-contents-attestation";

export type HistoricalContentsComparisonStatus =
  | "match"
  | "quantity_mismatch"
  | "missing_from_shipstation"
  | "missing_from_wms";

export interface HistoricalContentsComparisonRow {
  readonly wmsShipmentItemId: number;
  readonly itemName: string | null;
  readonly sku: string | null;
  readonly expectedQuantity: number | null;
  readonly attestedQuantity: number | null;
  readonly status: HistoricalContentsComparisonStatus;
}

export interface HistoricalContentsAttestationReadiness {
  readonly ready: boolean;
  readonly issues: readonly string[];
  readonly request: HistoricalShipStationContentsAttestationRequest | null;
}

export type ParsedHistoricalContentsLabelId =
  | Readonly<{ valid: true; value: string }>
  | Readonly<{ valid: false; message: string }>;

export function parseHistoricalContentsLabelId(input: string): ParsedHistoricalContentsLabelId {
  const normalized = input.trim();
  const parsed = historicalShipStationContentsLabelIdSchema.safeParse(normalized);
  return parsed.success
    ? Object.freeze({ valid: true as const, value: parsed.data })
    : Object.freeze({
        valid: false as const,
        message: "Enter a positive shipping provider label ID.",
      });
}

export function historicalContentsComparisonRows(
  preview: HistoricalShipStationContentsAttestationPreview,
): readonly HistoricalContentsComparisonRow[] {
  const expectedById = new Map(
    preview.expectedContents.kind === "available"
      ? preview.expectedContents.lines.map((line) => [line.wmsShipmentItemId, line] as const)
      : [],
  );
  const attestedById = new Map(
    preview.attestedContents.map((line) => [line.wmsShipmentItemId, line] as const),
  );
  const presentationById = new Map(
    preview.reviewContext.linePresentations.map((line) => [line.wmsShipmentItemId, line] as const),
  );
  const identities = new Set([...expectedById.keys(), ...attestedById.keys()]);
  return Object.freeze([...identities]
    .sort((left, right) => left - right)
    .map((wmsShipmentItemId) => {
      const expected = expectedById.get(wmsShipmentItemId) ?? null;
      const attested = attestedById.get(wmsShipmentItemId) ?? null;
      const status: HistoricalContentsComparisonStatus = expected === null
        ? "missing_from_wms"
        : attested === null
          ? "missing_from_shipstation"
          : expected.quantity === attested.quantity
            ? "match"
            : "quantity_mismatch";
      return Object.freeze({
        wmsShipmentItemId,
        itemName: presentationById.get(wmsShipmentItemId)?.itemName ?? null,
        sku: expected?.sku ?? null,
        expectedQuantity: expected?.quantity ?? null,
        attestedQuantity: attested?.quantity ?? null,
        status,
      });
    }));
}

export function historicalContentsAttestationReadiness(input: Readonly<{
  readonly canAttest: boolean;
  readonly preview: HistoricalShipStationContentsAttestationPreview | null;
  readonly reason: string;
  readonly reviewConfirmed: boolean;
}>): HistoricalContentsAttestationReadiness {
  const issues: string[] = [];
  if (!input.canAttest) issues.push("Inventory adjustment permission is required.");
  if (input.preview === null) issues.push("Load a current preview before attesting.");
  if (!input.reviewConfirmed) issues.push("Confirm that both evidence sets were reviewed.");
  if (input.reason.length === 0) {
    issues.push("Enter a review reason.");
  } else {
    if (input.reason.trim() !== input.reason) {
      issues.push("Remove leading or trailing whitespace from the reason.");
    }
    if (input.reason.length > 500) issues.push("Reason must be 500 characters or fewer.");
  }
  if (issues.length > 0 || input.preview === null) {
    return Object.freeze({ ready: false, issues: Object.freeze(issues), request: null });
  }
  const parsed = historicalShipStationContentsAttestationRequestSchema.safeParse({
    expectedPreviewEvidenceHash: input.preview.previewEvidenceHash,
    reason: input.reason,
  });
  if (!parsed.success) {
    return Object.freeze({
      ready: false,
      issues: Object.freeze(["The preview identity or reason is invalid."]),
      request: null,
    });
  }
  return Object.freeze({ ready: true, issues: Object.freeze([]), request: parsed.data });
}
