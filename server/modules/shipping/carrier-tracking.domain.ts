import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

export const SHIPSTATION_TRACKING_STATUS_CODES = [
  "UN",
  "AC",
  "IT",
  "DE",
  "EX",
  "AT",
  "NY",
  "SP",
] as const;

export type ShipStationTrackingStatusCode = (typeof SHIPSTATION_TRACKING_STATUS_CODES)[number];
export type CanonicalCarrierTrackingStatus =
  | "unknown"
  | "pre_transit"
  | "accepted"
  | "in_transit"
  | "delivered"
  | "exception"
  | "delivery_attempt"
  | "delivered_to_service_point";
export type CarrierDispatchEvidence = "confirmed" | "not_confirmed" | "review";
export type CarrierTrackingEventTimeSource =
  | "carrier_event"
  | "actual_delivery"
  | "ship_date"
  | "unavailable";
export type CarrierTrackingMatchStatus =
  | "matched"
  | "unmatched"
  | "ambiguous"
  | "voided_label"
  | "review";

export type ShippingProviderLabelStatus = "active" | "voided" | "superseded" | "unknown";
export type ShippingProviderLabelEventType =
  | "label_observed"
  | "label_voided"
  | "label_superseded";

export const CARRIER_TRACKING_PARSER_VERSION = "shipstation-api-track-v1";

const boundedOptionalString = (max: number) => z.string().trim().min(1).max(max).nullish();

const shipStationTrackingHistoryEventSchema = z.object({
  occurred_at: boundedOptionalString(80),
  carrier_occurred_at: boundedOptionalString(80),
  description: boundedOptionalString(1_000),
  event_code: boundedOptionalString(100),
  event_description: boundedOptionalString(2_000),
  status_code: z.enum(SHIPSTATION_TRACKING_STATUS_CODES).nullish(),
  status_detail_code: boundedOptionalString(100),
  carrier_detail_code: boundedOptionalString(100),
  city_locality: boundedOptionalString(200),
  state_province: boundedOptionalString(200),
  postal_code: boundedOptionalString(40),
  country_code: boundedOptionalString(10),
}).passthrough();

const shipStationTrackingDataSchema = z.object({
  label_url: boundedOptionalString(2_048),
  tracking_number: z.string().trim().min(1).max(200),
  status_code: z.enum(SHIPSTATION_TRACKING_STATUS_CODES),
  status_detail_code: boundedOptionalString(100),
  carrier_detail_code: boundedOptionalString(100),
  status_description: boundedOptionalString(1_000),
  carrier_status_code: boundedOptionalString(100),
  carrier_status_description: boundedOptionalString(2_000),
  ship_date: boundedOptionalString(80),
  estimated_delivery_date: boundedOptionalString(80),
  actual_delivery_date: boundedOptionalString(80),
  exception_description: boundedOptionalString(2_000),
  carrier_code: boundedOptionalString(100),
  label_id: boundedOptionalString(200),
  events: z.array(shipStationTrackingHistoryEventSchema).max(500).default([]),
}).passthrough();

export const shipStationTrackingWebhookSchema = z.object({
  resource_type: z.literal("API_TRACK"),
  resource_url: z.string().url().max(2_048),
  data: shipStationTrackingDataSchema,
}).passthrough();

const shipStationTrackingWebhookEnvelopeSchema = z.object({
  resource_type: z.literal("API_TRACK"),
  resource_url: z.string().url().max(2_048),
  data: z.unknown().nullish(),
}).passthrough();

type ShipStationTrackingData = z.infer<typeof shipStationTrackingDataSchema>;
type ShipStationTrackingHistoryEvent = z.infer<typeof shipStationTrackingHistoryEventSchema>;

export class CarrierTrackingPayloadError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly code:
      | "INVALID_CARRIER_TRACKING_PAYLOAD"
      | "SHIPSTATION_TRACKING_DATA_MISSING" = "INVALID_CARRIER_TRACKING_PAYLOAD",
  ) {
    super(message);
    this.name = "CarrierTrackingPayloadError";
  }
}

