import type { PurchasingForecastPolicy } from "./purchasing-forecast-policy";

export const FORWARD_DEMAND_OVERLAY_CAPTURE_VERSION = 1;

export interface PurchasingForwardDemandContribution {
  productId: number;
  productVariantId: number | null;
  demandEventId: number;
  demandEventLineId: number;
  eventName: string;
  eventType: "drop" | "preorder" | "promotion" | "wholesale" | "seasonal" | "manual_forecast";
  eventStatus: "planned" | "active";
  eventStartDate: string;
  eventEndDate: string | null;
  planningAsOfDate: string;
  expectedPieces: number;
  confidence: "high" | "medium" | "low";
  confidenceWeightPercent: number;
  weightedPieces: number;
  eventUpdatedAt: string;
  lineUpdatedAt: string;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FORWARD_DEMAND_EVENT_TYPES = new Set([
  "drop",
  "preorder",
  "promotion",
  "wholesale",
  "seasonal",
  "manual_forecast",
]);
const FORWARD_DEMAND_EVENT_STATUSES = new Set(["planned", "active"]);
const FORWARD_DEMAND_CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

function contributionRecord(value: unknown, index: number): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`forwardDemandContributions[${index}] must be an object`);
  }
  return value as Record<string, unknown>;
}

function contributionInteger(
  value: unknown,
  field: string,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${field} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function contributionString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    throw new RangeError(`${field} must be a non-empty string no longer than ${maximumLength} characters`);
  }
  return value.trim();
}

function contributionDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new RangeError(`${field} must be an ISO calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a valid ISO calendar date`);
  }
  return value;
}

function contributionTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new RangeError(`${field} must be a valid timestamp`);
  }
  return value;
}

function parseForwardDemandContributions(value: unknown): {
  captureComplete: boolean;
  contributions: PurchasingForwardDemandContribution[];
} {
  if (value === undefined || value === null) {
    return { captureComplete: false, contributions: [] };
  }
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new RangeError("forwardDemandContributions must contain valid JSON");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new RangeError("forwardDemandContributions must be an array");
  }

  const seenLineIds = new Set<number>();
  const contributions = parsed.map((entry, index): PurchasingForwardDemandContribution => {
    const row = contributionRecord(entry, index);
    const productVariantId = row.productVariantId === null
      ? null
      : contributionInteger(row.productVariantId, `forwardDemandContributions[${index}].productVariantId`, { minimum: 1 });
    const demandEventLineId = contributionInteger(
      row.demandEventLineId,
      `forwardDemandContributions[${index}].demandEventLineId`,
      { minimum: 1 },
    );
    if (seenLineIds.has(demandEventLineId)) {
      throw new RangeError(`forwardDemandContributions contains duplicate demand event line ${demandEventLineId}`);
    }
    seenLineIds.add(demandEventLineId);

    const eventType = contributionString(row.eventType, `forwardDemandContributions[${index}].eventType`, 50);
    if (!FORWARD_DEMAND_EVENT_TYPES.has(eventType)) {
      throw new RangeError(`forwardDemandContributions[${index}].eventType is unsupported`);
    }
    const eventStatus = contributionString(row.eventStatus, `forwardDemandContributions[${index}].eventStatus`, 20);
    if (!FORWARD_DEMAND_EVENT_STATUSES.has(eventStatus)) {
      throw new RangeError(`forwardDemandContributions[${index}].eventStatus is unsupported`);
    }
    const confidence = contributionString(row.confidence, `forwardDemandContributions[${index}].confidence`, 10);
    if (!FORWARD_DEMAND_CONFIDENCE_VALUES.has(confidence)) {
      throw new RangeError(`forwardDemandContributions[${index}].confidence is unsupported`);
    }
    const eventStartDate = contributionDate(
      row.eventStartDate,
      `forwardDemandContributions[${index}].eventStartDate`,
    );
    const eventEndDate = row.eventEndDate === null
      ? null
      : contributionDate(row.eventEndDate, `forwardDemandContributions[${index}].eventEndDate`);
    if (eventEndDate !== null && eventEndDate < eventStartDate) {
      throw new RangeError(`forwardDemandContributions[${index}].eventEndDate cannot precede eventStartDate`);
    }
    const planningAsOfDate = contributionDate(
      row.planningAsOfDate,
      `forwardDemandContributions[${index}].planningAsOfDate`,
    );
    if (eventEndDate !== null && eventEndDate < planningAsOfDate) {
      throw new RangeError(`forwardDemandContributions[${index}].eventEndDate cannot precede planningAsOfDate`);
    }

    return {
      productId: contributionInteger(
        row.productId,
        `forwardDemandContributions[${index}].productId`,
        { minimum: 1 },
      ),
      productVariantId,
      demandEventId: contributionInteger(
        row.demandEventId,
        `forwardDemandContributions[${index}].demandEventId`,
        { minimum: 1 },
      ),
      demandEventLineId,
      eventName: contributionString(row.eventName, `forwardDemandContributions[${index}].eventName`, 255),
      eventType: eventType as PurchasingForwardDemandContribution["eventType"],
      eventStatus: eventStatus as PurchasingForwardDemandContribution["eventStatus"],
      eventStartDate,
      eventEndDate,
      planningAsOfDate,
      expectedPieces: contributionInteger(
        row.expectedPieces,
        `forwardDemandContributions[${index}].expectedPieces`,
      ),
      confidence: confidence as PurchasingForwardDemandContribution["confidence"],
      confidenceWeightPercent: contributionInteger(
        row.confidenceWeightPercent,
        `forwardDemandContributions[${index}].confidenceWeightPercent`,
        { maximum: 100 },
      ),
      weightedPieces: contributionInteger(
        row.weightedPieces,
        `forwardDemandContributions[${index}].weightedPieces`,
      ),
      eventUpdatedAt: contributionTimestamp(
        row.eventUpdatedAt,
        `forwardDemandContributions[${index}].eventUpdatedAt`,
      ),
      lineUpdatedAt: contributionTimestamp(
        row.lineUpdatedAt,
        `forwardDemandContributions[${index}].lineUpdatedAt`,
      ),
    };
  });

  return { captureComplete: true, contributions };
}

