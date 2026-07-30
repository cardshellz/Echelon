import { and, eq, sql } from "drizzle-orm";

import {
  carrierDispatchAttempts,
  carrierDispatchCommandRequeues,
  carrierDispatchCommands,
  carrierTrackingSubscriptionRequeues,
  carrierTrackingSubscriptionAttempts,
  carrierTrackingSubscriptionLabels,
  carrierTrackingSubscriptions,
  carrierTrackingEventMatches,
  carrierTrackingEvents,
  carrierTrackingReconciliationState,
  carrierTrackingWebhookHydrationAttempts,
  carrierTrackingWebhookHydrations,
  carrierTrackingWebhookReceiptParses,
  carrierTrackingWebhookReceipts,
  shippingProviderLabelEvents,
  shippingProviderLabels,
} from "@shared/schema";
import {
  SHIPSTATION_TRACKING_STATUS_CODES,
  assertStableShippingProviderLabelIdentity,
  carrierTrackingReceiptParseAttemptHash,
  type CanonicalCarrierTrackingStatus,
  type CarrierDispatchEvidence,
  CarrierTrackingMatchCandidate,
  CarrierTrackingMatchResolution,
  NormalizedCarrierTrackingEvent,
  NormalizedShippingProviderLabelObservation,
  type ShippingProviderLabelDirection,
  VerifiedCarrierWebhookReceipt,
} from "./carrier-tracking.domain";
import type { ShipStationTrackingHydrationRequest } from "./shipstation-tracking-events.client";

export interface StoredCarrierTrackingEvent {
  id: number;
  inserted: boolean;
}

export interface StoredCarrierTrackingMatch {
  id: number;
  inserted: boolean;
  shippingProviderLabelId: number | null;
}

export interface StoredCarrierDispatchCommand {
  id: number;
  inserted: boolean;
  status: string;
}