export interface NormalizedCarrierTrackingEvent {
  provider: "shipstation";
  eventHash: string;
  payloadHash: string;
  trackingNumber: string;
  normalizedTrackingNumber: string;
  providerStatusCode: ShipStationTrackingStatusCode;
  providerStatusDetailCode: string | null;
  providerCarrierStatusCode: string | null;
  providerCarrierDetailCode: string | null;
  canonicalStatus: CanonicalCarrierTrackingStatus;
  dispatchEvidence: CarrierDispatchEvidence;
  statusDescription: string | null;
  carrierStatusDescription: string | null;
  eventOccurredAt: Date | null;
  eventTimeSource: CarrierTrackingEventTimeSource;
  estimatedDeliveryAt: Date | null;
  actualDeliveryAt: Date | null;
  providerLabelId: string | null;
  carrier: string | null;
  sanitizedPayload: Record<string, unknown>;
  receivedAt: Date;
}

export interface VerifiedCarrierWebhookReceipt {
  provider: "shipstation";
  receiptHash: string;
  signatureAlgorithm: "RSA-SHA256" | "HMAC-SHA256";
  signatureKeyId: string;
  signatureTimestampRaw: string;
  signatureTimestampAt: Date;
  rawBodyBase64: string;
  rawBodyHash: string;
  signatureBase64: string;
  signatureHash: string;
  verifiedAt: Date;
}

export class ShippingProviderLabelIdentityConflictError extends Error {
  readonly code = "SHIPPING_PROVIDER_LABEL_IDENTITY_CONFLICT";

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShippingProviderLabelIdentityConflictError";
  }
}

export function assertStableShippingProviderLabelIdentity(
  existing: {
    normalizedTrackingNumber: string;
    providerOrderId: string | null;
    providerOrderKey: string | null;
  },
  observation: Pick<
    NormalizedShippingProviderLabelObservation,
    "provider" | "providerLabelId" | "normalizedTrackingNumber" | "providerOrderId" | "providerOrderKey"
  >,
): void {
  const conflicts = [
    existing.normalizedTrackingNumber !== observation.normalizedTrackingNumber
      ? { field: "normalizedTrackingNumber", existing: existing.normalizedTrackingNumber, observed: observation.normalizedTrackingNumber }
      : null,
    existing.providerOrderId && observation.providerOrderId
      && existing.providerOrderId !== observation.providerOrderId
      ? { field: "providerOrderId", existing: existing.providerOrderId, observed: observation.providerOrderId }
      : null,
    existing.providerOrderKey && observation.providerOrderKey
      && existing.providerOrderKey !== observation.providerOrderKey
      ? { field: "providerOrderKey", existing: existing.providerOrderKey, observed: observation.providerOrderKey }
      : null,
  ].filter((conflict): conflict is NonNullable<typeof conflict> => conflict !== null);

  if (conflicts.length > 0) {
    throw new ShippingProviderLabelIdentityConflictError(
      "A provider label was observed with conflicting immutable identity fields",
      {
        provider: observation.provider,
        providerLabelId: observation.providerLabelId,
        conflicts,
      },
    );
  }
}

export interface NormalizedShippingProviderLabelObservation {
  provider: "shipstation";
  providerLabelId: string;
  providerOrderId: string | null;
  providerOrderKey: string | null;
  trackingNumber: string;
  normalizedTrackingNumber: string;
  labelStatus: ShippingProviderLabelStatus;
  eventType: ShippingProviderLabelEventType;
  carrier: string | null;
  serviceCode: string | null;
  labelCreatedAt: Date | null;
  voidedAt: Date | null;
  providerOccurredAt: Date | null;
  eventHash: string;
  sanitizedPayload: Record<string, unknown>;
  observedAt: Date;
}

const shipStationLabelObservationSchema = z.object({
  shipmentId: z.number().int().positive(),
  orderId: z.number().int().positive().nullish(),
  orderKey: boundedOptionalString(500),
  trackingNumber: z.string().trim().min(1).max(200),
  carrierCode: boundedOptionalString(100),
  serviceCode: boundedOptionalString(100),
  shipDate: boundedOptionalString(80),
  voidDate: boundedOptionalString(80),
  // ShipStation V1 includes these only when the caller requests
  // includeShipmentItems=true. Keep the raw members opaque here so a malformed
  // optional item cannot prevent us from observing the label itself; the
  // sanitizer below accepts only exact Echelon-owned line-item identities.
  shipmentItems: z.array(z.unknown()).max(500).optional(),
}).passthrough();

interface SanitizedShipStationShipmentItemIdentity {
  lineItemKey: string;
}