function assertForwardDemandContributionTotals(input: {
  productId: number;
  forwardDemandPieces: number;
  forwardDemandRawPieces: number;
  forwardDemandEventCount: number;
  contributions: PurchasingForwardDemandContribution[];
  confidenceWeights: PurchasingForecastPolicy["forwardDemandConfidenceWeights"];
}) {
  for (const [field, value] of [
    ["forwardDemandPieces", input.forwardDemandPieces],
    ["forwardDemandRawPieces", input.forwardDemandRawPieces],
    ["forwardDemandEventCount", input.forwardDemandEventCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${field} must be a non-negative safe integer when overlay capture is complete`);
    }
  }

  let weightedPieces = BigInt(0);
  let rawPieces = BigInt(0);
  const eventIds = new Set<number>();
  for (const contribution of input.contributions) {
    if (contribution.productId !== input.productId) {
      throw new RangeError(
        `Forward-demand contribution product ${contribution.productId} does not match recommendation product ${input.productId}`,
      );
    }
    const expectedWeight = input.confidenceWeights[contribution.confidence];
    if (contribution.confidenceWeightPercent !== expectedWeight) {
      throw new RangeError(
        `Forward-demand contribution ${contribution.demandEventLineId} does not match the active confidence weight`,
      );
    }
    const expectedWeightedPieces = (
      BigInt(contribution.expectedPieces) * BigInt(expectedWeight) + BigInt(99)
    ) / BigInt(100);
    if (BigInt(contribution.weightedPieces) !== expectedWeightedPieces) {
      throw new RangeError(
        `Forward-demand contribution ${contribution.demandEventLineId} has an invalid weighted quantity`,
      );
    }
    weightedPieces += BigInt(contribution.weightedPieces);
    rawPieces += BigInt(contribution.expectedPieces);
    eventIds.add(contribution.demandEventId);
  }
  if (
    weightedPieces !== BigInt(input.forwardDemandPieces)
    || rawPieces !== BigInt(input.forwardDemandRawPieces)
    || eventIds.size !== input.forwardDemandEventCount
  ) {
    throw new RangeError("Forward-demand contribution totals do not match the recommendation aggregate");
  }
}

export function resolvePurchasingForwardDemandContributionCapture(input: {
  rawContributions: unknown;
  enabled: boolean;
  productId: number;
  forwardDemandPieces: number;
  forwardDemandRawPieces: number;
  forwardDemandEventCount: number;
  confidenceWeights: PurchasingForecastPolicy["forwardDemandConfidenceWeights"];
}) {
  const parsed = parseForwardDemandContributions(input.rawContributions);
  const contributions = input.enabled ? parsed.contributions : [];
  if (parsed.captureComplete) {
    assertForwardDemandContributionTotals({ ...input, contributions });
  }
  return {
    overlayCaptureVersion: parsed.captureComplete ? FORWARD_DEMAND_OVERLAY_CAPTURE_VERSION : 0,
    overlayCaptureComplete: parsed.captureComplete,
    contributions,
  };
}