export interface ClaimedCarrierDispatchCommand {
  id: number;
  shippingProviderLabelId: number;
  carrierTrackingEventId: number;
  provider: string;
  providerLabelId: string;
  providerOrderId: string | null;
  providerOrderKey: string | null;
  trackingNumber: string;
  normalizedTrackingNumber: string;
  carrier: string | null;
  serviceCode: string | null;
  dispatchOccurredAt: Date;
  attemptNumber: number;
  consecutiveFailureCount: number;
  startedAt: Date;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export interface FinalizeCarrierDispatchAttemptInput {
  commandId: number;
  attemptNumber: number;
  leaseOwner: string;
  outcome: "succeeded" | "retry_scheduled" | "review_required";
  errorCode: string | null;
  errorMessage: string | null;
  requestEvidence: Record<string, unknown>;
  responseEvidence: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  nextAttemptAt: Date | null;
}

export interface StoredCarrierDispatchAttempt {
  id: number;
  inserted: boolean;
  outcome: "succeeded" | "retry_scheduled" | "review_required";
}

export interface StoredCarrierTrackingWebhookReceipt {
  id: number;
  inserted: boolean;
}

export interface StoredCarrierTrackingWebhookReceiptParse {
  id: number;
  inserted: boolean;
}

export interface StoredCarrierTrackingWebhookRejection
  extends StoredCarrierTrackingWebhookReceiptParse {
  hydrationPrepared: boolean;
}

export interface StoredShippingProviderLabelObservation {
  shippingProviderLabelId: number;
  labelInserted: boolean;
  eventInserted: boolean;
}

export interface ShippingProviderLabelLinkResult {
  shippingProviderLabelId: number;
  linksInserted: number;
  totalLinks: number;
}

export interface UnlinkedShippingProviderLabel {
  provider: string;
  providerLabelId: string;
}

export interface CarrierTrackingSubscriptionPreparationResult {
  subscriptionsInserted: number;
  labelLinksInserted: number;
}

export interface ClaimedCarrierTrackingSubscription {
  id: number;
  trackingProvider: string;
  carrierCode: string;
  trackingNumber: string;
  normalizedTrackingNumber: string;
  attemptNumber: number;
  consecutiveFailureCount: number;
  startedAt: Date;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export interface CarrierTrackingLabelPollPreparationResult {
  inserted: number;
  completed: number;
  retired: number;
}

export interface ClaimedCarrierTrackingLabelPoll {
  shippingProviderLabelId: number;
  providerLabelId: string;
  carrierCode: string;
  trackingNumber: string;
  normalizedTrackingNumber: string;
  attemptNumber: number;
  consecutiveFailureCount: number;
  startedAt: Date;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export interface FinalizeCarrierTrackingLabelPollAttemptInput {
  shippingProviderLabelId: number;
  attemptNumber: number;
  leaseOwner: string;
  outcome: "confirmed" | "waiting" | "retry_scheduled" | "review_required";
  httpStatus: number | null;
  carrierTrackingEventId: number | null;
  dispatchEvidence: CarrierDispatchEvidence | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestEvidence: Record<string, unknown>;
  responseEvidence: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  nextAttemptAt: Date | null;
}

export interface StoredCarrierTrackingLabelPollAttempt {
  id: number;
  inserted: boolean;
  outcome: FinalizeCarrierTrackingLabelPollAttemptInput["outcome"];
}

export interface FinalizeCarrierTrackingSubscriptionAttemptInput {
  subscriptionId: number;
  attemptNumber: number;
  leaseOwner: string;
  outcome: "activated" | "retry_scheduled" | "review_required";
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestEvidence: Record<string, unknown>;
  responseEvidence: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  nextAttemptAt: Date | null;
}

export interface StoredCarrierTrackingSubscriptionAttempt {
  id: number;
  inserted: boolean;
}

export interface RequeueReviewedTrackingSubscriptionsInput {
  errorCode: string;
  carrierCode: string | null;
  httpStatus: number | null;
  limit: number;
  expectedCount: number;
  operator: string;
  reason: string;
  idempotencyKey: string;
  requeuedAt: Date;
}

export interface RequeueReviewedTrackingSubscriptionsResult {
  selected: number;
  requeued: number;
}

export interface RequeueReviewedCarrierDispatchCommandsInput {
  limit: number;
  expectedCount: number;
  cohort: HistoricalCarrierDispatchRepairCohort | null;
  operator: string;
  reason: string;
  idempotencyKey: string;
  requeuedAt: Date;
}

export interface RequeueReviewedCarrierDispatchCommandsResult {
  selected: number;
  requeued: number;
  byCohort: Readonly<Record<string, number>>;
}

export type HistoricalCarrierDispatchRepairCohort =
  | "aggregate_package_identity_conflict"
  | "immutable_command_request_conflict"
  | "package_resolution_retry"
  | "legacy_outbound_shipment_identity_conflict";

export interface HistoricalCarrierDispatchRepairCandidate {
  commandId: number;
  shippingProviderLabelId: number;
  providerLabelId: string;
  providerOrderId: string | null;
  trackingSuffix: string;
  repairCohort: HistoricalCarrierDispatchRepairCohort;
  lastErrorCode: string;
  lastErrorMessage: string | null;
}

export interface HistoricalCarrierDispatchRepairPreview {
  candidateCount: number;
  selectedCount: number;
  byCohort: Readonly<Record<string, number>>;
  sample: readonly HistoricalCarrierDispatchRepairCandidate[];
}

export interface ClaimedCarrierTrackingWebhookHydration {
  receiptId: number;
  resourceUrl: string;
  carrierCode: string;
  trackingNumber: string;
  normalizedTrackingNumber: string;
  attemptNumber: number;
  consecutiveFailureCount: number;
  webhookVerifiedAt: Date;
  startedAt: Date;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export interface FinalizeCarrierTrackingWebhookHydrationAttemptInput {
  receiptId: number;
  attemptNumber: number;
  leaseOwner: string;
  outcome: "hydrated" | "retry_scheduled" | "review_required";
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestEvidence: Record<string, unknown>;
  responseEvidence: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  nextAttemptAt: Date | null;
  event: NormalizedCarrierTrackingEvent | null;
  parserVersion: string;
  parseReasonCode: string;
}

export interface StoredCarrierTrackingWebhookHydrationAttempt {
  id: number;
  inserted: boolean;
  eventId: number | null;
  eventInserted: boolean;
  parseAttemptId: number | null;
  parseAttemptInserted: boolean;
}

export interface CarrierTrackingTransaction {
  acquireTrackingLock(provider: string, normalizedTrackingNumber: string): Promise<void>;
  insertOrGetEvent(event: NormalizedCarrierTrackingEvent): Promise<StoredCarrierTrackingEvent>;
  findMatchCandidates(event: NormalizedCarrierTrackingEvent): Promise<CarrierTrackingMatchCandidate[]>;
  appendMatchAttempt(
    eventId: number,
    resolution: CarrierTrackingMatchResolution,
    shippingProviderLabelId: number | null,
    createdAt: Date,
  ): Promise<StoredCarrierTrackingMatch>;
  markEventReconciled(
    eventId: number,
    matchAttemptId: number,
    resolution: CarrierTrackingMatchResolution,
    reconciledAt: Date,
  ): Promise<void>;
  enqueueDispatchCommand(
    eventId: number,
    shippingProviderLabelId: number,
    dispatchOccurredAt: Date,
    createdAt: Date,
  ): Promise<StoredCarrierDispatchCommand>;
}

export interface CarrierTrackingRepository {
  persistVerifiedWebhookReceipt(
    receipt: VerifiedCarrierWebhookReceipt,
  ): Promise<StoredCarrierTrackingWebhookReceipt>;
  persistNormalizedWebhookEvent(
    receiptId: number,
    event: NormalizedCarrierTrackingEvent,
    input: {
      parserVersion: string;
      reasonCode: string;
      details?: Record<string, unknown>;
      createdAt: Date;
    },
  ): Promise<{
    event: StoredCarrierTrackingEvent;
    parse: StoredCarrierTrackingWebhookReceiptParse;
  }>;
  persistRejectedWebhookPayload(
    receiptId: number,
    input: {
      parserVersion: string;
      reasonCode: string;
      details: Record<string, unknown>;
      hydrationRequest?: ShipStationTrackingHydrationRequest;
      createdAt: Date;
    },
  ): Promise<StoredCarrierTrackingWebhookRejection>;
  claimWebhookHydrations(
    limit: number,
    asOf: Date,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<ClaimedCarrierTrackingWebhookHydration[]>;
  finalizeWebhookHydrationAttempt(
    input: FinalizeCarrierTrackingWebhookHydrationAttemptInput,
  ): Promise<StoredCarrierTrackingWebhookHydrationAttempt>;
  observeProviderLabel(
    observation: NormalizedShippingProviderLabelObservation,
  ): Promise<StoredShippingProviderLabelObservation>;
  reconcileProviderLabelLinks(
    provider: string,
    providerLabelId: string,
    reconciledAt: Date,
  ): Promise<ShippingProviderLabelLinkResult>;
  listProviderLabelsPendingLinkReconciliation(
    limit: number,
    asOf: Date,
  ): Promise<UnlinkedShippingProviderLabel[]>;
  prepareLabelTrackingPolls(
    limit: number,
    asOf: Date,
  ): Promise<CarrierTrackingLabelPollPreparationResult>;
  claimLabelTrackingPolls(
    limit: number,
    asOf: Date,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<ClaimedCarrierTrackingLabelPoll[]>;
  finalizeLabelTrackingPollAttempt(
    input: FinalizeCarrierTrackingLabelPollAttemptInput,
  ): Promise<StoredCarrierTrackingLabelPollAttempt>;
  prepareTrackingSubscriptions(
    limit: number,
    asOf: Date,
  ): Promise<CarrierTrackingSubscriptionPreparationResult>;
  claimTrackingSubscriptions(
    limit: number,
    asOf: Date,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<ClaimedCarrierTrackingSubscription[]>;
  finalizeTrackingSubscriptionAttempt(
    input: FinalizeCarrierTrackingSubscriptionAttemptInput,
  ): Promise<StoredCarrierTrackingSubscriptionAttempt>;
  requeueReviewedTrackingSubscriptions(
    input: RequeueReviewedTrackingSubscriptionsInput,
  ): Promise<RequeueReviewedTrackingSubscriptionsResult>;
  previewReviewedCarrierDispatchCommands(
    limit: number,
    cohort?: HistoricalCarrierDispatchRepairCohort | null,
  ): Promise<HistoricalCarrierDispatchRepairPreview>;
  requeueReviewedCarrierDispatchCommands(
    input: RequeueReviewedCarrierDispatchCommandsInput,
  ): Promise<RequeueReviewedCarrierDispatchCommandsResult>;
  listEventsPendingReconciliation(
    limit: number,
    asOf: Date,
  ): Promise<NormalizedCarrierTrackingEvent[]>;
  claimDispatchCommands(
    limit: number,
    asOf: Date,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<ClaimedCarrierDispatchCommand[]>;
  finalizeDispatchAttempt(
    input: FinalizeCarrierDispatchAttemptInput,
  ): Promise<StoredCarrierDispatchAttempt>;
  transaction<T>(work: (tx: CarrierTrackingTransaction) => Promise<T>): Promise<T>;
}

type QueryRows = { rows?: Record<string, unknown>[] };

function resultRows(result: unknown): Record<string, unknown>[] {
  if (result && typeof result === "object" && Array.isArray((result as QueryRows).rows)) {
    return (result as QueryRows).rows!;
  }
  return [];
}

function integerOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${field} returned by carrier tracking repository`);
  }
  return parsed;
}

function requiredId(value: unknown, field: string): number {
  const id = integerOrNull(value, field);
  if (id === null) throw new Error(`Missing ${field} returned by carrier tracking repository`);
  return id;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} returned by carrier tracking repository`);
  }
  return parsed;
}

function httpStatusOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 599) {
    throw new Error("Invalid http_status returned by carrier tracking repository");
  }
  return parsed;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredString(value: unknown, field: string): string {
  const parsed = stringOrNull(value);
  if (parsed === null) throw new Error(`Missing ${field} returned by carrier tracking repository`);
  return parsed;
}

function carrierDispatchAttemptOutcome(
  value: unknown,
): StoredCarrierDispatchAttempt["outcome"] {
  const outcome = requiredString(value, "carrier_dispatch_attempt_outcome");
  if (
    outcome !== "succeeded"
    && outcome !== "retry_scheduled"
    && outcome !== "review_required"
  ) {
    throw new Error("Invalid carrier_dispatch_attempt_outcome returned by carrier tracking repository");
  }
  return outcome;
}

function dateOrNull(value: unknown, field: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${field} returned by carrier tracking repository`);
  }
  return date;
}

function requiredDate(value: unknown, field: string): Date {
  const parsed = dateOrNull(value, field);
  if (parsed === null) throw new Error(`Missing ${field} returned by carrier tracking repository`);
  return parsed;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${field} returned by carrier tracking repository`);
  }
  return value as Record<string, unknown>;
}

const HISTORICAL_CARRIER_DISPATCH_REPAIR_COHORTS = [
  "aggregate_package_identity_conflict",
  "immutable_command_request_conflict",
  "package_resolution_retry",
  "legacy_outbound_shipment_identity_conflict",
] as const satisfies readonly HistoricalCarrierDispatchRepairCohort[];

function historicalCarrierDispatchRepairCohort(
  value: unknown,
): HistoricalCarrierDispatchRepairCohort {
  const cohort = requiredString(value, "carrier_dispatch_repair_cohort");
  if (!isStringEnumValue(HISTORICAL_CARRIER_DISPATCH_REPAIR_COHORTS, cohort)) {
    throw new Error("Invalid carrier_dispatch_repair_cohort returned by carrier tracking repository");
  }
  return cohort;
}

function historicalCarrierDispatchRepairCohortSql() {
  return sql`
    CASE
      WHEN command.last_error_code = 'PACKAGE_IDENTITY_CONFLICT'
        OR (
          command.last_error_code = 'CARRIER_DISPATCH_APPLICATION_FAILED'
          AND NULLIF(BTRIM(command.result_evidence ->> 'sourceCode'), '') =
            'PACKAGE_IDENTITY_CONFLICT'
        )
        THEN 'aggregate_package_identity_conflict'
      WHEN command.last_error_code = 'COMMAND_REQUEST_CONFLICT'
        OR (
          command.last_error_code = 'CARRIER_DISPATCH_APPLICATION_FAILED'
          AND NULLIF(BTRIM(command.result_evidence ->> 'sourceCode'), '') =
            'COMMAND_REQUEST_CONFLICT'
        )
        THEN 'immutable_command_request_conflict'
      WHEN command.last_error_code = 'CARRIER_DISPATCH_PACKAGE_NOT_RESOLVED'
        THEN 'package_resolution_retry'
      WHEN command.last_error_code = 'CARRIER_DISPATCH_APPLICATION_FAILED'
        AND NULLIF(BTRIM(command.result_evidence ->> 'sourceCode'), '') = '23505'
        AND NULLIF(BTRIM(command.result_evidence ->> 'sourceMessage'), '')
          ILIKE '%uq_outbound_shipments_active_%'
        THEN 'legacy_outbound_shipment_identity_conflict'
      ELSE NULL
    END
  `;
}

function historicalCarrierDispatchRepairEligibilitySql(
  cohort: HistoricalCarrierDispatchRepairCohort | null = null,
) {
  const repairCohort = historicalCarrierDispatchRepairCohortSql();
  return sql`
    command.status = 'review_required'
    AND label.provider = 'shipstation'
    AND label.label_status IN ('active', 'unknown')
    AND label.voided_at IS NULL
    AND event.dispatch_evidence = 'confirmed'
    AND EXISTS (
      SELECT 1
      FROM wms.shipping_provider_label_links AS link
      WHERE link.shipping_provider_label_id = label.id
    )
    AND ${repairCohort} IN (
      'aggregate_package_identity_conflict',
      'immutable_command_request_conflict',
      'legacy_outbound_shipment_identity_conflict'
    )
    AND (${cohort}::text IS NULL OR ${repairCohort} = ${cohort})
  `;
}

function historicalCarrierDispatchRepairCandidateFromRow(
  row: Record<string, unknown>,
): HistoricalCarrierDispatchRepairCandidate {
  return {
    commandId: requiredId(row.id, "carrier_dispatch_command_id"),
    shippingProviderLabelId: requiredId(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    providerLabelId: requiredString(row.provider_label_id, "provider_label_id"),
    providerOrderId: stringOrNull(row.provider_order_id),
    trackingSuffix: requiredString(row.tracking_suffix, "tracking_suffix"),
    repairCohort: historicalCarrierDispatchRepairCohort(row.repair_cohort),
    lastErrorCode: requiredString(row.last_error_code, "last_error_code"),
    lastErrorMessage: stringOrNull(row.last_error_message),
  };
}

function claimedDispatchCommandFromRow(
  row: Record<string, unknown>,
): ClaimedCarrierDispatchCommand {
  return {
    id: requiredId(row.id, "carrier_dispatch_command_id"),
    shippingProviderLabelId: requiredId(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    carrierTrackingEventId: requiredId(
      row.carrier_tracking_event_id,
      "carrier_tracking_event_id",
    ),
    provider: requiredString(row.provider, "provider"),
    providerLabelId: requiredString(row.provider_label_id, "provider_label_id"),
    providerOrderId: stringOrNull(row.provider_order_id),
    providerOrderKey: stringOrNull(row.provider_order_key),
    trackingNumber: requiredString(row.tracking_number, "tracking_number"),
    normalizedTrackingNumber: requiredString(
      row.normalized_tracking_number,
      "normalized_tracking_number",
    ),
    carrier: stringOrNull(row.carrier),
    serviceCode: stringOrNull(row.service_code),
    dispatchOccurredAt: requiredDate(
      row.dispatch_occurred_at,
      "dispatch_occurred_at",
    ),
    attemptNumber: nonNegativeInteger(row.attempt_number, "attempt_number"),
    consecutiveFailureCount: nonNegativeInteger(
      row.consecutive_failure_count,
      "consecutive_failure_count",
    ),
    startedAt: requiredDate(row.started_at, "started_at"),
    leaseOwner: requiredString(row.lease_owner, "lease_owner"),
    leaseExpiresAt: requiredDate(row.lease_expires_at, "lease_expires_at"),
  };
}

const CANONICAL_CARRIER_TRACKING_STATUSES = [
  "unknown",
  "pre_transit",
  "accepted",
  "in_transit",
  "delivered",
  "exception",
  "delivery_attempt",
  "delivered_to_service_point",
] as const satisfies readonly CanonicalCarrierTrackingStatus[];

const CARRIER_DISPATCH_EVIDENCE_VALUES = [
  "confirmed",
  "not_confirmed",
  "review",
] as const satisfies readonly CarrierDispatchEvidence[];

const CARRIER_TRACKING_EVENT_TIME_SOURCES = [
  "carrier_event",
  "actual_delivery",
  "ship_date",
  "unavailable",
] as const;

function isStringEnumValue<TValue extends string>(
  values: readonly TValue[],
  value: string,
): value is TValue {
  return values.some((candidate) => candidate === value);
}

function normalizedEventFromRow(row: Record<string, unknown>): NormalizedCarrierTrackingEvent {
  const providerStatusCode = requiredString(row.provider_status_code, "provider_status_code");
  if (!isStringEnumValue(SHIPSTATION_TRACKING_STATUS_CODES, providerStatusCode)) {
    throw new Error("Invalid provider_status_code returned by carrier tracking repository");
  }
  const canonicalStatus = requiredString(row.canonical_status, "canonical_status");
  if (!isStringEnumValue(CANONICAL_CARRIER_TRACKING_STATUSES, canonicalStatus)) {
    throw new Error("Invalid canonical_status returned by carrier tracking repository");
  }
  const dispatchEvidence = requiredString(row.dispatch_evidence, "dispatch_evidence");
  if (!isStringEnumValue(CARRIER_DISPATCH_EVIDENCE_VALUES, dispatchEvidence)) {
    throw new Error("Invalid dispatch_evidence returned by carrier tracking repository");
  }
  const eventTimeSource = requiredString(row.event_time_source, "event_time_source");
  if (!isStringEnumValue(CARRIER_TRACKING_EVENT_TIME_SOURCES, eventTimeSource)) {
    throw new Error("Invalid event_time_source returned by carrier tracking repository");
  }
  const provider = requiredString(row.provider, "provider");
  if (provider !== "shipstation") {
    throw new Error(`Unsupported carrier tracking provider returned by repository: ${provider}`);
  }
  return {
    provider,
    eventHash: requiredString(row.event_hash, "event_hash"),
    payloadHash: requiredString(row.payload_hash, "payload_hash"),
    trackingNumber: requiredString(row.tracking_number, "tracking_number"),
    normalizedTrackingNumber: requiredString(row.normalized_tracking_number, "normalized_tracking_number"),
    providerLabelId: stringOrNull(row.provider_label_id),
    carrier: stringOrNull(row.carrier),
    providerStatusCode: providerStatusCode as NormalizedCarrierTrackingEvent["providerStatusCode"],
    providerStatusDetailCode: stringOrNull(row.provider_status_detail_code),
    providerCarrierStatusCode: stringOrNull(row.provider_carrier_status_code),
    providerCarrierDetailCode: stringOrNull(row.provider_carrier_detail_code),
    canonicalStatus: canonicalStatus as CanonicalCarrierTrackingStatus,
    dispatchEvidence: dispatchEvidence as CarrierDispatchEvidence,
    statusDescription: stringOrNull(row.status_description),
    carrierStatusDescription: stringOrNull(row.carrier_status_description),
    eventOccurredAt: dateOrNull(row.event_occurred_at, "event_occurred_at"),
    eventTimeSource: eventTimeSource as NormalizedCarrierTrackingEvent["eventTimeSource"],
    estimatedDeliveryAt: dateOrNull(row.estimated_delivery_at, "estimated_delivery_at"),
    actualDeliveryAt: dateOrNull(row.actual_delivery_at, "actual_delivery_at"),
    sanitizedPayload: requiredRecord(row.sanitized_payload, "sanitized_payload"),
    receivedAt: requiredDate(row.received_at, "received_at"),
  };
}

function labelStatus(value: unknown): CarrierTrackingMatchCandidate["labelStatus"] {
  if (value === "active" || value === "voided" || value === "superseded" || value === "unknown") {
    return value;
  }
  return "unknown";
}
function labelDirection(value: unknown): ShippingProviderLabelDirection {
  if (value === "outbound" || value === "return") return value;
  throw new Error("Invalid label_direction returned by carrier tracking repository");
}


function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} returned by carrier tracking repository`);
  }
  return parsed;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const parsed = stringOrNull(entry);
    return parsed ? [parsed] : [];
  }))].sort();
}

function candidateFromRow(row: Record<string, unknown>): CarrierTrackingMatchCandidate {
  return {
    shippingProviderLabelId: requiredId(row.shipping_provider_label_id, "shipping_provider_label_id"),
    providerLabelId: requiredString(row.provider_label_id, "provider_label_id"),
    labelStatus: labelStatus(row.label_status),
    linkCount: nonNegativeInteger(row.link_count, "link_count"),
    labelDirection: labelDirection(row.label_direction),
    orderNumbers: stringArray(row.order_numbers),
    carrier: stringOrNull(row.carrier),
    serviceCode: stringOrNull(row.service_code),
  };
}

function claimedTrackingSubscriptionFromRow(
  row: Record<string, unknown>,
): ClaimedCarrierTrackingSubscription {
  return {
    id: requiredId(row.id, "carrier_tracking_subscription_id"),
    trackingProvider: requiredString(row.tracking_provider, "tracking_provider"),
    carrierCode: requiredString(row.carrier_code, "carrier_code"),
    trackingNumber: requiredString(row.tracking_number, "tracking_number"),
    normalizedTrackingNumber: requiredString(
      row.normalized_tracking_number,
      "normalized_tracking_number",
    ),
    attemptNumber: requiredId(row.attempt_count, "attempt_count"),
    consecutiveFailureCount: nonNegativeInteger(
      row.consecutive_failure_count,
      "consecutive_failure_count",
    ),
    startedAt: requiredDate(row.last_attempt_at, "last_attempt_at"),
    leaseOwner: requiredString(row.lease_owner, "lease_owner"),
    leaseExpiresAt: requiredDate(row.lease_expires_at, "lease_expires_at"),
  };
}

function claimedWebhookHydrationFromRow(
  row: Record<string, unknown>,
): ClaimedCarrierTrackingWebhookHydration {
  return {
    receiptId: requiredId(
      row.carrier_tracking_webhook_receipt_id,
      "carrier_tracking_webhook_receipt_id",
    ),
    resourceUrl: requiredString(row.resource_url, "resource_url"),
    carrierCode: requiredString(row.carrier_code, "carrier_code"),
    trackingNumber: requiredString(row.tracking_number, "tracking_number"),
    normalizedTrackingNumber: requiredString(
      row.normalized_tracking_number,
      "normalized_tracking_number",
    ),
    attemptNumber: requiredId(row.attempt_count, "attempt_count"),
    consecutiveFailureCount: nonNegativeInteger(
      row.consecutive_failure_count,
      "consecutive_failure_count",
    ),
    webhookVerifiedAt: requiredDate(row.webhook_verified_at, "webhook_verified_at"),
    startedAt: requiredDate(row.last_attempt_at, "last_attempt_at"),
    leaseOwner: requiredString(row.lease_owner, "lease_owner"),
    leaseExpiresAt: requiredDate(row.lease_expires_at, "lease_expires_at"),
  };
}

function candidateEvidence(candidate: CarrierTrackingMatchCandidate): Record<string, unknown> {
  return {
    shippingProviderLabelId: candidate.shippingProviderLabelId,
    providerLabelId: candidate.providerLabelId,
    labelStatus: candidate.labelStatus,
    linkCount: candidate.linkCount,
    labelDirection: candidate.labelDirection,
    orderNumbers: candidate.orderNumbers,
  };
}

async function insertOrGetCarrierTrackingEvent(
  databaseTx: any,
  event: NormalizedCarrierTrackingEvent,
): Promise<StoredCarrierTrackingEvent> {
  const inserted = await databaseTx
    .insert(carrierTrackingEvents)
    .values({
      provider: event.provider,
      eventHash: event.eventHash,
      payloadHash: event.payloadHash,
      trackingNumber: event.trackingNumber,
      normalizedTrackingNumber: event.normalizedTrackingNumber,
      providerLabelId: event.providerLabelId,
      carrier: event.carrier,
      providerStatusCode: event.providerStatusCode,
      providerStatusDetailCode: event.providerStatusDetailCode,
      providerCarrierStatusCode: event.providerCarrierStatusCode,
      providerCarrierDetailCode: event.providerCarrierDetailCode,
      canonicalStatus: event.canonicalStatus,
      dispatchEvidence: event.dispatchEvidence,
      statusDescription: event.statusDescription,
      carrierStatusDescription: event.carrierStatusDescription,
      eventOccurredAt: event.eventOccurredAt,
      eventTimeSource: event.eventTimeSource,
      estimatedDeliveryAt: event.estimatedDeliveryAt,
      actualDeliveryAt: event.actualDeliveryAt,
      sanitizedPayload: event.sanitizedPayload,
      receivedAt: event.receivedAt,
    })
    .onConflictDoNothing({
      target: [carrierTrackingEvents.provider, carrierTrackingEvents.eventHash],
    })
    .returning({ id: carrierTrackingEvents.id });
  if (inserted[0]) return { id: inserted[0].id, inserted: true };

  const existing = await databaseTx
    .select({ id: carrierTrackingEvents.id })
    .from(carrierTrackingEvents)
    .where(and(
      eq(carrierTrackingEvents.provider, event.provider),
      eq(carrierTrackingEvents.eventHash, event.eventHash),
    ))
    .limit(1);
  if (!existing[0]) {
    throw new Error("Carrier tracking event conflict could not be re-read");
  }
  return { id: existing[0].id, inserted: false };
}

async function insertOrGetCarrierTrackingWebhookReceipt(
  databaseTx: any,
  receipt: VerifiedCarrierWebhookReceipt,
): Promise<StoredCarrierTrackingWebhookReceipt> {
  const inserted = await databaseTx
    .insert(carrierTrackingWebhookReceipts)
    .values({
      provider: receipt.provider,
      receiptHash: receipt.receiptHash,
      signatureAlgorithm: receipt.signatureAlgorithm,
      signatureKeyId: receipt.signatureKeyId,
      signatureTimestampRaw: receipt.signatureTimestampRaw,
      signatureTimestampAt: receipt.signatureTimestampAt,
      rawBodyBase64: receipt.rawBodyBase64,
      rawBodyHash: receipt.rawBodyHash,
      signatureBase64: receipt.signatureBase64,
      signatureHash: receipt.signatureHash,
      verifiedAt: receipt.verifiedAt,
    })
    .onConflictDoNothing({
      target: [
        carrierTrackingWebhookReceipts.provider,
        carrierTrackingWebhookReceipts.receiptHash,
      ],
    })
    .returning({ id: carrierTrackingWebhookReceipts.id });
  if (inserted[0]) return { id: inserted[0].id, inserted: true };

  const existing = await databaseTx
    .select({ id: carrierTrackingWebhookReceipts.id })
    .from(carrierTrackingWebhookReceipts)
    .where(and(
      eq(carrierTrackingWebhookReceipts.provider, receipt.provider),
      eq(carrierTrackingWebhookReceipts.receiptHash, receipt.receiptHash),
    ))
    .limit(1);
  if (!existing[0]) {
    throw new Error("Carrier tracking webhook receipt conflict could not be re-read");
  }
  return { id: existing[0].id, inserted: false };
}

async function insertOrGetCarrierTrackingWebhookReceiptParse(
  databaseTx: any,
  input: {
    receiptId: number;
    eventId: number | null;
    eventHash: string | null;
    parserVersion: string;
    outcome: "normalized" | "rejected";
    reasonCode: string;
    details: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<StoredCarrierTrackingWebhookReceiptParse> {
  const attemptHash = carrierTrackingReceiptParseAttemptHash({
    parserVersion: input.parserVersion,
    outcome: input.outcome,
    eventHash: input.eventHash,
    reasonCode: input.reasonCode,
  });
  const inserted = await databaseTx
    .insert(carrierTrackingWebhookReceiptParses)
    .values({
      carrierTrackingWebhookReceiptId: input.receiptId,
      carrierTrackingEventId: input.eventId,
      attemptHash,
      parserVersion: input.parserVersion,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      details: input.details,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        carrierTrackingWebhookReceiptParses.carrierTrackingWebhookReceiptId,
        carrierTrackingWebhookReceiptParses.attemptHash,
      ],
    })
    .returning({ id: carrierTrackingWebhookReceiptParses.id });
  if (inserted[0]) return { id: inserted[0].id, inserted: true };

  const existing = await databaseTx
    .select({
      id: carrierTrackingWebhookReceiptParses.id,
      carrierTrackingEventId: carrierTrackingWebhookReceiptParses.carrierTrackingEventId,
      outcome: carrierTrackingWebhookReceiptParses.outcome,
    })
    .from(carrierTrackingWebhookReceiptParses)
    .where(and(
      eq(carrierTrackingWebhookReceiptParses.carrierTrackingWebhookReceiptId, input.receiptId),
      eq(carrierTrackingWebhookReceiptParses.attemptHash, attemptHash),
    ))
    .limit(1);
  if (!existing[0]) {
    throw new Error("Carrier tracking webhook receipt parse conflict could not be re-read");
  }
  if (existing[0].carrierTrackingEventId !== input.eventId || existing[0].outcome !== input.outcome) {
    throw new Error("Carrier tracking webhook receipt parse identity conflict");
  }
  return { id: existing[0].id, inserted: false };
}

export function createDrizzleCarrierTrackingRepository(db: any): CarrierTrackingRepository {
  return {
    async persistVerifiedWebhookReceipt(receipt) {
      return db.transaction(async (databaseTx: any) => (
        insertOrGetCarrierTrackingWebhookReceipt(databaseTx, receipt)
      ));
    },

    async persistNormalizedWebhookEvent(receiptId, event, input) {
      return db.transaction(async (databaseTx: any) => {
        const lockKey = `carrier_tracking:${event.provider}:${event.normalizedTrackingNumber}`;
        await databaseTx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
        `);
        const storedEvent = await insertOrGetCarrierTrackingEvent(databaseTx, event);
        const storedParse = await insertOrGetCarrierTrackingWebhookReceiptParse(
          databaseTx,
          {
            receiptId,
            eventId: storedEvent.id,
            eventHash: event.eventHash,
            parserVersion: input.parserVersion,
            outcome: "normalized",
            reasonCode: input.reasonCode,
            details: {
              ...(input.details ?? {}),
              eventHash: event.eventHash,
              payloadHash: event.payloadHash,
            },
            createdAt: input.createdAt,
          },
        );
        return { event: storedEvent, parse: storedParse };
      });
    },

    async persistRejectedWebhookPayload(receiptId, input) {
      return db.transaction(async (databaseTx: any) => {
        const storedParse = await insertOrGetCarrierTrackingWebhookReceiptParse(databaseTx, {
          receiptId,
          eventId: null,
          eventHash: null,
          parserVersion: input.parserVersion,
          outcome: "rejected",
          reasonCode: input.reasonCode,
          details: input.details,
          createdAt: input.createdAt,
        });
        let hydrationPrepared = false;
        if (input.hydrationRequest) {
          const [insertedHydration] = await databaseTx
            .insert(carrierTrackingWebhookHydrations)
            .values({
              carrierTrackingWebhookReceiptId: receiptId,
              resourceUrl: input.hydrationRequest.resourceUrl,
              carrierCode: input.hydrationRequest.carrierCode,
              trackingNumber: input.hydrationRequest.trackingNumber,
              normalizedTrackingNumber: input.hydrationRequest.normalizedTrackingNumber,
              hydrationStatus: "pending",
              attemptCount: 0,
              consecutiveFailureCount: 0,
              nextAttemptAt: input.createdAt,
              metadata: { shadowOnly: true, source: "authenticated_webhook_resource_url" },
              createdAt: input.createdAt,
              updatedAt: input.createdAt,
            })
            .onConflictDoNothing({
              target: carrierTrackingWebhookHydrations.carrierTrackingWebhookReceiptId,
            })
            .returning({
              receiptId: carrierTrackingWebhookHydrations.carrierTrackingWebhookReceiptId,
            });
          hydrationPrepared = Boolean(insertedHydration);

          if (!insertedHydration) {
            const existing = await databaseTx
              .select({
                resourceUrl: carrierTrackingWebhookHydrations.resourceUrl,
                carrierCode: carrierTrackingWebhookHydrations.carrierCode,
                normalizedTrackingNumber:
                  carrierTrackingWebhookHydrations.normalizedTrackingNumber,
              })
              .from(carrierTrackingWebhookHydrations)
              .where(eq(
                carrierTrackingWebhookHydrations.carrierTrackingWebhookReceiptId,
                receiptId,
              ))
              .limit(1);
            if (!existing[0]
                || existing[0].resourceUrl !== input.hydrationRequest.resourceUrl
                || existing[0].carrierCode !== input.hydrationRequest.carrierCode
                || existing[0].normalizedTrackingNumber
                  !== input.hydrationRequest.normalizedTrackingNumber) {
              throw new Error("Carrier tracking webhook hydration identity conflict");
            }
            hydrationPrepared = true;
          }
        }
        return { ...storedParse, hydrationPrepared };
      });
    },

    async claimWebhookHydrations(limit, asOf, leaseOwner, leaseExpiresAt) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
        throw new Error("Tracking hydration claim limit must be an integer between 1 and 100");
      }
      if (Number.isNaN(asOf.getTime()) || Number.isNaN(leaseExpiresAt.getTime())) {
        throw new Error("Tracking hydration claim timestamps must be valid");
      }
      if (leaseExpiresAt.getTime() <= asOf.getTime()) {
        throw new Error("Tracking hydration lease must expire after asOf");
      }
      const normalizedLeaseOwner = leaseOwner.trim();
      if (!normalizedLeaseOwner || normalizedLeaseOwner.length > 200) {
        throw new Error("Tracking hydration leaseOwner must contain 1 through 200 characters");
      }

      const result = await db.execute(sql`
        WITH due AS (
          SELECT
            hydration.carrier_tracking_webhook_receipt_id,
            receipt.verified_at AS webhook_verified_at
          FROM wms.carrier_tracking_webhook_hydrations AS hydration
          JOIN wms.carrier_tracking_webhook_receipts AS receipt
            ON receipt.id = hydration.carrier_tracking_webhook_receipt_id
          WHERE (
            hydration.hydration_status IN ('pending', 'retry')
            AND hydration.next_attempt_at <= ${asOf}
          ) OR (
            hydration.hydration_status = 'processing'
            AND hydration.lease_expires_at <= ${asOf}
          )
          ORDER BY
            CASE WHEN hydration.hydration_status = 'processing' THEN 0 ELSE 1 END,
            COALESCE(hydration.lease_expires_at, hydration.next_attempt_at),
            hydration.carrier_tracking_webhook_receipt_id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE wms.carrier_tracking_webhook_hydrations AS hydration
        SET
          hydration_status = 'processing',
          attempt_count = CASE
            WHEN hydration.hydration_status = 'processing'
              THEN GREATEST(hydration.attempt_count, 1)
            ELSE hydration.attempt_count + 1
          END,
          next_attempt_at = NULL,
          last_attempt_at = ${asOf},
          lease_owner = ${normalizedLeaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          updated_at = ${asOf}
        FROM due
        WHERE hydration.carrier_tracking_webhook_receipt_id
          = due.carrier_tracking_webhook_receipt_id
        RETURNING
          hydration.carrier_tracking_webhook_receipt_id,
          hydration.resource_url,
          hydration.carrier_code,
          hydration.tracking_number,
          hydration.normalized_tracking_number,
          hydration.attempt_count,
          hydration.consecutive_failure_count,
          due.webhook_verified_at,
          hydration.last_attempt_at,
          hydration.lease_owner,
          hydration.lease_expires_at
      `);
      return resultRows(result).map(claimedWebhookHydrationFromRow);
    },

    async finalizeWebhookHydrationAttempt(input) {
      if (Number.isNaN(input.startedAt.getTime())
          || Number.isNaN(input.completedAt.getTime())
          || (input.nextAttemptAt && Number.isNaN(input.nextAttemptAt.getTime()))) {
        throw new Error("Tracking hydration finalization timestamps must be valid");
      }
      if (input.completedAt.getTime() < input.startedAt.getTime()) {
        throw new Error("Tracking hydration attempt cannot complete before it starts");
      }
      if (input.outcome === "retry_scheduled" && !input.nextAttemptAt) {
        throw new Error("Retryable tracking hydration attempts require nextAttemptAt");
      }
      if (input.outcome !== "retry_scheduled" && input.nextAttemptAt) {
        throw new Error("Only retryable tracking hydration attempts may set nextAttemptAt");
      }
      if ((input.outcome === "hydrated") !== (input.event !== null)) {
        throw new Error("Successful tracking hydration requires exactly one normalized event");
      }

      return db.transaction(async (databaseTx: any) => {
        const existing = await databaseTx
          .select({ id: carrierTrackingWebhookHydrationAttempts.id })
          .from(carrierTrackingWebhookHydrationAttempts)
          .where(and(
            eq(
              carrierTrackingWebhookHydrationAttempts.carrierTrackingWebhookReceiptId,
              input.receiptId,
            ),
            eq(carrierTrackingWebhookHydrationAttempts.attemptNumber, input.attemptNumber),
          ))
          .limit(1);
        if (existing[0]) {
          return {
            id: existing[0].id,
            inserted: false,
            eventId: null,
            eventInserted: false,
            parseAttemptId: null,
            parseAttemptInserted: false,
          };
        }

        const stateResult = await databaseTx.execute(sql`
          SELECT hydration_status, attempt_count, lease_owner
          FROM wms.carrier_tracking_webhook_hydrations
          WHERE carrier_tracking_webhook_receipt_id = ${input.receiptId}
          FOR UPDATE
        `);
        const state = resultRows(stateResult)[0];
        if (!state) throw new Error("Tracking webhook hydration no longer exists");
        if (state.hydration_status !== "processing"
            || state.lease_owner !== input.leaseOwner
            || Number(state.attempt_count) !== input.attemptNumber) {
          throw new Error("Tracking webhook hydration lease was lost before finalization");
        }

        let storedEvent: StoredCarrierTrackingEvent | null = null;
        let storedParse: StoredCarrierTrackingWebhookReceiptParse | null = null;
        if (input.event) {
          const lockKey = `carrier_tracking:${input.event.provider}:${input.event.normalizedTrackingNumber}`;
          await databaseTx.execute(sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
          `);
          storedEvent = await insertOrGetCarrierTrackingEvent(databaseTx, input.event);
          storedParse = await insertOrGetCarrierTrackingWebhookReceiptParse(databaseTx, {
            receiptId: input.receiptId,
            eventId: storedEvent.id,
            eventHash: input.event.eventHash,
            parserVersion: input.parserVersion,
            outcome: "normalized",
            reasonCode: input.parseReasonCode,
            details: {
              eventHash: input.event.eventHash,
              payloadHash: input.event.payloadHash,
              source: "resource_url_hydration",
            },
            createdAt: input.completedAt,
          });
        }

        const [attempt] = await databaseTx
          .insert(carrierTrackingWebhookHydrationAttempts)
          .values({
            carrierTrackingWebhookReceiptId: input.receiptId,
            attemptNumber: input.attemptNumber,
            attemptOutcome: input.outcome,
            httpStatus: input.httpStatus,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            requestEvidence: input.requestEvidence,
            responseEvidence: input.responseEvidence,
            startedAt: input.startedAt,
            completedAt: input.completedAt,
            createdAt: input.completedAt,
          })
          .returning({ id: carrierTrackingWebhookHydrationAttempts.id });
        const attemptId = requiredId(
          attempt?.id,
          "carrier_tracking_webhook_hydration_attempt_id",
        );
        const hydrationStatus = input.outcome === "hydrated"
          ? "complete"
          : input.outcome === "retry_scheduled"
            ? "retry"
            : "review";

        await databaseTx
          .update(carrierTrackingWebhookHydrations)
          .set({
            hydrationStatus,
            consecutiveFailureCount: input.outcome === "hydrated"
              ? 0
              : sql`${carrierTrackingWebhookHydrations.consecutiveFailureCount} + 1`,
            nextAttemptAt: input.nextAttemptAt,
            hydratedAt: input.outcome === "hydrated" ? input.completedAt : null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: input.errorCode,
            lastErrorMessage: input.errorMessage,
            updatedAt: input.completedAt,
          })
          .where(eq(
            carrierTrackingWebhookHydrations.carrierTrackingWebhookReceiptId,
            input.receiptId,
          ));

        return {
          id: attemptId,
          inserted: true,
          eventId: storedEvent?.id ?? null,
          eventInserted: storedEvent?.inserted ?? false,
          parseAttemptId: storedParse?.id ?? null,
          parseAttemptInserted: storedParse?.inserted ?? false,
        };
      });
    },

    async observeProviderLabel(observation) {
      return db.transaction(async (databaseTx: any) => {
        const trackingLockKey = `carrier_tracking:${observation.provider}:${observation.normalizedTrackingNumber}`;
        await databaseTx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${trackingLockKey}, 0))
        `);
        const lockKey = `shipping_provider_label:${observation.provider}:${observation.providerLabelId}`;
        await databaseTx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
        `);

        const existing = await databaseTx
          .select({
            id: shippingProviderLabels.id,
            normalizedTrackingNumber: shippingProviderLabels.normalizedTrackingNumber,
            labelStatus: shippingProviderLabels.labelStatus,
            labelDirection: shippingProviderLabels.labelDirection,
            providerOrderId: shippingProviderLabels.providerOrderId,
            providerOrderKey: shippingProviderLabels.providerOrderKey,
            carrier: shippingProviderLabels.carrier,
            serviceCode: shippingProviderLabels.serviceCode,
            labelCreatedAt: shippingProviderLabels.labelCreatedAt,
            voidedAt: shippingProviderLabels.voidedAt,
          })
          .from(shippingProviderLabels)
          .where(and(
            eq(shippingProviderLabels.provider, observation.provider),
            eq(shippingProviderLabels.providerLabelId, observation.providerLabelId),
          ))
          .limit(1);

        let shippingProviderLabelId: number;
        let labelInserted = false;
        let effectiveLabelDirection = observation.labelDirection;
        if (existing[0]) {
          assertStableShippingProviderLabelIdentity(existing[0], observation);
          effectiveLabelDirection = existing[0].labelDirection === "return"
            ? "return"
            : observation.labelDirection;
          const [updated] = await databaseTx
            .update(shippingProviderLabels)
            .set({
              providerOrderId: observation.providerOrderId ?? existing[0].providerOrderId,
              providerOrderKey: observation.providerOrderKey ?? existing[0].providerOrderKey,
              trackingNumber: observation.trackingNumber,
              labelStatus: existing[0].labelStatus === "voided"
                || existing[0].labelStatus === "superseded"
                ? existing[0].labelStatus
                : observation.labelStatus,
              labelDirection: effectiveLabelDirection,
              carrier: observation.carrier ?? existing[0].carrier,
              serviceCode: observation.serviceCode ?? existing[0].serviceCode,
              labelCreatedAt: observation.labelCreatedAt ?? existing[0].labelCreatedAt,
              voidedAt: observation.voidedAt ?? existing[0].voidedAt,
              lastObservedAt: observation.observedAt,
              metadata: {
                authorityMode: "carrier_dispatch_cutover",
                labelDirection: effectiveLabelDirection,
              },
              updatedAt: observation.observedAt,
            })
            .where(eq(shippingProviderLabels.id, existing[0].id))
            .returning({ id: shippingProviderLabels.id });
          shippingProviderLabelId = requiredId(updated?.id, "shipping_provider_label_id");
        } else {
          const [inserted] = await databaseTx
            .insert(shippingProviderLabels)
            .values({
              provider: observation.provider,
              providerLabelId: observation.providerLabelId,
              providerOrderId: observation.providerOrderId,
              providerOrderKey: observation.providerOrderKey,
              trackingNumber: observation.trackingNumber,
              normalizedTrackingNumber: observation.normalizedTrackingNumber,
              labelStatus: observation.labelStatus,
              labelDirection: effectiveLabelDirection,
              carrier: observation.carrier,
              serviceCode: observation.serviceCode,
              labelCreatedAt: observation.labelCreatedAt,
              voidedAt: observation.voidedAt,
              firstObservedAt: observation.observedAt,
              lastObservedAt: observation.observedAt,
              source: "shipstation_shipment_observation",
              metadata: {
                authorityMode: "carrier_dispatch_cutover",
                labelDirection: effectiveLabelDirection,
              },
              createdAt: observation.observedAt,
              updatedAt: observation.observedAt,
            })
            .returning({ id: shippingProviderLabels.id });
          shippingProviderLabelId = requiredId(inserted?.id, "shipping_provider_label_id");
          labelInserted = true;
        }

        const eventRows = await databaseTx
          .insert(shippingProviderLabelEvents)
          .values({
            shippingProviderLabelId,
            eventHash: observation.eventHash,
            eventType: observation.eventType,
            labelStatus: observation.labelStatus,
            trackingNumber: observation.trackingNumber,
            providerOccurredAt: observation.providerOccurredAt,
            sanitizedPayload: observation.sanitizedPayload,
            receivedAt: observation.observedAt,
          })
          .onConflictDoNothing({
            target: [
              shippingProviderLabelEvents.shippingProviderLabelId,
              shippingProviderLabelEvents.eventHash,
            ],
          })
          .returning({ id: shippingProviderLabelEvents.id });

        if (effectiveLabelDirection === "return") {
          // Provider-label links are immutable provenance. Return direction is
          // the authority boundary; preserving the links keeps the package and
          // item lineage available for a future inspected-return workflow.
          await databaseTx.execute(sql`
            UPDATE wms.carrier_dispatch_commands
            SET status = 'review_required',
                next_attempt_at = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                succeeded_at = NULL,
                last_error_code = 'RETURN_LABEL_NOT_OUTBOUND',
                last_error_message = 'Provider confirmed this label is return transport and cannot authorize outbound fulfillment',
                result_evidence = COALESCE(result_evidence, '{}'::jsonb)
                  || jsonb_build_object(
                    'returnLabelQuarantine',
                    jsonb_build_object(
                      'provider', ${observation.provider}::text,
                      'providerLabelId', ${observation.providerLabelId}::text,
                      'observedAt', ${observation.observedAt}::timestamptz
                    )
                  ),
                updated_at = ${observation.observedAt}
            WHERE shipping_provider_label_id = ${shippingProviderLabelId}
              AND status IN ('pending', 'processing', 'retry_scheduled')
          `);
        }

        return {
          shippingProviderLabelId,
          labelInserted,
          eventInserted: Boolean(eventRows[0]),
        };
      });
    },

    async reconcileProviderLabelLinks(provider, providerLabelId, reconciledAt) {
      const normalizedProvider = provider.trim().toLowerCase();
      const normalizedProviderLabelId = providerLabelId.trim();
      if (!normalizedProvider || !normalizedProviderLabelId) {
        throw new Error("provider and providerLabelId are required for label-link reconciliation");
      }
      if (Number.isNaN(reconciledAt.getTime())) {
        throw new Error("reconciledAt must be a valid timestamp");
      }

      return db.transaction(async (databaseTx: any) => {
        const lockKey = `shipping_provider_label:${normalizedProvider}:${normalizedProviderLabelId}`;
        await databaseTx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
        `);
        const labelResult = await databaseTx.execute(sql`
          SELECT id, label_direction
          FROM wms.shipping_provider_labels
          WHERE provider = ${normalizedProvider}
            AND provider_label_id = ${normalizedProviderLabelId}
          LIMIT 1
        `);
        const labelRow = resultRows(labelResult)[0];
        const shippingProviderLabelId = requiredId(
          labelRow?.id,
          "shipping_provider_label_id",
        );
        const currentLabelDirection = labelDirection(labelRow?.label_direction);


        const insertedResult = await databaseTx.execute(sql`
          WITH label AS (
            SELECT *
            FROM wms.shipping_provider_labels
            WHERE id = ${shippingProviderLabelId}
          ),
          physical_targets AS (
            SELECT DISTINCT
              label.id AS shipping_provider_label_id,
              NULL::bigint AS shipment_request_id,
              NULL::bigint AS shipping_engine_order_id,
              physical.id AS physical_shipment_id,
              NULL::integer AS legacy_wms_shipment_id,
              'provider_physical_identity'::text AS source
            FROM label
            JOIN wms.physical_shipments AS physical
              ON physical.provider = label.provider
             AND physical.provider_physical_shipment_id IN (
               label.provider_label_id,
               label.provider || '_shipment:' || label.provider_label_id,
               CASE
                 WHEN label.provider = 'shipstation'
                 THEN 'shipstation_shipment:' || label.provider_label_id
                 ELSE label.provider_label_id
               END
             )
          ),
          legacy_targets AS (
            SELECT DISTINCT
              label.id AS shipping_provider_label_id,
              NULL::bigint AS shipment_request_id,
              NULL::bigint AS shipping_engine_order_id,
              NULL::bigint AS physical_shipment_id,
              legacy.id AS legacy_wms_shipment_id,
              'legacy_provider_physical_identity'::text AS source
            FROM label
            JOIN wms.outbound_shipments AS legacy
              ON legacy.external_fulfillment_id IN (
                label.provider_label_id,
                label.provider || '_shipment:' || label.provider_label_id,
                CASE
                  WHEN label.provider = 'shipstation'
                  THEN 'shipstation_shipment:' || label.provider_label_id
                  ELSE label.provider_label_id
                END
              )
              OR legacy.id = CASE
                WHEN label.provider_order_key ~ '^echelon-wms-shp-[1-9][0-9]*$'
                THEN substring(label.provider_order_key FROM '([1-9][0-9]*)$')::integer
                ELSE NULL
              END
          ),
          provider_item_targets AS (
            SELECT DISTINCT
              label.id AS shipping_provider_label_id,
              NULL::bigint AS shipment_request_id,
              NULL::bigint AS shipping_engine_order_id,
              NULL::bigint AS physical_shipment_id,
              source_item.shipment_id AS legacy_wms_shipment_id,
              'provider_line_item_identity'::text AS source
            FROM label
            JOIN wms.shipping_provider_label_events AS event
              ON event.shipping_provider_label_id = label.id
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(event.sanitized_payload->'shipmentItems') = 'array'
                THEN event.sanitized_payload->'shipmentItems'
                ELSE '[]'::jsonb
              END
            ) AS provider_item
            JOIN wms.outbound_shipment_items AS source_item
              ON source_item.id = CASE
                WHEN provider_item->>'lineItemKey' ~ '^wms-item-[1-9][0-9]*$'
                THEN substring(provider_item->>'lineItemKey' FROM '^wms-item-([1-9][0-9]*)$')::integer
                ELSE NULL
              END
          ),
          request_targets AS (
            SELECT DISTINCT
              label.id AS shipping_provider_label_id,
              request.id AS shipment_request_id,
              NULL::bigint AS shipping_engine_order_id,
              NULL::bigint AS physical_shipment_id,
              NULL::integer AS legacy_wms_shipment_id,
              'canonical_request_identity'::text AS source
            FROM label
            JOIN wms.shipment_requests AS request
              ON request.legacy_wms_shipment_id IN (
                SELECT legacy_wms_shipment_id FROM legacy_targets
                UNION
                SELECT legacy_wms_shipment_id FROM provider_item_targets
              )
              OR request.id IN (
                SELECT physical.shipment_request_id
                FROM wms.physical_shipments AS physical
                WHERE physical.id IN (
                  SELECT physical_shipment_id FROM physical_targets
                )
              )
          ),
          engine_targets AS (
            SELECT DISTINCT
              label.id AS shipping_provider_label_id,
              NULL::bigint AS shipment_request_id,
              engine.id AS shipping_engine_order_id,
              NULL::bigint AS physical_shipment_id,
              NULL::integer AS legacy_wms_shipment_id,
              'provider_order_identity'::text AS source
            FROM label
            JOIN wms.shipping_engine_orders AS engine
             ON engine.provider = label.provider
             AND (
               engine.provider_order_id = label.provider_order_id
               OR engine.provider_order_key = label.provider_order_key
               OR EXISTS (
                 SELECT 1
                 FROM wms.shipping_engine_order_provider_refs AS provider_ref
                 WHERE provider_ref.shipping_engine_order_id = engine.id
                   AND provider_ref.provider = label.provider
                   AND provider_ref.provider_order_id = label.provider_order_id
               )
               OR engine.shipment_request_id IN (
                 SELECT shipment_request_id FROM request_targets
               )
             )
          ),
          targets AS (
            SELECT * FROM physical_targets
            UNION ALL
            SELECT * FROM legacy_targets
            UNION ALL
            SELECT * FROM provider_item_targets
            UNION ALL
            SELECT * FROM request_targets
            UNION ALL
            SELECT * FROM engine_targets
          )
          INSERT INTO wms.shipping_provider_label_links (
            shipping_provider_label_id,
            shipment_request_id,
            shipping_engine_order_id,
            physical_shipment_id,
            legacy_wms_shipment_id,
            source,
            metadata,
            created_at,
            updated_at
          )
          SELECT
            target.shipping_provider_label_id,
            target.shipment_request_id,
            target.shipping_engine_order_id,
            target.physical_shipment_id,
            target.legacy_wms_shipment_id,
            target.source,
            jsonb_build_object('shadowOnly', true),
            ${reconciledAt},
            ${reconciledAt}
          FROM targets AS target
          ON CONFLICT DO NOTHING
          RETURNING id
        `);

        const totalResult = await databaseTx.execute(sql`
          SELECT COUNT(*)::integer AS total_links
          FROM wms.shipping_provider_label_links
          WHERE shipping_provider_label_id = ${shippingProviderLabelId}
        `);
        const totalRow = resultRows(totalResult)[0];
        const totalLinks = nonNegativeInteger(totalRow?.total_links, "total_links");
        await databaseTx.execute(sql`
          UPDATE wms.shipping_provider_labels
          SET
            last_link_reconciled_at = ${reconciledAt},
            next_link_reconcile_at = CASE
              WHEN ${totalLinks}::integer > 0 OR ${currentLabelDirection}::text = 'return' THEN NULL
              ELSE ${reconciledAt}::timestamptz + INTERVAL '30 minutes'
            END,
            link_reconcile_attempts = CASE
              WHEN ${totalLinks}::integer > 0 OR ${currentLabelDirection}::text = 'return' THEN 0
              ELSE link_reconcile_attempts + 1
            END,
            updated_at = ${reconciledAt}
          WHERE id = ${shippingProviderLabelId}
        `);
        return {
          shippingProviderLabelId,
          linksInserted: resultRows(insertedResult).length,
          totalLinks,
        };
      });
    },

    async listProviderLabelsPendingLinkReconciliation(limit, asOf) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
        throw new Error("Provider-label reconciliation limit must be an integer between 1 and 500");
      }
      if (Number.isNaN(asOf.getTime())) {
        throw new Error("Provider-label reconciliation asOf must be a valid timestamp");
      }
      const result = await db.execute(sql`
        SELECT label.provider, label.provider_label_id
        FROM wms.shipping_provider_labels AS label
        WHERE (
          label.last_link_reconciled_at IS NULL
          OR label.last_link_reconciled_at < label.last_observed_at
          OR (
            label.label_direction = 'outbound'
            AND (
              NOT EXISTS (
                SELECT 1
                FROM wms.shipping_provider_label_links AS link
                WHERE link.shipping_provider_label_id = label.id
              )
              AND label.next_link_reconcile_at <= ${asOf}
            )
          )
        )
        ORDER BY
          (label.last_link_reconciled_at IS NULL) DESC,
          COALESCE(label.next_link_reconcile_at, label.first_observed_at),
          label.id
        LIMIT ${limit}
      `);
      return resultRows(result).map((row) => ({
        provider: requiredString(row.provider, "provider"),
        providerLabelId: requiredString(row.provider_label_id, "provider_label_id"),
      }));
    },

    async prepareLabelTrackingPolls(limit, asOf) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
        throw new Error("Label-tracking poll preparation limit must be an integer between 1 and 500");
      }
      if (Number.isNaN(asOf.getTime())) {
        throw new Error("Label-tracking poll preparation asOf must be a valid timestamp");
      }

      return db.transaction(async (databaseTx: any) => {
        const completedResult = await databaseTx.execute(sql`
          UPDATE wms.carrier_tracking_label_polls AS poll
          SET
            poll_status = 'complete',
            next_attempt_at = NULL,
            confirmed_at = command.dispatch_occurred_at,
            last_event_id = command.carrier_tracking_event_id,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = ${asOf}
          FROM wms.carrier_dispatch_commands AS command
          WHERE command.shipping_provider_label_id = poll.shipping_provider_label_id
            AND poll.poll_status <> 'complete'
          RETURNING poll.shipping_provider_label_id
        `);

        const retiredResult = await databaseTx.execute(sql`
          UPDATE wms.carrier_tracking_label_polls AS poll
          SET
            poll_status = 'retired',
            next_attempt_at = NULL,
            confirmed_at = NULL,
            last_event_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = 'LABEL_POLL_NO_LONGER_ELIGIBLE',
            last_error_message =
              'Provider label is no longer eligible for exact-label tracking polling',
            updated_at = ${asOf}
          FROM wms.shipping_provider_labels AS label
          WHERE label.id = poll.shipping_provider_label_id
            AND (
              poll.poll_status IN ('pending', 'waiting', 'retry')
              OR (
                poll.poll_status = 'processing'
                AND poll.lease_expires_at <= ${asOf}
              )
            )
            AND (
              label.provider <> 'shipstation'
              OR label.label_direction <> 'outbound'
              OR label.label_status NOT IN ('active', 'unknown')
              OR NOT EXISTS (
                SELECT 1
                FROM wms.shipping_provider_label_links AS link
                JOIN wms.outbound_shipments AS legacy
                  ON legacy.id = link.legacy_wms_shipment_id
                  AND legacy.status IN ('planned', 'queued', 'labeled', 'on_hold')
                WHERE link.shipping_provider_label_id = label.id
              )
              OR EXISTS (
                SELECT 1
                FROM wms.physical_shipments AS physical
                WHERE physical.provider = label.provider
                  AND physical.provider_physical_shipment_id IN (
                    label.provider_label_id,
                    label.provider || '_shipment:' || label.provider_label_id,
                    'shipstation_shipment:' || label.provider_label_id
                  )
              )
            )
          RETURNING poll.shipping_provider_label_id
        `);

        const insertedResult = await databaseTx.execute(sql`
          WITH candidates AS (
            SELECT label.id
            FROM wms.shipping_provider_labels AS label
            WHERE label.provider = 'shipstation'
              AND label.label_direction = 'outbound'
              AND label.label_status IN ('active', 'unknown')
              AND NULLIF(BTRIM(label.provider_label_id), '') IS NOT NULL
              AND NULLIF(BTRIM(label.carrier), '') IS NOT NULL
              AND NULLIF(BTRIM(label.tracking_number), '') IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM wms.shipping_provider_label_links AS link
                JOIN wms.outbound_shipments AS legacy
                  ON legacy.id = link.legacy_wms_shipment_id
                  AND legacy.status IN ('planned', 'queued', 'labeled', 'on_hold')
                WHERE link.shipping_provider_label_id = label.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM wms.carrier_dispatch_commands AS command
                WHERE command.shipping_provider_label_id = label.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM wms.physical_shipments AS physical
                WHERE physical.provider = label.provider
                  AND physical.provider_physical_shipment_id IN (
                    label.provider_label_id,
                    label.provider || '_shipment:' || label.provider_label_id,
                    'shipstation_shipment:' || label.provider_label_id
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM wms.carrier_tracking_label_polls AS poll
                WHERE poll.shipping_provider_label_id = label.id
              )
            ORDER BY COALESCE(label.label_created_at, label.last_observed_at) DESC, label.id DESC
            LIMIT ${limit}
          )
          INSERT INTO wms.carrier_tracking_label_polls (
            shipping_provider_label_id,
            poll_status,
            attempt_count,
            consecutive_failure_count,
            next_attempt_at,
            metadata,
            created_at,
            updated_at
          )
          SELECT
            candidate.id,
            'pending',
            0,
            0,
            ${asOf},
            jsonb_build_object(
              'pollSource', 'shipstation_exact_label_tracking',
              'authority', 'carrier_tracking'
            ),
            ${asOf},
            ${asOf}
          FROM candidates AS candidate
          ON CONFLICT (shipping_provider_label_id) DO NOTHING
          RETURNING shipping_provider_label_id
        `);

        return {
          inserted: resultRows(insertedResult).length,
          completed: resultRows(completedResult).length,
          retired: resultRows(retiredResult).length,
        };
      });
    },

    async claimLabelTrackingPolls(limit, asOf, leaseOwner, leaseExpiresAt) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
        throw new Error("Label-tracking poll claim limit must be an integer between 1 and 100");
      }
      if (Number.isNaN(asOf.getTime()) || Number.isNaN(leaseExpiresAt.getTime())) {
        throw new Error("Label-tracking poll claim timestamps must be valid");
      }
      if (leaseExpiresAt.getTime() <= asOf.getTime()) {
        throw new Error("Label-tracking poll lease must expire after asOf");
      }
      const normalizedLeaseOwner = leaseOwner.trim();
      if (!normalizedLeaseOwner || normalizedLeaseOwner.length > 200) {
        throw new Error("Label-tracking poll leaseOwner must contain 1 through 200 characters");
      }

      const result = await db.execute(sql`
        WITH due AS (
          SELECT poll.shipping_provider_label_id
          FROM wms.carrier_tracking_label_polls AS poll
          JOIN wms.shipping_provider_labels AS label
            ON label.id = poll.shipping_provider_label_id
          WHERE (
            (
              poll.poll_status IN ('pending', 'waiting', 'retry')
              AND poll.next_attempt_at <= ${asOf}
            )
            OR (
              poll.poll_status = 'processing'
              AND poll.lease_expires_at <= ${asOf}
            )
          )
            AND label.provider = 'shipstation'
            AND label.label_direction = 'outbound'
            AND label.label_status IN ('active', 'unknown')
            AND EXISTS (
              SELECT 1
              FROM wms.shipping_provider_label_links AS link
              JOIN wms.outbound_shipments AS legacy
                ON legacy.id = link.legacy_wms_shipment_id
                AND legacy.status IN ('planned', 'queued', 'labeled', 'on_hold')
              WHERE link.shipping_provider_label_id = label.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM wms.carrier_dispatch_commands AS command
              WHERE command.shipping_provider_label_id = label.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM wms.physical_shipments AS physical
              WHERE physical.provider = label.provider
                AND physical.provider_physical_shipment_id IN (
                  label.provider_label_id,
                  label.provider || '_shipment:' || label.provider_label_id,
                  'shipstation_shipment:' || label.provider_label_id
                )
            )
          ORDER BY
            CASE WHEN poll.poll_status = 'processing' THEN 0 ELSE 1 END,
            COALESCE(label.label_created_at, label.last_observed_at) DESC,
            poll.shipping_provider_label_id DESC
          FOR UPDATE OF poll SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE wms.carrier_tracking_label_polls AS poll
        SET
          poll_status = 'processing',
          attempt_count = CASE
            WHEN poll.poll_status = 'processing' THEN GREATEST(poll.attempt_count, 1)
            ELSE poll.attempt_count + 1
          END,
          next_attempt_at = NULL,
          last_attempt_at = ${asOf},
          lease_owner = ${normalizedLeaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          updated_at = ${asOf}
        FROM due, wms.shipping_provider_labels AS label
        WHERE poll.shipping_provider_label_id = due.shipping_provider_label_id
          AND label.id = poll.shipping_provider_label_id
        RETURNING
          poll.shipping_provider_label_id,
          label.provider_label_id,
          LOWER(BTRIM(label.carrier)) AS carrier_code,
          label.tracking_number,
          label.normalized_tracking_number,
          poll.attempt_count,
          poll.consecutive_failure_count,
          poll.last_attempt_at,
          poll.lease_owner,
          poll.lease_expires_at
      `);
      return resultRows(result).map((row) => ({
        shippingProviderLabelId: requiredId(
          row.shipping_provider_label_id,
          "shipping_provider_label_id",
        ),
        providerLabelId: requiredString(row.provider_label_id, "provider_label_id"),
        carrierCode: requiredString(row.carrier_code, "carrier_code"),
        trackingNumber: requiredString(row.tracking_number, "tracking_number"),
        normalizedTrackingNumber: requiredString(
          row.normalized_tracking_number,
          "normalized_tracking_number",
        ),
        attemptNumber: requiredId(row.attempt_count, "attempt_count"),
        consecutiveFailureCount: nonnegativeInteger(
          row.consecutive_failure_count,
          "consecutive_failure_count",
        ),
        startedAt: requiredDate(row.last_attempt_at, "last_attempt_at"),
        leaseOwner: requiredString(row.lease_owner, "lease_owner"),
        leaseExpiresAt: requiredDate(row.lease_expires_at, "lease_expires_at"),
      }));
    },

    async finalizeLabelTrackingPollAttempt(input) {
      if (Number.isNaN(input.startedAt.getTime())
          || Number.isNaN(input.completedAt.getTime())
          || (input.nextAttemptAt && Number.isNaN(input.nextAttemptAt.getTime()))) {
        throw new Error("Label-tracking poll finalization timestamps must be valid");
      }
      if (input.completedAt.getTime() < input.startedAt.getTime()) {
        throw new Error("Label-tracking poll attempt cannot complete before it starts");
      }
      if (input.outcome === "waiting" || input.outcome === "retry_scheduled") {
        if (!input.nextAttemptAt) {
          throw new Error("Waiting and retryable label polls require nextAttemptAt");
        }
      } else if (input.nextAttemptAt) {
        throw new Error("Completed and review label polls cannot set nextAttemptAt");
      }
      const providerSucceeded = input.outcome === "confirmed" || input.outcome === "waiting";
      if (providerSucceeded !== (
        input.httpStatus === 200
        && input.carrierTrackingEventId !== null
        && input.dispatchEvidence !== null
        && input.errorCode === null
        && input.errorMessage === null
      )) {
        throw new Error("Label-tracking poll finalization evidence does not match its outcome");
      }
      if (!providerSucceeded && (!input.errorCode || !input.errorMessage)) {
        throw new Error("Failed label-tracking polls require an error code and message");
      }

      return db.transaction(async (databaseTx: any) => {
        const existingResult = await databaseTx.execute(sql`
          SELECT id, attempt_outcome
          FROM wms.carrier_tracking_label_poll_attempts
          WHERE shipping_provider_label_id = ${input.shippingProviderLabelId}
            AND attempt_number = ${input.attemptNumber}
          LIMIT 1
        `);
        const existing = resultRows(existingResult)[0];
        if (existing) {
          return {
            id: requiredId(existing.id, "carrier_tracking_label_poll_attempt_id"),
            inserted: false,
            outcome: requiredString(
              existing.attempt_outcome,
              "attempt_outcome",
            ) as StoredCarrierTrackingLabelPollAttempt["outcome"],
          };
        }

        const stateResult = await databaseTx.execute(sql`
          SELECT poll_status, attempt_count, lease_owner
          FROM wms.carrier_tracking_label_polls
          WHERE shipping_provider_label_id = ${input.shippingProviderLabelId}
          FOR UPDATE
        `);
        const state = resultRows(stateResult)[0];
        if (!state) throw new Error("Label-tracking poll no longer exists");
        if (state.poll_status !== "processing"
            || state.lease_owner !== input.leaseOwner
            || Number(state.attempt_count) !== input.attemptNumber) {
          throw new Error("Label-tracking poll lease was lost before finalization");
        }

        const attemptResult = await databaseTx.execute(sql`
          INSERT INTO wms.carrier_tracking_label_poll_attempts (
            shipping_provider_label_id,
            attempt_number,
            attempt_outcome,
            http_status,
            carrier_tracking_event_id,
            dispatch_evidence,
            error_code,
            error_message,
            request_evidence,
            response_evidence,
            started_at,
            completed_at,
            created_at
          ) VALUES (
            ${input.shippingProviderLabelId},
            ${input.attemptNumber},
            ${input.outcome},
            ${input.httpStatus},
            ${input.carrierTrackingEventId},
            ${input.dispatchEvidence},
            ${input.errorCode},
            ${input.errorMessage},
            ${input.requestEvidence},
            ${input.responseEvidence},
            ${input.startedAt},
            ${input.completedAt},
            ${input.completedAt}
          )
          RETURNING id
        `);
        const attemptId = requiredId(
          resultRows(attemptResult)[0]?.id,
          "carrier_tracking_label_poll_attempt_id",
        );
        const pollStatus = input.outcome === "confirmed"
          ? "complete"
          : input.outcome === "waiting"
            ? "waiting"
            : input.outcome === "retry_scheduled"
              ? "retry"
              : "review";

        await databaseTx.execute(sql`
          UPDATE wms.carrier_tracking_label_polls
          SET
            poll_status = ${pollStatus},
            consecutive_failure_count = CASE
              WHEN ${providerSucceeded}::boolean THEN 0
              ELSE consecutive_failure_count + 1
            END,
            next_attempt_at = ${input.nextAttemptAt},
            confirmed_at = CASE
              WHEN ${input.outcome}::text = 'confirmed' THEN ${input.completedAt}
              ELSE NULL
            END,
            last_event_id = ${input.carrierTrackingEventId},
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = ${input.errorCode},
            last_error_message = ${input.errorMessage},
            updated_at = ${input.completedAt}
          WHERE shipping_provider_label_id = ${input.shippingProviderLabelId}
        `);

        return { id: attemptId, inserted: true, outcome: input.outcome };
      });
    },

    async prepareTrackingSubscriptions(limit, asOf) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
        throw new Error("Tracking-subscription preparation limit must be an integer between 1 and 500");
      }
      if (Number.isNaN(asOf.getTime())) {
        throw new Error("Tracking-subscription preparation asOf must be a valid timestamp");
      }

      return db.transaction(async (databaseTx: any) => {
        const insertedSubscriptions = await databaseTx.execute(sql`
          WITH candidates AS (
            SELECT DISTINCT ON (
              LOWER(BTRIM(label.carrier)),
              label.normalized_tracking_number
            )
              LOWER(BTRIM(label.carrier)) AS carrier_code,
              label.tracking_number,
              label.normalized_tracking_number
            FROM wms.shipping_provider_labels AS label
            WHERE label.provider = 'shipstation'
              AND label.label_status IN ('active', 'unknown')
              AND NULLIF(BTRIM(label.carrier), '') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM wms.carrier_tracking_subscription_labels AS subscription_label
                WHERE subscription_label.shipping_provider_label_id = label.id
              )
            ORDER BY
              LOWER(BTRIM(label.carrier)),
              label.normalized_tracking_number,
              label.id
            LIMIT ${limit}
          )
          INSERT INTO wms.carrier_tracking_subscriptions (
            tracking_provider,
            carrier_code,
            tracking_number,
            normalized_tracking_number,
            subscription_status,
            attempt_count,
            consecutive_failure_count,
            next_attempt_at,
            metadata,
            created_at,
            updated_at
          )
          SELECT
            'shipstation_api',
            candidate.carrier_code,
            candidate.tracking_number,
            candidate.normalized_tracking_number,
            'pending',
            0,
            0,
            ${asOf},
            jsonb_build_object('shadowOnly', true, 'enrollmentSource', 'provider_label'),
            ${asOf},
            ${asOf}
          FROM candidates AS candidate
          ON CONFLICT (
            tracking_provider,
            carrier_code,
            normalized_tracking_number
          ) DO NOTHING
          RETURNING id
        `);

        const insertedLinks = await databaseTx.execute(sql`
          WITH candidates AS (
            SELECT label.id, LOWER(BTRIM(label.carrier)) AS carrier_code,
                   label.normalized_tracking_number
            FROM wms.shipping_provider_labels AS label
            WHERE label.provider = 'shipstation'
              AND label.label_status IN ('active', 'unknown')
              AND NULLIF(BTRIM(label.carrier), '') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM wms.carrier_tracking_subscription_labels AS subscription_label
                WHERE subscription_label.shipping_provider_label_id = label.id
              )
            ORDER BY label.id
            LIMIT ${limit}
          )
          INSERT INTO wms.carrier_tracking_subscription_labels (
            carrier_tracking_subscription_id,
            shipping_provider_label_id,
            source,
            metadata,
            created_at
          )
          SELECT
            subscription.id,
            candidate.id,
            'provider_label_tracking_identity',
            jsonb_build_object('shadowOnly', true),
            ${asOf}
          FROM candidates AS candidate
          JOIN wms.carrier_tracking_subscriptions AS subscription
            ON subscription.tracking_provider = 'shipstation_api'
           AND subscription.carrier_code = candidate.carrier_code
           AND subscription.normalized_tracking_number = candidate.normalized_tracking_number
          ON CONFLICT (
            carrier_tracking_subscription_id,
            shipping_provider_label_id
          ) DO NOTHING
          RETURNING id
        `);

        return {
          subscriptionsInserted: resultRows(insertedSubscriptions).length,
          labelLinksInserted: resultRows(insertedLinks).length,
        };
      });
    },

    async claimTrackingSubscriptions(limit, asOf, leaseOwner, leaseExpiresAt) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
        throw new Error("Tracking-subscription claim limit must be an integer between 1 and 100");
      }
      if (Number.isNaN(asOf.getTime()) || Number.isNaN(leaseExpiresAt.getTime())) {
        throw new Error("Tracking-subscription claim timestamps must be valid");
      }
      if (leaseExpiresAt.getTime() <= asOf.getTime()) {
        throw new Error("Tracking-subscription lease must expire after asOf");
      }
      const normalizedLeaseOwner = leaseOwner.trim();
      if (!normalizedLeaseOwner || normalizedLeaseOwner.length > 200) {
        throw new Error("Tracking-subscription leaseOwner must contain 1 through 200 characters");
      }

      const result = await db.execute(sql`
        WITH due AS (
          SELECT subscription.id
          FROM wms.carrier_tracking_subscriptions AS subscription
          WHERE (
            subscription.subscription_status IN ('pending', 'retry')
            AND subscription.next_attempt_at <= ${asOf}
          ) OR (
            subscription.subscription_status = 'processing'
            AND subscription.lease_expires_at <= ${asOf}
          )
          ORDER BY
            CASE WHEN subscription.subscription_status = 'processing' THEN 0 ELSE 1 END,
            COALESCE(subscription.lease_expires_at, subscription.next_attempt_at),
            subscription.id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE wms.carrier_tracking_subscriptions AS subscription
        SET
          subscription_status = 'processing',
          attempt_count = CASE
            WHEN subscription.subscription_status = 'processing'
              THEN GREATEST(subscription.attempt_count, 1)
            ELSE subscription.attempt_count + 1
          END,
          next_attempt_at = NULL,
          last_attempt_at = ${asOf},
          lease_owner = ${normalizedLeaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          updated_at = ${asOf}
        FROM due
        WHERE subscription.id = due.id
        RETURNING
          subscription.id,
          subscription.tracking_provider,
          subscription.carrier_code,
          subscription.tracking_number,
          subscription.normalized_tracking_number,
          subscription.attempt_count,
          subscription.consecutive_failure_count,
          subscription.last_attempt_at,
          subscription.lease_owner,
          subscription.lease_expires_at
      `);
      return resultRows(result).map(claimedTrackingSubscriptionFromRow);
    },

    async finalizeTrackingSubscriptionAttempt(input) {
      if (Number.isNaN(input.startedAt.getTime())
          || Number.isNaN(input.completedAt.getTime())
          || (input.nextAttemptAt && Number.isNaN(input.nextAttemptAt.getTime()))) {
        throw new Error("Tracking-subscription finalization timestamps must be valid");
      }
      if (input.completedAt.getTime() < input.startedAt.getTime()) {
        throw new Error("Tracking-subscription attempt cannot complete before it starts");
      }
      if (input.outcome === "retry_scheduled" && !input.nextAttemptAt) {
        throw new Error("Retryable tracking-subscription attempts require nextAttemptAt");
      }
      if (input.outcome !== "retry_scheduled" && input.nextAttemptAt) {
        throw new Error("Only retryable tracking-subscription attempts may set nextAttemptAt");
      }

      return db.transaction(async (databaseTx: any) => {
        const existing = await databaseTx
          .select({ id: carrierTrackingSubscriptionAttempts.id })
          .from(carrierTrackingSubscriptionAttempts)
          .where(and(
            eq(
              carrierTrackingSubscriptionAttempts.carrierTrackingSubscriptionId,
              input.subscriptionId,
            ),
            eq(carrierTrackingSubscriptionAttempts.attemptNumber, input.attemptNumber),
          ))
          .limit(1);
        if (existing[0]) return { id: existing[0].id, inserted: false };

        const stateResult = await databaseTx.execute(sql`
          SELECT subscription_status, attempt_count, lease_owner
          FROM wms.carrier_tracking_subscriptions
          WHERE id = ${input.subscriptionId}
          FOR UPDATE
        `);
        const state = resultRows(stateResult)[0];
        if (!state) throw new Error("Tracking subscription no longer exists");
        if (state.subscription_status !== "processing"
            || state.lease_owner !== input.leaseOwner
            || Number(state.attempt_count) !== input.attemptNumber) {
          throw new Error("Tracking subscription lease was lost before finalization");
        }

        const [attempt] = await databaseTx
          .insert(carrierTrackingSubscriptionAttempts)
          .values({
            carrierTrackingSubscriptionId: input.subscriptionId,
            attemptNumber: input.attemptNumber,
            attemptOutcome: input.outcome,
            httpStatus: input.httpStatus,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            requestEvidence: input.requestEvidence,
            responseEvidence: input.responseEvidence,
            startedAt: input.startedAt,
            completedAt: input.completedAt,
            createdAt: input.completedAt,
          })
          .returning({ id: carrierTrackingSubscriptionAttempts.id });
        const attemptId = requiredId(attempt?.id, "carrier_tracking_subscription_attempt_id");
        const subscriptionStatus = input.outcome === "activated"
          ? "active"
          : input.outcome === "retry_scheduled"
            ? "retry"
            : "review";

        await databaseTx
          .update(carrierTrackingSubscriptions)
          .set({
            subscriptionStatus,
            consecutiveFailureCount: input.outcome === "activated"
              ? 0
              : sql`${carrierTrackingSubscriptions.consecutiveFailureCount} + 1`,
            nextAttemptAt: input.nextAttemptAt,
            activatedAt: input.outcome === "activated" ? input.completedAt : null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: input.errorCode,
            lastErrorMessage: input.errorMessage,
            updatedAt: input.completedAt,
          })
          .where(eq(carrierTrackingSubscriptions.id, input.subscriptionId));

        return { id: attemptId, inserted: true };
      });
    },

    async requeueReviewedTrackingSubscriptions(input) {
      const errorCode = input.errorCode.trim();
      const carrierCode = input.carrierCode?.trim() || null;
      const operator = input.operator.trim();
      const reason = input.reason.trim();
      const idempotencyKey = input.idempotencyKey.trim();
      if (!errorCode || errorCode.length > 100) {
        throw new Error("Tracking-subscription requeue errorCode must contain 1 through 100 characters");
      }
      if (carrierCode && carrierCode.length > 100) {
        throw new Error("Tracking-subscription requeue carrierCode must not exceed 100 characters");
      }
      if (input.httpStatus !== null
          && (!Number.isSafeInteger(input.httpStatus)
            || input.httpStatus < 100
            || input.httpStatus > 599)) {
        throw new Error("Tracking-subscription requeue httpStatus must be null or an integer from 100 through 599");
      }
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 500) {
        throw new Error("Tracking-subscription requeue limit must be an integer between 1 and 500");
      }
      if (!Number.isSafeInteger(input.expectedCount)
          || input.expectedCount <= 0
          || input.expectedCount > input.limit) {
        throw new Error("Tracking-subscription requeue expectedCount must be between 1 and limit");
      }
      if (!operator || operator.length > 200) {
        throw new Error("Tracking-subscription requeue operator must contain 1 through 200 characters");
      }
      if (!reason || reason.length > 2_000) {
        throw new Error("Tracking-subscription requeue reason must contain 1 through 2000 characters");
      }
      if (!idempotencyKey || idempotencyKey.length > 200) {
        throw new Error("Tracking-subscription requeue idempotencyKey must contain 1 through 200 characters");
      }
      if (Number.isNaN(input.requeuedAt.getTime())) {
        throw new Error("Tracking-subscription requeue timestamp must be valid");
      }

      return db.transaction(async (databaseTx: any) => {
        const candidateResult = await databaseTx.execute(sql`
          SELECT
            subscription.id,
            subscription.subscription_status,
            subscription.attempt_count,
            subscription.consecutive_failure_count,
            subscription.last_error_code,
            subscription.last_error_message,
            latest_attempt.http_status,
            COALESCE(latest_attempt.response_evidence, '{}'::jsonb) AS response_evidence
          FROM wms.carrier_tracking_subscriptions AS subscription
          LEFT JOIN LATERAL (
            SELECT attempt.http_status, attempt.response_evidence
            FROM wms.carrier_tracking_subscription_attempts AS attempt
            WHERE attempt.carrier_tracking_subscription_id = subscription.id
            ORDER BY attempt.attempt_number DESC, attempt.id DESC
            LIMIT 1
          ) AS latest_attempt ON TRUE
          WHERE subscription.subscription_status = 'review'
            AND subscription.last_error_code = ${errorCode}
            AND (${carrierCode}::text IS NULL OR subscription.carrier_code = ${carrierCode}::text)
            AND (${input.httpStatus}::integer IS NULL
              OR latest_attempt.http_status = ${input.httpStatus}::integer)
          ORDER BY subscription.id
          FOR UPDATE OF subscription SKIP LOCKED
          LIMIT ${input.limit}
        `);
        const candidates = resultRows(candidateResult);
        if (candidates.length !== input.expectedCount) {
          throw new Error(
            `Tracking-subscription requeue expected ${input.expectedCount} candidate(s), found ${candidates.length}; rerun dry-run`,
          );
        }

        let requeued = 0;
        for (const candidate of candidates) {
          const subscriptionId = requiredId(candidate.id, "carrier_tracking_subscription_id");
          const [audit] = await databaseTx
            .insert(carrierTrackingSubscriptionRequeues)
            .values({
              carrierTrackingSubscriptionId: subscriptionId,
              idempotencyKey,
              operator,
              reason,
              previousStatus: requiredString(
                candidate.subscription_status,
                "subscription_status",
              ),
              previousAttemptCount: nonnegativeInteger(
                candidate.attempt_count,
                "attempt_count",
              ),
              previousConsecutiveFailureCount: nonnegativeInteger(
                candidate.consecutive_failure_count,
                "consecutive_failure_count",
              ),
              previousErrorCode: stringOrNull(candidate.last_error_code),
              previousErrorMessage: stringOrNull(candidate.last_error_message),
              previousHttpStatus: httpStatusOrNull(candidate.http_status),
              previousResponseEvidence: candidate.response_evidence ?? {},
              createdAt: input.requeuedAt,
            })
            .onConflictDoNothing()
            .returning({ id: carrierTrackingSubscriptionRequeues.id });
          if (!audit) continue;

          const updated = await databaseTx
            .update(carrierTrackingSubscriptions)
            .set({
              subscriptionStatus: "pending",
              consecutiveFailureCount: 0,
              nextAttemptAt: input.requeuedAt,
              activatedAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: input.requeuedAt,
            })
            .where(and(
              eq(carrierTrackingSubscriptions.id, subscriptionId),
              eq(carrierTrackingSubscriptions.subscriptionStatus, "review"),
            ))
            .returning({ id: carrierTrackingSubscriptions.id });
          if (updated.length !== 1) {
            throw new Error(
              `Tracking subscription ${subscriptionId} changed while its requeue was being recorded`,
            );
          }
          requeued += 1;
        }
        return { selected: candidates.length, requeued };
      });
    },

    async previewReviewedCarrierDispatchCommands(limit, cohort = null) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
        throw new Error("Carrier-dispatch repair preview limit must be an integer between 1 and 500");
      }
      const repairCohort = historicalCarrierDispatchRepairCohortSql();
      const eligibility = historicalCarrierDispatchRepairEligibilitySql(cohort);
      const countResult = await db.execute(sql`
        SELECT
          ${repairCohort} AS repair_cohort,
          COUNT(*)::integer AS candidate_count
        FROM wms.carrier_dispatch_commands AS command
        JOIN wms.shipping_provider_labels AS label
          ON label.id = command.shipping_provider_label_id
        JOIN wms.carrier_tracking_events AS event
          ON event.id = command.carrier_tracking_event_id
        WHERE ${eligibility}
        GROUP BY ${repairCohort}
        ORDER BY ${repairCohort}
      `);
      const counts = resultRows(countResult);
      const byCohort: Record<string, number> = {};
      let candidateCount = 0;
      for (const row of counts) {
        const cohort = historicalCarrierDispatchRepairCohort(row.repair_cohort);
        const count = nonnegativeInteger(row.candidate_count, "candidate_count");
        byCohort[cohort] = count;
        candidateCount += count;
      }

      const sampleResult = await db.execute(sql`
        SELECT
          command.id,
          command.shipping_provider_label_id,
          command.last_error_code,
          command.last_error_message,
          label.provider_label_id,
          label.provider_order_id,
          RIGHT(label.normalized_tracking_number, 8) AS tracking_suffix,
          ${repairCohort} AS repair_cohort
        FROM wms.carrier_dispatch_commands AS command
        JOIN wms.shipping_provider_labels AS label
          ON label.id = command.shipping_provider_label_id
        JOIN wms.carrier_tracking_events AS event
          ON event.id = command.carrier_tracking_event_id
        WHERE ${eligibility}
        ORDER BY command.id
        LIMIT ${Math.min(limit, 25)}
      `);
      return {
        candidateCount,
        selectedCount: Math.min(candidateCount, limit),
        byCohort: Object.freeze(byCohort),
        sample: Object.freeze(
          resultRows(sampleResult).map(historicalCarrierDispatchRepairCandidateFromRow),
        ),
      };
    },

    async requeueReviewedCarrierDispatchCommands(input) {
      const operator = input.operator.trim();
      const reason = input.reason.trim();
      const idempotencyKey = input.idempotencyKey.trim();
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 500) {
        throw new Error("Carrier-dispatch repair limit must be an integer between 1 and 500");
      }
      if (!Number.isSafeInteger(input.expectedCount)
          || input.expectedCount <= 0
          || input.expectedCount > input.limit) {
        throw new Error("Carrier-dispatch repair expectedCount must be between 1 and limit");
      }
      if (!operator || operator.length > 200) {
        throw new Error("Carrier-dispatch repair operator must contain 1 through 200 characters");
      }
      if (!reason || reason.length > 2_000) {
        throw new Error("Carrier-dispatch repair reason must contain 1 through 2000 characters");
      }
      if (!idempotencyKey || idempotencyKey.length > 200) {
        throw new Error("Carrier-dispatch repair idempotencyKey must contain 1 through 200 characters");
      }
      if (Number.isNaN(input.requeuedAt.getTime())) {
        throw new Error("Carrier-dispatch repair timestamp must be valid");
      }

      return db.transaction(async (databaseTx: any) => {
        const repairCohort = historicalCarrierDispatchRepairCohortSql();
        const eligibility = historicalCarrierDispatchRepairEligibilitySql(input.cohort);
        const candidateResult = await databaseTx.execute(sql`
          SELECT
            command.id,
            command.shipping_provider_label_id,
            command.status,
            command.attempt_count,
            command.consecutive_failure_count,
            command.last_error_code,
            command.last_error_message,
            command.result_evidence,
            label.provider_label_id,
            label.provider_order_id,
            RIGHT(label.normalized_tracking_number, 8) AS tracking_suffix,
            ${repairCohort} AS repair_cohort
          FROM wms.carrier_dispatch_commands AS command
          JOIN wms.shipping_provider_labels AS label
            ON label.id = command.shipping_provider_label_id
          JOIN wms.carrier_tracking_events AS event
            ON event.id = command.carrier_tracking_event_id
          WHERE ${eligibility}
          ORDER BY command.id
          FOR UPDATE OF command SKIP LOCKED
          LIMIT ${input.limit}
        `);
        const candidates = resultRows(candidateResult);
        if (candidates.length !== input.expectedCount) {
          throw new Error(
            `Carrier-dispatch repair expected ${input.expectedCount} candidate(s), found ${candidates.length}; rerun dry-run`,
          );
        }

        let requeued = 0;
        const byCohort: Record<string, number> = {};
        for (const candidate of candidates) {
          const commandId = requiredId(candidate.id, "carrier_dispatch_command_id");
          const repairCohortValue = historicalCarrierDispatchRepairCohort(
            candidate.repair_cohort,
          );
          byCohort[repairCohortValue] = (byCohort[repairCohortValue] ?? 0) + 1;
          const previousResultEvidence = requiredRecord(
            candidate.result_evidence,
            "carrier_dispatch_result_evidence",
          );
          const [audit] = await databaseTx
            .insert(carrierDispatchCommandRequeues)
            .values({
              carrierDispatchCommandId: commandId,
              idempotencyKey,
              operator,
              reason,
              repairCohort: repairCohortValue,
              previousStatus: requiredString(candidate.status, "carrier_dispatch_status"),
              previousAttemptCount: nonnegativeInteger(
                candidate.attempt_count,
                "carrier_dispatch_attempt_count",
              ),
              previousConsecutiveFailureCount: nonnegativeInteger(
                candidate.consecutive_failure_count,
                "carrier_dispatch_consecutive_failure_count",
              ),
              previousErrorCode: stringOrNull(candidate.last_error_code),
              previousErrorMessage: stringOrNull(candidate.last_error_message),
              previousResultEvidence,
              createdAt: input.requeuedAt,
            })
            .onConflictDoNothing({
              target: [
                carrierDispatchCommandRequeues.carrierDispatchCommandId,
                carrierDispatchCommandRequeues.idempotencyKey,
              ],
            })
            .returning({ id: carrierDispatchCommandRequeues.id });
          if (!audit) continue;

          const updated = await databaseTx
            .update(carrierDispatchCommands)
            .set({
              status: "pending",
              consecutiveFailureCount: 0,
              nextAttemptAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              succeededAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              resultEvidence: {
                ...previousResultEvidence,
                historicalRepairRequeue: {
                  idempotencyKey,
                  operator,
                  reason,
                  repairCohort: repairCohortValue,
                  requeuedAt: input.requeuedAt.toISOString(),
                },
              },
              updatedAt: input.requeuedAt,
            })
            .where(and(
              eq(carrierDispatchCommands.id, commandId),
              eq(carrierDispatchCommands.status, "review_required"),
            ))
            .returning({ id: carrierDispatchCommands.id });
          if (updated.length !== 1) {
            throw new Error(
              `Carrier-dispatch command ${commandId} changed while its requeue was being recorded`,
            );
          }
          requeued += 1;
        }

        return {
          selected: candidates.length,
          requeued,
          byCohort: Object.freeze(byCohort),
        };
      });
    },

    async claimDispatchCommands(limit, asOf, leaseOwner, leaseExpiresAt) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
        throw new Error("Carrier-dispatch claim limit must be an integer between 1 and 100");
      }
      if (Number.isNaN(asOf.getTime()) || Number.isNaN(leaseExpiresAt.getTime())) {
        throw new Error("Carrier-dispatch claim timestamps must be valid");
      }
      if (leaseExpiresAt.getTime() <= asOf.getTime()) {
        throw new Error("Carrier-dispatch lease must expire after asOf");
      }
      const normalizedLeaseOwner = leaseOwner.trim();
      if (!normalizedLeaseOwner || normalizedLeaseOwner.length > 150) {
        throw new Error("Carrier-dispatch leaseOwner must contain 1 through 150 characters");
      }

      const result = await db.execute(sql`
        WITH due AS (
          SELECT command.id
          FROM wms.carrier_dispatch_commands AS command
          JOIN wms.shipping_provider_labels AS label
            ON label.id = command.shipping_provider_label_id AND label.label_direction = 'outbound'
          WHERE command.status = 'pending'
             OR (
               command.status = 'retry_scheduled'
               AND command.next_attempt_at <= ${asOf}
             )
             OR (
               command.status = 'processing'
               AND command.lease_expires_at <= ${asOf}
             )
          ORDER BY
            CASE WHEN command.status = 'processing' THEN 0 ELSE 1 END,
            COALESCE(
              command.lease_expires_at,
              command.next_attempt_at,
              command.created_at
            ),
            command.id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        ),
        claimed AS (
          UPDATE wms.carrier_dispatch_commands AS command
          SET
            status = 'processing',
            attempt_count = CASE
              WHEN command.status = 'processing'
                THEN GREATEST(command.attempt_count, 1)
              ELSE command.attempt_count + 1
            END,
            next_attempt_at = NULL,
            lease_owner = LEFT(${normalizedLeaseOwner}, 150)
              || ':' || txid_current()::text
              || ':' || command.id::text,
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${asOf}
          FROM due
          WHERE command.id = due.id
          RETURNING
            command.id,
            command.shipping_provider_label_id,
            command.carrier_tracking_event_id,
            command.dispatch_occurred_at,
            command.attempt_count AS attempt_number,
            command.consecutive_failure_count,
            command.lease_owner,
            command.lease_expires_at
        )
        SELECT
          claimed.*,
          label.provider,
          label.provider_label_id,
          label.provider_order_id,
          label.provider_order_key,
          label.tracking_number,
          label.normalized_tracking_number,
          label.carrier,
          label.service_code,
          ${asOf}::timestamptz AS started_at
        FROM claimed
        JOIN wms.shipping_provider_labels AS label
          ON label.id = claimed.shipping_provider_label_id
        ORDER BY claimed.id
      `);
      return resultRows(result).map(claimedDispatchCommandFromRow);
    },

    async finalizeDispatchAttempt(input) {
      if (Number.isNaN(input.startedAt.getTime())
          || Number.isNaN(input.completedAt.getTime())
          || (input.nextAttemptAt && Number.isNaN(input.nextAttemptAt.getTime()))) {
        throw new Error("Carrier-dispatch finalization timestamps must be valid");
      }
      if (input.completedAt.getTime() < input.startedAt.getTime()) {
        throw new Error("Carrier-dispatch attempt cannot complete before it starts");
      }
      if (input.outcome === "retry_scheduled" && !input.nextAttemptAt) {
        throw new Error("Retryable carrier-dispatch attempts require nextAttemptAt");
      }
      if (input.outcome !== "retry_scheduled" && input.nextAttemptAt) {
        throw new Error("Only retryable carrier-dispatch attempts may set nextAttemptAt");
      }

      return db.transaction(async (databaseTx: any) => {
        const existing = await databaseTx
          .select({
            id: carrierDispatchAttempts.id,
            outcome: carrierDispatchAttempts.attemptOutcome,
          })
          .from(carrierDispatchAttempts)
          .where(and(
            eq(carrierDispatchAttempts.carrierDispatchCommandId, input.commandId),
            eq(carrierDispatchAttempts.attemptNumber, input.attemptNumber),
          ))
          .limit(1);
        if (existing[0]) {
          return {
            id: requiredId(existing[0].id, "carrier_dispatch_attempt_id"),
            inserted: false,
            outcome: carrierDispatchAttemptOutcome(existing[0].outcome),
          };
        }

        const stateResult = await databaseTx.execute(sql`
          SELECT status, attempt_count, lease_owner
          FROM wms.carrier_dispatch_commands
          WHERE id = ${input.commandId}
          FOR UPDATE
        `);
        const state = resultRows(stateResult)[0];
        if (!state) throw new Error("Carrier-dispatch command no longer exists");
        if (state.status !== "processing"
            || state.lease_owner !== input.leaseOwner
            || Number(state.attempt_count) !== input.attemptNumber) {
          throw new Error("Carrier-dispatch command lease was lost before finalization");
        }

        const [attempt] = await databaseTx
          .insert(carrierDispatchAttempts)
          .values({
            carrierDispatchCommandId: input.commandId,
            attemptNumber: input.attemptNumber,
            attemptOutcome: input.outcome,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            requestEvidence: input.requestEvidence,
            responseEvidence: input.responseEvidence,
            startedAt: input.startedAt,
            completedAt: input.completedAt,
            createdAt: input.completedAt,
          })
          .returning({ id: carrierDispatchAttempts.id });
        const attemptId = requiredId(attempt?.id, "carrier_dispatch_attempt_id");

        await databaseTx
          .update(carrierDispatchCommands)
          .set({
            status: input.outcome,
            consecutiveFailureCount: input.outcome === "succeeded"
              ? 0
              : sql`${carrierDispatchCommands.consecutiveFailureCount} + 1`,
            nextAttemptAt: input.nextAttemptAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            succeededAt: input.outcome === "succeeded" ? input.completedAt : null,
            lastErrorCode: input.errorCode,
            lastErrorMessage: input.errorMessage,
            resultEvidence: input.responseEvidence,
            updatedAt: input.completedAt,
          })
          .where(eq(carrierDispatchCommands.id, input.commandId));

        return { id: attemptId, inserted: true, outcome: input.outcome };
      });
    },

    async listEventsPendingReconciliation(limit, asOf) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
        throw new Error("Carrier tracking reconciliation limit must be an integer between 1 and 500");
      }
      if (Number.isNaN(asOf.getTime())) {
        throw new Error("Carrier tracking reconciliation asOf must be a valid timestamp");
      }
      const result = await db.execute(sql`
        SELECT
          event.provider,
          event.event_hash,
          event.payload_hash,
          event.tracking_number,
          event.normalized_tracking_number,
          event.provider_label_id,
          event.carrier,
          event.provider_status_code,
          event.provider_status_detail_code,
          event.provider_carrier_status_code,
          event.provider_carrier_detail_code,
          event.canonical_status,
          event.dispatch_evidence,
          event.status_description,
          event.carrier_status_description,
          event.event_occurred_at,
          event.event_time_source,
          event.estimated_delivery_at,
          event.actual_delivery_at,
          event.sanitized_payload,
          event.received_at
        FROM wms.carrier_tracking_events AS event
        LEFT JOIN wms.carrier_tracking_reconciliation_state AS state
          ON state.carrier_tracking_event_id = event.id
        WHERE state.carrier_tracking_event_id IS NULL
          OR state.next_reconcile_at <= ${asOf}
          OR EXISTS (
            SELECT 1
            FROM wms.shipping_provider_labels AS label
            WHERE label.provider = event.provider
              AND (
                label.provider_label_id = event.provider_label_id
                OR label.normalized_tracking_number = event.normalized_tracking_number
              )
              AND label.updated_at > state.last_reconciled_at
          )
        ORDER BY
          (state.carrier_tracking_event_id IS NULL) DESC,
          state.next_reconcile_at NULLS FIRST,
          event.received_at,
          event.id
        LIMIT ${limit}
      `);
      return resultRows(result).map(normalizedEventFromRow);
    },

    async transaction<T>(work: (tx: CarrierTrackingTransaction) => Promise<T>): Promise<T> {
      return db.transaction(async (databaseTx: any) => {
        const tx: CarrierTrackingTransaction = {
          async acquireTrackingLock(provider, normalizedTrackingNumber) {
            const lockKey = `carrier_tracking:${provider}:${normalizedTrackingNumber}`;
            await databaseTx.execute(sql`
              SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
            `);
          },

          async insertOrGetEvent(event) {
            return insertOrGetCarrierTrackingEvent(databaseTx, event);
          },

          async findMatchCandidates(event) {
            const labelResult = await databaseTx.execute(sql`
              WITH provider_identity AS (
                SELECT label.id
                FROM wms.shipping_provider_labels AS label
                WHERE label.provider = ${event.provider}
                  AND ${event.providerLabelId}::text IS NOT NULL
                  AND label.provider_label_id = ${event.providerLabelId}
              ),
              -- A label carrier names the provider account (for example stamps_com),
              -- while an event carrier names the parcel carrier (for example usps).
              -- Provider plus immutable tracking identity is the cross-namespace join.
              exact_identity AS (
                SELECT label.id
                FROM wms.shipping_provider_labels AS label
                WHERE label.id IN (SELECT id FROM provider_identity)
                  AND label.normalized_tracking_number = ${event.normalizedTrackingNumber}
              ),
              candidate_labels AS (
                SELECT label.*
                FROM wms.shipping_provider_labels AS label
                WHERE label.provider = ${event.provider}
                  AND (
                    label.id IN (SELECT id FROM exact_identity)
                    OR (
                      NOT EXISTS (SELECT 1 FROM provider_identity)
                      AND label.normalized_tracking_number = ${event.normalizedTrackingNumber}
                    )
                  )
              )
              SELECT
                label.id AS shipping_provider_label_id,
                label.provider_label_id,
                label.label_direction,
                label.label_status,
                label.carrier,
                label.service_code,
                COUNT(DISTINCT link.id)::integer AS link_count,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT wms_order.order_number), NULL) AS order_numbers
              FROM candidate_labels AS label
              LEFT JOIN wms.shipping_provider_label_links AS link
                ON link.shipping_provider_label_id = label.id
              LEFT JOIN wms.shipment_requests AS direct_request
                ON direct_request.id = link.shipment_request_id
              LEFT JOIN wms.shipping_engine_orders AS engine_order
                ON engine_order.id = link.shipping_engine_order_id
              LEFT JOIN wms.shipment_requests AS engine_request
                ON engine_request.id = engine_order.shipment_request_id
              LEFT JOIN wms.physical_shipments AS physical
                ON physical.id = link.physical_shipment_id
              LEFT JOIN wms.shipment_requests AS physical_request
                ON physical_request.id = physical.shipment_request_id
              LEFT JOIN wms.outbound_shipments AS legacy
                ON legacy.id = link.legacy_wms_shipment_id
              LEFT JOIN wms.orders AS wms_order
                ON wms_order.id = COALESCE(
                  direct_request.wms_order_id,
                  engine_request.wms_order_id,
                  physical_request.wms_order_id,
                  legacy.order_id
                )
              GROUP BY
                label.id,
                label.provider_label_id,
                label.label_direction,
                label.label_status,
                label.carrier,
                label.service_code
              ORDER BY label.id
            `);
            return resultRows(labelResult).map(candidateFromRow);
          },

          async appendMatchAttempt(eventId, resolution, shippingProviderLabelId, createdAt) {
            const inserted = await databaseTx
              .insert(carrierTrackingEventMatches)
              .values({
                carrierTrackingEventId: eventId,
                attemptHash: resolution.attemptHash,
                matchStatus: resolution.status,
                candidateCount: resolution.candidateCount,
                shippingProviderLabelId,
                reasonCode: resolution.reasonCode,
                evidence: {
                  candidates: resolution.candidates.map(candidateEvidence),
                },
                createdAt,
              })
              .onConflictDoNothing({
                target: [
                  carrierTrackingEventMatches.carrierTrackingEventId,
                  carrierTrackingEventMatches.attemptHash,
                ],
              })
              .returning({ id: carrierTrackingEventMatches.id });
            if (inserted[0]) {
              return { id: inserted[0].id, inserted: true, shippingProviderLabelId };
            }
            const existing = await databaseTx
              .select({
                id: carrierTrackingEventMatches.id,
                shippingProviderLabelId: carrierTrackingEventMatches.shippingProviderLabelId,
              })
              .from(carrierTrackingEventMatches)
              .where(and(
                eq(carrierTrackingEventMatches.carrierTrackingEventId, eventId),
                eq(carrierTrackingEventMatches.attemptHash, resolution.attemptHash),
              ))
              .limit(1);
            if (!existing[0]) {
              throw new Error("Carrier tracking match conflict could not be re-read");
            }
            return {
              id: requiredId(existing[0].id, "carrier_tracking_event_match_id"),
              inserted: false,
              shippingProviderLabelId: integerOrNull(
                existing[0].shippingProviderLabelId,
                "shipping_provider_label_id",
              ),
            };
          },

          async markEventReconciled(eventId, matchAttemptId, resolution, reconciledAt) {
            const matchedWithoutLineage =
              resolution.status === "matched"
              && resolution.selectedCandidate?.labelDirection === "outbound"
              && (resolution.selectedCandidate.linkCount ?? 0) === 0;
            const nextReconcileAt =
              ["unmatched", "ambiguous", "review"].includes(resolution.status)
              || matchedWithoutLineage
              ? new Date(reconciledAt.getTime() + 30 * 60 * 1_000)
              : null;
            await databaseTx
              .insert(carrierTrackingReconciliationState)
              .values({
                carrierTrackingEventId: eventId,
                lastMatchAttemptId: matchAttemptId,
                lastMatchAttemptHash: resolution.attemptHash,
                lastMatchStatus: resolution.status,
                lastCandidateCount: resolution.candidateCount,
                lastReconciledAt: reconciledAt,
                nextReconcileAt,
                updatedAt: reconciledAt,
              })
              .onConflictDoUpdate({
                target: carrierTrackingReconciliationState.carrierTrackingEventId,
                set: {
                  lastMatchAttemptId: matchAttemptId,
                  lastMatchAttemptHash: resolution.attemptHash,
                  lastMatchStatus: resolution.status,
                  lastCandidateCount: resolution.candidateCount,
                  lastReconciledAt: reconciledAt,
                  nextReconcileAt,
                  updatedAt: reconciledAt,
                },
              });
          },

          async enqueueDispatchCommand(
            eventId,
            shippingProviderLabelId,
            dispatchOccurredAt,
            createdAt,
          ) {
            const labelResult = await databaseTx.execute(sql`
              SELECT label_direction
              FROM wms.shipping_provider_labels
              WHERE id = ${shippingProviderLabelId}
              FOR UPDATE
            `);
            const currentLabelDirection = labelDirection(
              resultRows(labelResult)[0]?.label_direction,
            );
            if (currentLabelDirection !== "outbound") {
              throw new Error("Return labels cannot enqueue outbound carrier dispatch commands");
            }

            const commandKey =
              `carrier-dispatch:shipping-provider-label:${shippingProviderLabelId}`;
            const inserted = await databaseTx
              .insert(carrierDispatchCommands)
              .values({
                shippingProviderLabelId,
                carrierTrackingEventId: eventId,
                commandKey,
                source: "carrier_tracking_reconciler",
                createdBy: "system:carrier_tracking",
                status: "pending",
                dispatchOccurredAt,
                createdAt,
                updatedAt: createdAt,
              })
              .onConflictDoNothing({
                target: carrierDispatchCommands.shippingProviderLabelId,
              })
              .returning({
                id: carrierDispatchCommands.id,
                status: carrierDispatchCommands.status,
              });
            if (inserted[0]) {
              return {
                id: requiredId(inserted[0].id, "carrier_dispatch_command_id"),
                inserted: true,
                status: requiredString(inserted[0].status, "carrier_dispatch_status"),
              };
            }

            const existing = await databaseTx
              .select({
                id: carrierDispatchCommands.id,
                status: carrierDispatchCommands.status,
              })
              .from(carrierDispatchCommands)
              .where(eq(
                carrierDispatchCommands.shippingProviderLabelId,
                shippingProviderLabelId,
              ))
              .limit(1);
            if (!existing[0]) {
              throw new Error("Carrier-dispatch command conflict could not be re-read");
            }
            return {
              id: requiredId(existing[0].id, "carrier_dispatch_command_id"),
              inserted: false,
              status: requiredString(existing[0].status, "carrier_dispatch_status"),
            };
          },
        };
        return work(tx);
      });
    },
  };
}