function sanitizeShipStationShipmentItemIdentities(
  rawItems: unknown[] | undefined,
): SanitizedShipStationShipmentItemIdentity[] {
  const identities = new Set<string>();
  for (const rawItem of rawItems ?? []) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const rawKey = (rawItem as Record<string, unknown>).lineItemKey;
    if (typeof rawKey !== "string") continue;
    const lineItemKey = rawKey.trim();
    if (!/^wms-item-[1-9][0-9]*$/.test(lineItemKey) || lineItemKey.length > 200) continue;
    identities.add(lineItemKey);
  }
  return [...identities]
    .sort((left, right) => left.localeCompare(right))
    .map((lineItemKey) => ({ lineItemKey }));
}

export interface CarrierTrackingMatchCandidate {
  shippingProviderLabelId: number;
  providerLabelId: string;
  labelStatus: ShippingProviderLabelStatus;
  linkCount: number;
  orderNumbers: string[];
  carrier: string | null;
  serviceCode: string | null;
}

export interface CarrierTrackingMatchResolution {
  status: CarrierTrackingMatchStatus;
  reasonCode: string;
  candidateCount: number;
  selectedCandidate: CarrierTrackingMatchCandidate | null;
  candidates: CarrierTrackingMatchCandidate[];
  attemptHash: string;
}

const canonicalStatusByProviderCode: Record<ShipStationTrackingStatusCode, CanonicalCarrierTrackingStatus> = {
  UN: "unknown",
  AC: "accepted",
  IT: "in_transit",
  DE: "delivered",
  EX: "exception",
  AT: "delivery_attempt",
  NY: "pre_transit",
  SP: "delivered_to_service_point",
};

const PHYSICAL_DETAIL_CODES = new Set([
  "DROPPED_OFF",
  "PICKED_UP",
  "RECD_BY_CARRIER_NO_ELEC_ADVICE",
]);

const NON_PHYSICAL_DETAIL_CODES = new Set([
  "SHIPMENT_CREATED",
  "AWAITING_PICKUP_DROP_OFF",
  "ELEC_ADVICE_RECD_BY_CARRIER",
]);

const PHYSICAL_DESCRIPTION_PATTERNS = [
  /\bpicked up\b/i,
  /\bdropped off\b/i,
  /\borigin scan\b/i,
  /\breceived by (?:the )?carrier\b/i,
  /\bcarrier (?:has )?(?:received|accepted|picked up)\b/i,
  /\bacceptance(?: at origin)?\b/i,
];

const NON_PHYSICAL_DESCRIPTION_PATTERNS = [
  /\blabel (?:was )?created\b/i,
  /\bshipment (?:information|info) (?:was )?sent\b/i,
  /\bpre[- ]?shipment\b/i,
  /\bawaiting (?:carrier )?(?:pickup|drop[- ]?off)\b/i,
  /\belectronic advice\b/i,
  /\bnot yet in (?:the )?system\b/i,
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function carrierTrackingReceiptParseAttemptHash(input: {
  parserVersion: string;
  outcome: "normalized" | "rejected";
  eventHash: string | null;
  reasonCode: string;
}): string {
  return sha256(canonicalJson(input));
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableCarrierCode(value: unknown): string | null {
  return nullableString(value)?.toLowerCase() ?? null;
}

function parseProviderTimestamp(value: unknown, field: string): Date | null {
  const raw = nullableString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new CarrierTrackingPayloadError(`ShipStation ${field} is not a valid timestamp`, {
      field,
      value: raw,
    });
  }
  return parsed;
}

export function normalizeTrackingNumber(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 4 || normalized.length > 200) {
    throw new CarrierTrackingPayloadError("Tracking number is not usable after normalization", {
      normalizedLength: normalized.length,
    });
  }
  return normalized;
}

function latestHistoryEvent(events: ShipStationTrackingHistoryEvent[]): {
  event: ShipStationTrackingHistoryEvent | null;
  occurredAt: Date | null;
} {
  const timestamped = events.flatMap((event) => {
    const raw = nullableString(event.occurred_at);
    if (!raw) return [];
    const occurredAt = new Date(raw);
    if (Number.isNaN(occurredAt.getTime())) return [];
    return [{ event, occurredAt }];
  });
  timestamped.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
  return timestamped[0] ?? { event: null, occurredAt: null };
}

function containsPattern(values: Array<string | null>, patterns: RegExp[]): boolean {
  return values.some((value) => value !== null && patterns.some((pattern) => pattern.test(value)));
}

function dispatchEvidenceFor(
  data: ShipStationTrackingData,
  detailCode: string | null,
): CarrierDispatchEvidence {
  if (["IT", "DE", "AT", "SP"].includes(data.status_code)) return "confirmed";

  const normalizedDetails = [
    detailCode,
    nullableString(data.carrier_detail_code),
    ...data.events.flatMap((event) => [
      nullableString(event.status_detail_code),
      nullableString(event.carrier_detail_code),
    ]),
  ].flatMap((value) => value ? [value.toUpperCase()] : []);
  const descriptions = [
    nullableString(data.status_description),
    nullableString(data.carrier_status_description),
    nullableString(data.exception_description),
    ...data.events.flatMap((event) => [
      nullableString(event.description),
      nullableString(event.event_description),
    ]),
  ];

  // Carrier possession is monotonic evidence. A later exception or provider
  // status regression cannot erase an earlier physical acceptance scan.
  if (normalizedDetails.some((value) => PHYSICAL_DETAIL_CODES.has(value))) return "confirmed";
  const hasUnambiguousPhysicalDescription = descriptions.some((description) => (
    description !== null
    && !containsPattern([description], NON_PHYSICAL_DESCRIPTION_PATTERNS)
    && containsPattern([description], PHYSICAL_DESCRIPTION_PATTERNS)
  ));
  if (hasUnambiguousPhysicalDescription) return "confirmed";

  if (data.status_code === "NY") return "not_confirmed";
  if (normalizedDetails.some((value) => NON_PHYSICAL_DETAIL_CODES.has(value))) return "not_confirmed";
  if (containsPattern(descriptions, NON_PHYSICAL_DESCRIPTION_PATTERNS)) return "not_confirmed";

  // Accepted without a possession detail and exceptions without earlier
  // physical evidence are deliberately held for review in the shadow phase.
  return "review";
}

function carrierFromResourceUrl(resourceUrl: string): string | null {
  try {
    return nullableCarrierCode(new URL(resourceUrl).searchParams.get("carrier_code"));
  } catch {
    return null;
  }
}

function sanitizeHistoryEvent(event: ShipStationTrackingHistoryEvent): Record<string, unknown> {
  return {
    occurredAt: nullableString(event.occurred_at),
    carrierOccurredAt: nullableString(event.carrier_occurred_at),
    description: nullableString(event.description),
    eventCode: nullableString(event.event_code),
    eventDescription: nullableString(event.event_description),
    statusCode: nullableString(event.status_code),
    statusDetailCode: nullableString(event.status_detail_code),
    carrierDetailCode: nullableString(event.carrier_detail_code),
    cityLocality: nullableString(event.city_locality),
    stateProvince: nullableString(event.state_province),
    postalCode: nullableString(event.postal_code),
    countryCode: nullableString(event.country_code),
  };
}

export function normalizeShipStationTrackingWebhook(
  rawPayload: unknown,
  receivedAt: Date,
): NormalizedCarrierTrackingEvent {
  if (Number.isNaN(receivedAt.getTime())) {
    throw new CarrierTrackingPayloadError("receivedAt must be a valid timestamp");
  }

  const parsed = shipStationTrackingWebhookSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const envelope = shipStationTrackingWebhookEnvelopeSchema.safeParse(rawPayload);
    if (envelope.success && envelope.data.data == null) {
      throw new CarrierTrackingPayloadError(
        "ShipStation tracking webhook did not include its optional tracking data object",
        {
          resourceType: envelope.data.resource_type,
          resourceUrl: envelope.data.resource_url,
        },
        "SHIPSTATION_TRACKING_DATA_MISSING",
      );
    }
    throw new CarrierTrackingPayloadError("ShipStation tracking webhook failed validation", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  const data = parsed.data.data;
  const trackingNumber = data.tracking_number.trim();
  const normalizedTrackingNumber = normalizeTrackingNumber(trackingNumber);
  const latest = latestHistoryEvent(data.events);
  const providerStatusDetailCode = nullableString(data.status_detail_code)
    ?? nullableString(latest.event?.status_detail_code)
    ?? nullableString(latest.event?.carrier_detail_code);
  const actualDeliveryAt = parseProviderTimestamp(data.actual_delivery_date, "actual_delivery_date");
  const estimatedDeliveryAt = parseProviderTimestamp(data.estimated_delivery_date, "estimated_delivery_date");
  const shipDate = parseProviderTimestamp(data.ship_date, "ship_date");

  let eventOccurredAt: Date | null = latest.occurredAt;
  let eventTimeSource: CarrierTrackingEventTimeSource = latest.occurredAt
    ? "carrier_event"
    : "unavailable";
  if (!eventOccurredAt && actualDeliveryAt) {
    eventOccurredAt = actualDeliveryAt;
    eventTimeSource = "actual_delivery";
  } else if (!eventOccurredAt && shipDate) {
    eventOccurredAt = shipDate;
    eventTimeSource = "ship_date";
  }

  const carrier = nullableCarrierCode(data.carrier_code)
    ?? carrierFromResourceUrl(parsed.data.resource_url);
  const sanitizedPayload = {
    resourceType: parsed.data.resource_type,
    resourceHost: new URL(parsed.data.resource_url).host,
    resourcePath: new URL(parsed.data.resource_url).pathname,
    trackingNumber,
    statusCode: data.status_code,
    statusDetailCode: nullableString(data.status_detail_code),
    carrierDetailCode: nullableString(data.carrier_detail_code),
    statusDescription: nullableString(data.status_description),
    carrierStatusCode: nullableString(data.carrier_status_code),
    carrierStatusDescription: nullableString(data.carrier_status_description),
    shipDate: nullableString(data.ship_date),
    estimatedDeliveryDate: nullableString(data.estimated_delivery_date),
    actualDeliveryDate: nullableString(data.actual_delivery_date),
    exceptionDescription: nullableString(data.exception_description),
    carrierCode: carrier,
    labelId: nullableString(data.label_id),
    events: data.events.map(sanitizeHistoryEvent),
  };

  const payloadHash = sha256(canonicalJson(sanitizedPayload));

  return {
    provider: "shipstation",
    // Each distinct normalized provider snapshot is preserved. Exact webhook
    // redelivery remains idempotent, while expanded event history cannot be
    // collapsed onto an older classification.
    eventHash: sha256(canonicalJson({ provider: "shipstation", payloadHash })),
    payloadHash,
    trackingNumber,
    normalizedTrackingNumber,
    providerStatusCode: data.status_code,
    providerStatusDetailCode,
    providerCarrierStatusCode: nullableString(data.carrier_status_code),
    providerCarrierDetailCode: nullableString(data.carrier_detail_code),
    canonicalStatus: canonicalStatusByProviderCode[data.status_code],
    dispatchEvidence: dispatchEvidenceFor(data, providerStatusDetailCode),
    statusDescription: nullableString(data.status_description),
    carrierStatusDescription: nullableString(data.carrier_status_description),
    eventOccurredAt,
    eventTimeSource,
    estimatedDeliveryAt,
    actualDeliveryAt,
    providerLabelId: nullableString(data.label_id),
    carrier,
    sanitizedPayload,
    receivedAt: new Date(receivedAt),
  };
}

export function normalizeShipStationLabelObservation(
  rawShipment: unknown,
  observedAt: Date,
): NormalizedShippingProviderLabelObservation {
  if (Number.isNaN(observedAt.getTime())) {
    throw new CarrierTrackingPayloadError("observedAt must be a valid timestamp");
  }
  const parsed = shipStationLabelObservationSchema.safeParse(rawShipment);
  if (!parsed.success) {
    throw new CarrierTrackingPayloadError("ShipStation label observation failed validation", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  const shipment = parsed.data;
  const trackingNumber = shipment.trackingNumber.trim();
  const normalizedTrackingNumber = normalizeTrackingNumber(trackingNumber);
  const shipDate = parseProviderTimestamp(shipment.shipDate, "shipDate");
  const voidedAt = parseProviderTimestamp(shipment.voidDate, "voidDate");
  const labelStatus: ShippingProviderLabelStatus = voidedAt ? "voided" : "active";
  const eventType: ShippingProviderLabelEventType = voidedAt
    ? "label_voided"
    : "label_observed";
  const shipmentItems = sanitizeShipStationShipmentItemIdentities(
    shipment.shipmentItems,
  );
  const sanitizedPayload = {
    providerLabelId: String(shipment.shipmentId),
    providerOrderId: shipment.orderId == null ? null : String(shipment.orderId),
    providerOrderKey: nullableString(shipment.orderKey),
    trackingNumber,
    carrierCode: nullableCarrierCode(shipment.carrierCode),
    serviceCode: nullableString(shipment.serviceCode),
    shipDate: nullableString(shipment.shipDate),
    voidDate: nullableString(shipment.voidDate),
    shipmentItems,
  };
  const eventIdentity = {
    provider: "shipstation",
    ...sanitizedPayload,
    labelStatus,
  };

  return {
    provider: "shipstation",
    providerLabelId: String(shipment.shipmentId),
    providerOrderId: shipment.orderId == null ? null : String(shipment.orderId),
    providerOrderKey: nullableString(shipment.orderKey),
    trackingNumber,
    normalizedTrackingNumber,
    labelStatus,
    eventType,
    carrier: nullableCarrierCode(shipment.carrierCode),
    serviceCode: nullableString(shipment.serviceCode),
    // ShipStation's shipDate is not documented as label-purchase time. Keep
    // labelCreatedAt unknown rather than inventing a lifecycle timestamp.
    labelCreatedAt: null,
    voidedAt,
    providerOccurredAt: voidedAt ?? shipDate,
    eventHash: sha256(canonicalJson(eventIdentity)),
    sanitizedPayload,
    observedAt: new Date(observedAt),
  };
}

function candidateIdentity(candidate: CarrierTrackingMatchCandidate): string {
  return `label:${candidate.shippingProviderLabelId}`;
}

function mergeCandidate(
  existing: CarrierTrackingMatchCandidate,
  incoming: CarrierTrackingMatchCandidate,
): CarrierTrackingMatchCandidate {
  const prefer = <T>(left: T | null, right: T | null): T | null => left ?? right;
  const status = existing.labelStatus === "active" || incoming.labelStatus === "active"
    ? "active"
    : existing.labelStatus === "voided" || incoming.labelStatus === "voided"
      ? "voided"
      : existing.labelStatus === "superseded" || incoming.labelStatus === "superseded"
        ? "superseded"
        : "unknown";
  return {
    shippingProviderLabelId: existing.shippingProviderLabelId,
    providerLabelId: existing.providerLabelId,
    labelStatus: status,
    linkCount: Math.max(existing.linkCount, incoming.linkCount),
    orderNumbers: [...new Set([...existing.orderNumbers, ...incoming.orderNumbers])].sort(),
    carrier: prefer(existing.carrier, incoming.carrier),
    serviceCode: prefer(existing.serviceCode, incoming.serviceCode),
  };
}

export function resolveCarrierTrackingMatch(
  rawCandidates: CarrierTrackingMatchCandidate[],
): CarrierTrackingMatchResolution {
  const deduplicated = new Map<string, CarrierTrackingMatchCandidate>();
  for (const candidate of rawCandidates) {
    const key = candidateIdentity(candidate);
    const existing = deduplicated.get(key);
    deduplicated.set(key, existing ? mergeCandidate(existing, candidate) : candidate);
  }
  const candidates = [...deduplicated.values()].sort((left, right) =>
    candidateIdentity(left).localeCompare(candidateIdentity(right)));
  const active = candidates.filter((candidate) =>
    candidate.labelStatus === "active" || candidate.labelStatus === "unknown");
  const voided = candidates.filter((candidate) =>
    candidate.labelStatus === "voided" || candidate.labelStatus === "superseded");

  let status: CarrierTrackingMatchStatus;
  let reasonCode: string;
  let selectedCandidate: CarrierTrackingMatchCandidate | null = null;
  if (active.length === 1) {
    status = "matched";
    reasonCode = "single_active_label_candidate";
    selectedCandidate = active[0];
  } else if (active.length > 1) {
    status = "ambiguous";
    reasonCode = "multiple_active_label_candidates";
  } else if (voided.length > 0) {
    status = "voided_label";
    reasonCode = voided.length === 1
      ? "tracking_matches_voided_label"
      : "tracking_matches_multiple_voided_labels";
    selectedCandidate = voided.length === 1 ? voided[0] : null;
  } else {
    status = "unmatched";
    reasonCode = "no_label_candidate";
  }

  const attemptIdentity = {
    status,
    reasonCode,
    candidates: candidates.map((candidate) => ({
      identity: candidateIdentity(candidate),
      labelStatus: candidate.labelStatus,
      shippingProviderLabelId: candidate.shippingProviderLabelId,
      providerLabelId: candidate.providerLabelId,
      linkCount: candidate.linkCount,
    })),
  };

  return {
    status,
    reasonCode,
    candidateCount: candidates.length,
    selectedCandidate,
    candidates,
    attemptHash: sha256(canonicalJson(attemptIdentity)),
  };
}
