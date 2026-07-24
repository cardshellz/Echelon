import {
  CARRIER_TRACKING_PARSER_VERSION,
  CarrierTrackingPayloadError,
  normalizeShipStationLabelObservation,
  normalizeShipStationTrackingWebhook,
  resolveCarrierTrackingMatch,
  type CarrierDispatchEvidence,
  type CarrierTrackingMatchStatus,
  type NormalizedCarrierTrackingEvent,
  type VerifiedCarrierWebhookReceipt,
} from "./carrier-tracking.domain";
import type {
  CarrierTrackingRepository,
  ClaimedCarrierTrackingWebhookHydration,
  ClaimedCarrierTrackingSubscription,
  ShippingProviderLabelLinkResult,
  StoredCarrierDispatchAttempt,
  StoredCarrierTrackingEvent,
  StoredShippingProviderLabelObservation,
} from "./carrier-tracking.repository";
import {
  CarrierDispatchAuthorityError,
  type CarrierDispatchAuthority,
} from "./carrier-dispatch-authority";
import {
  isRetryableTrackingSubscriptionError,
  trackingSubscriptionErrorEvidence,
  type ShipStationTrackingSubscriptionsClient,
} from "./shipstation-tracking-subscriptions.client";
import {
  createShipStationTrackingHydrationRequest,
  isRetryableTrackingEventsError,
  parseShipStationTrackingResourceUrl,
  ShipStationTrackingEventsError,
  trackingEventsErrorEvidence,
  type ShipStationTrackingEventsClient,
  type ShipStationTrackingIdentity,
  type ShipStationTrackingHydrationRequest,
} from "./shipstation-tracking-events.client";

const DEFAULT_RECONCILIATION_LIMIT = 100;
const DEFAULT_SUBSCRIPTION_BATCH_LIMIT = 25;
// Covers 25 serialized provider calls at the 15-second client timeout, pacing,
// and transactional finalization without allowing another worker to reclaim them.
const PROVIDER_BATCH_LEASE_MS = 10 * 60 * 1_000;
const SUBSCRIPTION_RETRY_BASE_MS = 5 * 60 * 1_000;
const SUBSCRIPTION_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;
const SUBSCRIPTION_MAX_CONSECUTIVE_FAILURES = 8;
const HYDRATION_RETRY_BASE_MS = 5 * 60 * 1_000;
const HYDRATION_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;
const HYDRATION_MAX_CONSECUTIVE_FAILURES = 8;
const DEFAULT_DISPATCH_BATCH_LIMIT = 25;
const DISPATCH_BATCH_LEASE_MS = 10 * 60 * 1_000;
const DISPATCH_RETRY_BASE_MS = 5 * 60 * 1_000;
const DISPATCH_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;
const DISPATCH_MAX_CONSECUTIVE_FAILURES = 8;

export interface CarrierTrackingClock {
  now(): Date;
}

export interface CarrierTrackingLogEvent {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface CarrierTrackingLogger {
  info(event: CarrierTrackingLogEvent): void;
  warn(event: CarrierTrackingLogEvent): void;
  error(event: CarrierTrackingLogEvent): void;
}

export interface CarrierTrackingNormalizedIngestResult {
  ingestStatus: "normalized";
  eventId: number;
  eventInserted: boolean;
  webhookReceiptId: number | null;
  webhookReceiptInserted: boolean;
  parseAttemptId: number | null;
  parseAttemptInserted: boolean;
  matchAttemptId: number | null;
  matchAttemptInserted: boolean;
  matchStatus: CarrierTrackingMatchStatus | "pending";
  matchReasonCode: string | null;
  candidateCount: number;
  shippingProviderLabelId: number | null;
  dispatchEvidence: CarrierDispatchEvidence;
  dispatchCommandId: number | null;
  dispatchCommandInserted: boolean;
}

export interface CarrierTrackingRejectedIngestResult {
  ingestStatus: "rejected";
  eventId: null;
  eventInserted: false;
  webhookReceiptId: number;
  webhookReceiptInserted: boolean;
  parseAttemptId: number;
  parseAttemptInserted: boolean;
  reasonCode: string;
  hydrationPrepared: boolean;
}

export type CarrierTrackingIngestResult =
  | CarrierTrackingNormalizedIngestResult
  | CarrierTrackingRejectedIngestResult;

export interface CarrierTrackingReconciliationResult {
  hydrationsClaimed: number;
  hydrationsCompleted: number;
  hydrationsRetryScheduled: number;
  hydrationsReviewRequired: number;
  hydrationClientConfigured: boolean;
  subscriptionsPrepared: number;
  subscriptionLabelLinksPrepared: number;
  subscriptionsClaimed: number;
  subscriptionsActivated: number;
  subscriptionsRetryScheduled: number;
  subscriptionsReviewRequired: number;
  subscriptionClientConfigured: boolean;
  labelsScanned: number;
  labelsLinked: number;
  scanned: number;
  matched: number;
  unresolved: number;
  attemptsAppended: number;
  dispatchCommandsClaimed: number;
  dispatchCommandsSucceeded: number;
  dispatchCommandsRetryScheduled: number;
  dispatchCommandsReviewRequired: number;
  dispatchAuthorityConfigured: boolean;
  errors: number;
}

export interface CarrierDispatchSweepResult {
  dispatchCommandsClaimed: number;
  dispatchCommandsSucceeded: number;
  dispatchCommandsRetryScheduled: number;
  dispatchCommandsReviewRequired: number;
  dispatchAuthorityConfigured: boolean;
  errors: number;
}

export type CarrierTrackingHydrationSweepResult = Pick<
  CarrierTrackingReconciliationResult,
  | "hydrationsClaimed"
  | "hydrationsCompleted"
  | "hydrationsRetryScheduled"
  | "hydrationsReviewRequired"
  | "hydrationClientConfigured"
  | "errors"
>;

export type CarrierTrackingSubscriptionSweepResult = Pick<
  CarrierTrackingReconciliationResult,
  | "subscriptionsPrepared"
  | "subscriptionLabelLinksPrepared"
  | "subscriptionsClaimed"
  | "subscriptionsActivated"
  | "subscriptionsRetryScheduled"
  | "subscriptionsReviewRequired"
  | "subscriptionClientConfigured"
  | "errors"
>;

export interface ShippingProviderLabelObserver {
  observeShipStationLabel(rawShipment: unknown): Promise<StoredShippingProviderLabelObservation>;
}

export class CarrierTrackingService implements ShippingProviderLabelObserver {
  constructor(
    private readonly dependencies: {
      repository: CarrierTrackingRepository;
      clock: CarrierTrackingClock;
      logger: CarrierTrackingLogger;
      subscriptionClient?: ShipStationTrackingSubscriptionsClient;
      subscriptionLeaseOwner?: string;
      trackingEventsClient?: ShipStationTrackingEventsClient;
      hydrationLeaseOwner?: string;
      dispatchAuthority?: CarrierDispatchAuthority;
      dispatchLeaseOwner?: string;
    },
  ) {}

  async observeShipStationLabel(
    rawShipment: unknown,
  ): Promise<StoredShippingProviderLabelObservation> {
    const observation = normalizeShipStationLabelObservation(
      rawShipment,
      this.dependencies.clock.now(),
    );
    const result = await this.dependencies.repository.observeProviderLabel(observation);
    this.dependencies.logger.info({
      code: "SHIPPING_PROVIDER_LABEL_OBSERVED",
      message: "Shipping-provider label evidence was durably recorded.",
      context: {
        provider: observation.provider,
        providerLabelId: observation.providerLabelId,
        trackingSuffix: trackingSuffix(observation.normalizedTrackingNumber),
        labelStatus: observation.labelStatus,
        labelInserted: result.labelInserted,
        eventInserted: result.eventInserted,
      },
    });
    return result;
  }

  async reconcileShipStationLabel(
    providerLabelId: string,
  ): Promise<ShippingProviderLabelLinkResult> {
    const result = await this.dependencies.repository.reconcileProviderLabelLinks(
      "shipstation",
      providerLabelId,
      this.dependencies.clock.now(),
    );
    this.dependencies.logger.info({
      code: "SHIPPING_PROVIDER_LABEL_LINKS_RECONCILED",
      message: "Shipping-provider label links were reconciled against canonical shipment identities.",
      context: {
        provider: "shipstation",
        providerLabelId,
        linksInserted: result.linksInserted,
        totalLinks: result.totalLinks,
      },
    });
    return result;
  }

  async hydrateShipStationTrackingIdentity(
    input: ShipStationTrackingIdentity,
  ): Promise<CarrierTrackingNormalizedIngestResult> {
    const client = this.dependencies.trackingEventsClient;
    if (!client?.isConfigured()) {
      throw new ShipStationTrackingEventsError(
        "CONFIGURATION",
        "SHIPSTATION_V2_API_KEY is required to hydrate carrier tracking evidence",
      );
    }

    const request = createShipStationTrackingHydrationRequest(input);
    const snapshot = await client.getTrackingSnapshot(request);
    const event = normalizeTrackingSnapshot(
      snapshot.payload,
      request,
      this.dependencies.clock.now(),
    );
    const result = await this.persistAndMatch(event);
    this.logResult("CARRIER_TRACKING_PROVIDER_SNAPSHOT_INGESTED", event, result);
    return result;
  }

  async ingestShipStationWebhook(
    rawPayload: unknown,
    receipt: VerifiedCarrierWebhookReceipt,
  ): Promise<CarrierTrackingIngestResult> {
    const storedReceipt = await this.dependencies.repository.persistVerifiedWebhookReceipt(receipt);
    let event: NormalizedCarrierTrackingEvent;
    try {
      event = normalizeShipStationTrackingWebhook(rawPayload, receipt.verifiedAt);
    } catch (error) {
      if (!(error instanceof CarrierTrackingPayloadError)) throw error;
      const hydrationPreparation = trackingHydrationPreparation(error);
      const parseAttempt = await this.dependencies.repository.persistRejectedWebhookPayload(
        storedReceipt.id,
        {
          parserVersion: CARRIER_TRACKING_PARSER_VERSION,
          reasonCode: error.code,
          details: hydrationPreparation.details,
          hydrationRequest: hydrationPreparation.request,
          createdAt: this.dependencies.clock.now(),
        },
      );
      this.dependencies.logger.warn({
        code: "CARRIER_TRACKING_WEBHOOK_PAYLOAD_REJECTED",
        message: "A verified ShipStation tracking webhook was retained but could not be normalized.",
        context: {
          webhookReceiptId: storedReceipt.id,
          webhookReceiptInserted: storedReceipt.inserted,
          parseAttemptId: parseAttempt.id,
          parseAttemptInserted: parseAttempt.inserted,
          reasonCode: error.code,
          hydrationPrepared: parseAttempt.hydrationPrepared,
          details: hydrationPreparation.details,
        },
      });
      return {
        ingestStatus: "rejected",
        eventId: null,
        eventInserted: false,
        webhookReceiptId: storedReceipt.id,
        webhookReceiptInserted: storedReceipt.inserted,
        parseAttemptId: parseAttempt.id,
        parseAttemptInserted: parseAttempt.inserted,
        reasonCode: error.code,
        hydrationPrepared: parseAttempt.hydrationPrepared,
      };
    }
    const ingress = await this.dependencies.repository.persistNormalizedWebhookEvent(
      storedReceipt.id,
      event,
      {
        parserVersion: CARRIER_TRACKING_PARSER_VERSION,
        reasonCode: "SHIPSTATION_API_TRACK_NORMALIZED",
        createdAt: this.dependencies.clock.now(),
      },
    );
    const result: CarrierTrackingNormalizedIngestResult = {
      ingestStatus: "normalized",
      eventId: ingress.event.id,
      eventInserted: ingress.event.inserted,
      webhookReceiptId: storedReceipt.id,
      webhookReceiptInserted: storedReceipt.inserted,
      parseAttemptId: ingress.parse.id,
      parseAttemptInserted: ingress.parse.inserted,
      matchAttemptId: null,
      matchAttemptInserted: false,
      matchStatus: "pending",
      matchReasonCode: null,
      candidateCount: 0,
      shippingProviderLabelId: null,
      dispatchEvidence: event.dispatchEvidence,
      dispatchCommandId: null,
      dispatchCommandInserted: false,
    };
    this.dependencies.logger.info({
      code: "CARRIER_TRACKING_WEBHOOK_INGESTED",
      message: "Authenticated carrier tracking evidence was durably recorded for asynchronous reconciliation.",
      context: {
        provider: event.provider,
        trackingSuffix: trackingSuffix(event.normalizedTrackingNumber),
        providerStatusCode: event.providerStatusCode,
        canonicalStatus: event.canonicalStatus,
        dispatchEvidence: event.dispatchEvidence,
        eventId: result.eventId,
        eventInserted: result.eventInserted,
        webhookReceiptId: result.webhookReceiptId,
        webhookReceiptInserted: result.webhookReceiptInserted,
        parseAttemptId: result.parseAttemptId,
        parseAttemptInserted: result.parseAttemptInserted,
        matchStatus: result.matchStatus,
      },
    });
    return result;
  }

  async reconcileUnresolved(
    limit: number = DEFAULT_RECONCILIATION_LIMIT,
  ): Promise<CarrierTrackingReconciliationResult> {
    const hydrationSummary = await this.hydrateWebhookPayloads(
      Math.min(limit, DEFAULT_SUBSCRIPTION_BATCH_LIMIT),
    );
    const subscriptionSummary = await this.reconcileTrackingSubscriptions(
      Math.min(limit, DEFAULT_SUBSCRIPTION_BATCH_LIMIT),
    );
    const labels = await this.dependencies.repository
      .listProviderLabelsPendingLinkReconciliation(limit, this.dependencies.clock.now());
    const events = await this.dependencies.repository.listEventsPendingReconciliation(
      limit,
      this.dependencies.clock.now(),
    );
    const summary: CarrierTrackingReconciliationResult = {
      ...hydrationSummary,
      ...subscriptionSummary,
      labelsScanned: labels.length,
      labelsLinked: 0,
      scanned: events.length,
      matched: 0,
      unresolved: 0,
      attemptsAppended: 0,
      dispatchCommandsClaimed: 0,
      dispatchCommandsSucceeded: 0,
      dispatchCommandsRetryScheduled: 0,
      dispatchCommandsReviewRequired: 0,
      dispatchAuthorityConfigured: Boolean(this.dependencies.dispatchAuthority),
      errors: hydrationSummary.errors + subscriptionSummary.errors,
    };

    for (const label of labels) {
      try {
        const result = await this.dependencies.repository.reconcileProviderLabelLinks(
          label.provider,
          label.providerLabelId,
          this.dependencies.clock.now(),
        );
        if (result.totalLinks > 0) summary.labelsLinked += 1;
      } catch (error) {
        summary.errors += 1;
        this.dependencies.logger.error({
          code: "SHIPPING_PROVIDER_LABEL_RECONCILIATION_FAILED",
          message: "A provider label could not be reconciled to canonical shipment identities.",
          context: {
            provider: label.provider,
            providerLabelId: label.providerLabelId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    for (const event of events) {
      try {
        const result = await this.persistAndMatch(event);
        if (result.matchStatus === "matched") summary.matched += 1;
        else summary.unresolved += 1;
        if (result.matchAttemptInserted) summary.attemptsAppended += 1;
        this.logResult("CARRIER_TRACKING_EVENT_RECONCILED", event, result);
      } catch (error) {
        summary.errors += 1;
        this.dependencies.logger.error({
          code: "CARRIER_TRACKING_RECONCILIATION_FAILED",
          message: "A stored carrier tracking event could not be reconciled.",
          context: {
            provider: event.provider,
            trackingSuffix: trackingSuffix(event.normalizedTrackingNumber),
            eventHashPrefix: event.eventHash.slice(0, 12),
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    const dispatchSummary = await this.dispatchConfirmedPackages(
      Math.min(limit, DEFAULT_DISPATCH_BATCH_LIMIT),
    );
    summary.dispatchCommandsClaimed = dispatchSummary.dispatchCommandsClaimed;
    summary.dispatchCommandsSucceeded = dispatchSummary.dispatchCommandsSucceeded;
    summary.dispatchCommandsRetryScheduled =
      dispatchSummary.dispatchCommandsRetryScheduled;
    summary.dispatchCommandsReviewRequired =
      dispatchSummary.dispatchCommandsReviewRequired;
    summary.dispatchAuthorityConfigured =
      dispatchSummary.dispatchAuthorityConfigured;
    summary.errors += dispatchSummary.errors;

    return summary;
  }

  async dispatchConfirmedPackages(
    limit: number = DEFAULT_DISPATCH_BATCH_LIMIT,
  ): Promise<CarrierDispatchSweepResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error("Carrier-dispatch sweep limit must be an integer between 1 and 100");
    }

    const authority = this.dependencies.dispatchAuthority;
    const summary: CarrierDispatchSweepResult = {
      dispatchCommandsClaimed: 0,
      dispatchCommandsSucceeded: 0,
      dispatchCommandsRetryScheduled: 0,
      dispatchCommandsReviewRequired: 0,
      dispatchAuthorityConfigured: Boolean(authority),
      errors: 0,
    };
    if (!authority) return summary;

    const asOf = this.dependencies.clock.now();
    const leaseOwner =
      this.dependencies.dispatchLeaseOwner ?? defaultCarrierDispatchLeaseOwner();
    const commands = await this.dependencies.repository.claimDispatchCommands(
      limit,
      asOf,
      leaseOwner,
      new Date(asOf.getTime() + DISPATCH_BATCH_LEASE_MS),
    );
    summary.dispatchCommandsClaimed = commands.length;

    for (const command of commands) {
      const requestEvidence = {
        commandId: command.id,
        shippingProviderLabelId: command.shippingProviderLabelId,
        carrierTrackingEventId: command.carrierTrackingEventId,
        provider: command.provider,
        providerLabelId: command.providerLabelId,
        providerOrderId: command.providerOrderId,
        providerOrderKey: command.providerOrderKey,
        trackingSuffix: trackingSuffix(command.normalizedTrackingNumber),
        dispatchOccurredAt: command.dispatchOccurredAt.toISOString(),
      };

      let requestedOutcome: StoredCarrierDispatchAttempt["outcome"];
      let errorCode: string | null;
      let errorMessage: string | null;
      let responseEvidence: Record<string, unknown>;
      let nextAttemptAt: Date | null;

      try {
        const result = await authority.confirmDispatch({
          commandId: command.id,
          shippingProviderLabelId: command.shippingProviderLabelId,
          carrierTrackingEventId: command.carrierTrackingEventId,
          provider: command.provider,
          providerLabelId: command.providerLabelId,
          providerOrderId: command.providerOrderId,
          providerOrderKey: command.providerOrderKey,
          trackingNumber: command.trackingNumber,
          normalizedTrackingNumber: command.normalizedTrackingNumber,
          carrier: command.carrier,
          serviceCode: command.serviceCode,
          dispatchOccurredAt: command.dispatchOccurredAt,
        });
        if (!result.processed) {
          throw new CarrierDispatchAuthorityError(
            "CARRIER_DISPATCH_NOT_APPLIED",
            "Carrier dispatch authority did not apply the confirmed package",
            {
              retryable: false,
              context: {
                commandId: command.id,
                providerLabelId: command.providerLabelId,
              },
            },
          );
        }

        requestedOutcome = "succeeded";
        errorCode = null;
        errorMessage = null;
        responseEvidence = { ...result.evidence, processed: true };
        nextAttemptAt = null;
      } catch (error) {
        const evidence = carrierDispatchErrorEvidence(error);
        const consecutiveFailureCount = command.consecutiveFailureCount + 1;
        const retryable =
          evidence.retryable
          && consecutiveFailureCount < DISPATCH_MAX_CONSECUTIVE_FAILURES;
        const completedAt = this.dependencies.clock.now();
        const retryAt = retryable
          ? new Date(
              completedAt.getTime()
              + carrierDispatchRetryDelayMs(consecutiveFailureCount),
            )
          : null;
        requestedOutcome = retryable ? "retry_scheduled" : "review_required";
        errorCode = evidence.code;
        errorMessage = evidence.message;
        responseEvidence = evidence.context;
        nextAttemptAt = retryAt;
      }

      const completedAt = this.dependencies.clock.now();
      try {
        const finalized =
          await this.dependencies.repository.finalizeDispatchAttempt({
            commandId: command.id,
            attemptNumber: command.attemptNumber,
            leaseOwner: command.leaseOwner,
            outcome: requestedOutcome,
            errorCode,
            errorMessage,
            requestEvidence,
            responseEvidence,
            startedAt: command.startedAt,
            completedAt,
            nextAttemptAt,
          });
        incrementCarrierDispatchOutcome(summary, finalized.outcome);
        const logEvent = carrierDispatchOutcomeLog(finalized.outcome);
        this.dependencies.logger[logEvent.level]({
          code: logEvent.code,
          message: logEvent.message,
          context: {
            ...requestEvidence,
            attemptNumber: command.attemptNumber,
            attemptedOutcome: requestedOutcome,
            persistedOutcome: finalized.outcome,
            replayedAttempt: !finalized.inserted,
            errorCode,
            errorMessage,
            nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
          },
        });
      } catch (finalizationError) {
        summary.errors += 1;
        this.dependencies.logger.error({
          code: "CARRIER_DISPATCH_COMMAND_FINALIZATION_FAILED",
          message: "A carrier dispatch attempt could not be durably finalized.",
          context: {
            ...requestEvidence,
            attemptNumber: command.attemptNumber,
            attemptedOutcome: requestedOutcome,
            authorityErrorCode: errorCode,
            finalizationError: finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError),
          },
        });
      }
    }

    return summary;
  }

  async hydrateWebhookPayloads(
    limit: number = DEFAULT_SUBSCRIPTION_BATCH_LIMIT,
  ): Promise<CarrierTrackingHydrationSweepResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error("Tracking hydration sweep limit must be an integer between 1 and 100");
    }
    const client = this.dependencies.trackingEventsClient;
    const summary: CarrierTrackingHydrationSweepResult = {
      hydrationsClaimed: 0,
      hydrationsCompleted: 0,
      hydrationsRetryScheduled: 0,
      hydrationsReviewRequired: 0,
      hydrationClientConfigured: Boolean(client?.isConfigured()),
      errors: 0,
    };
    if (!client?.isConfigured()) return summary;

    const asOf = this.dependencies.clock.now();
    const leaseOwner = this.dependencies.hydrationLeaseOwner?.trim()
      || defaultTrackingHydrationLeaseOwner();
    const claimed = await this.dependencies.repository.claimWebhookHydrations(
      limit,
      asOf,
      leaseOwner,
      new Date(asOf.getTime() + PROVIDER_BATCH_LEASE_MS),
    );
    summary.hydrationsClaimed = claimed.length;

    for (const hydration of claimed) {
      let event: NormalizedCarrierTrackingEvent | null = null;
      let providerError: unknown = null;
      try {
        const request = {
          resourceUrl: hydration.resourceUrl,
          carrierCode: hydration.carrierCode,
          trackingNumber: hydration.trackingNumber,
          normalizedTrackingNumber: hydration.normalizedTrackingNumber,
        };
        const snapshot = await client.getTrackingSnapshot(request);
        event = normalizeTrackingSnapshot(
          snapshot.payload,
          request,
          hydration.webhookVerifiedAt,
        );
      } catch (error) {
        providerError = error;
      }

      if (event) {
        const completedAt = this.dependencies.clock.now();
        try {
          const finalized = await this.dependencies.repository.finalizeWebhookHydrationAttempt({
            receiptId: hydration.receiptId,
            attemptNumber: hydration.attemptNumber,
            leaseOwner: hydration.leaseOwner,
            outcome: "hydrated",
            httpStatus: 200,
            errorCode: null,
            errorMessage: null,
            requestEvidence: trackingHydrationRequestEvidence(hydration),
            responseEvidence: {
              httpStatus: 200,
              eventHash: event.eventHash,
              payloadHash: event.payloadHash,
              providerStatusCode: event.providerStatusCode,
            },
            startedAt: hydration.startedAt,
            completedAt,
            nextAttemptAt: null,
            event,
            parserVersion: CARRIER_TRACKING_PARSER_VERSION,
            parseReasonCode: "SHIPSTATION_API_TRACK_RESOURCE_HYDRATED",
          });
          summary.hydrationsCompleted += 1;
          this.logTrackingHydrationResult("CARRIER_TRACKING_WEBHOOK_HYDRATED", hydration, {
            attemptNumber: hydration.attemptNumber,
            eventId: finalized.eventId,
            eventInserted: finalized.eventInserted,
            parseAttemptId: finalized.parseAttemptId,
            parseAttemptInserted: finalized.parseAttemptInserted,
          });
        } catch (finalizationError) {
          summary.errors += 1;
          this.dependencies.logger.error({
            code: "CARRIER_TRACKING_HYDRATION_FINALIZATION_FAILED",
            message: "A successful carrier tracking hydration could not be durably finalized.",
            context: {
              webhookReceiptId: hydration.receiptId,
              attemptNumber: hydration.attemptNumber,
              finalizationError: finalizationError instanceof Error
                ? finalizationError.message
                : String(finalizationError),
            },
          });
        }
        continue;
      }

      const completedAt = this.dependencies.clock.now();
      const evidence = trackingEventsErrorEvidence(providerError);
      const nextFailureCount = hydration.consecutiveFailureCount + 1;
      const retryable = isRetryableTrackingEventsError(providerError)
        && nextFailureCount < HYDRATION_MAX_CONSECUTIVE_FAILURES;
      const nextAttemptAt = retryable
        ? new Date(completedAt.getTime() + trackingHydrationRetryDelayMs(nextFailureCount))
        : null;
      try {
        await this.dependencies.repository.finalizeWebhookHydrationAttempt({
          receiptId: hydration.receiptId,
          attemptNumber: hydration.attemptNumber,
          leaseOwner: hydration.leaseOwner,
          outcome: retryable ? "retry_scheduled" : "review_required",
          httpStatus: evidence.httpStatus,
          errorCode: evidence.code,
          errorMessage: evidence.message,
          requestEvidence: trackingHydrationRequestEvidence(hydration),
          responseEvidence: evidence.details,
          startedAt: hydration.startedAt,
          completedAt,
          nextAttemptAt,
          event: null,
          parserVersion: CARRIER_TRACKING_PARSER_VERSION,
          parseReasonCode: "SHIPSTATION_API_TRACK_RESOURCE_HYDRATED",
        });
        if (retryable) summary.hydrationsRetryScheduled += 1;
        else summary.hydrationsReviewRequired += 1;
        this.logTrackingHydrationResult(
          retryable
            ? "CARRIER_TRACKING_HYDRATION_RETRY_SCHEDULED"
            : "CARRIER_TRACKING_HYDRATION_REVIEW_REQUIRED",
          hydration,
          {
            attemptNumber: hydration.attemptNumber,
            errorCode: evidence.code,
            httpStatus: evidence.httpStatus,
            nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
          },
          "warn",
        );
      } catch (finalizationError) {
        summary.errors += 1;
        this.dependencies.logger.error({
          code: "CARRIER_TRACKING_HYDRATION_FINALIZATION_FAILED",
          message: "A failed carrier tracking hydration could not be durably finalized.",
          context: {
            webhookReceiptId: hydration.receiptId,
            attemptNumber: hydration.attemptNumber,
            providerErrorCode: evidence.code,
            finalizationError: finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError),
          },
        });
      }
    }

    return summary;
  }

  async reconcileTrackingSubscriptions(
    limit: number = DEFAULT_SUBSCRIPTION_BATCH_LIMIT,
  ): Promise<CarrierTrackingSubscriptionSweepResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error("Tracking-subscription sweep limit must be an integer between 1 and 100");
    }
    const client = this.dependencies.subscriptionClient;
    const summary = {
      subscriptionsPrepared: 0,
      subscriptionLabelLinksPrepared: 0,
      subscriptionsClaimed: 0,
      subscriptionsActivated: 0,
      subscriptionsRetryScheduled: 0,
      subscriptionsReviewRequired: 0,
      subscriptionClientConfigured: Boolean(client?.isConfigured()),
      errors: 0,
    };
    if (!client?.isConfigured()) return summary;

    const asOf = this.dependencies.clock.now();
    const prepared = await this.dependencies.repository.prepareTrackingSubscriptions(limit, asOf);
    summary.subscriptionsPrepared = prepared.subscriptionsInserted;
    summary.subscriptionLabelLinksPrepared = prepared.labelLinksInserted;

    const leaseOwner = this.dependencies.subscriptionLeaseOwner?.trim()
      || defaultTrackingSubscriptionLeaseOwner();
    const claimed = await this.dependencies.repository.claimTrackingSubscriptions(
      limit,
      asOf,
      leaseOwner,
      new Date(asOf.getTime() + PROVIDER_BATCH_LEASE_MS),
    );
    summary.subscriptionsClaimed = claimed.length;

    for (const subscription of claimed) {
      let providerError: unknown = null;
      try {
        await client.startTracking({
          carrierCode: subscription.carrierCode,
          trackingNumber: subscription.trackingNumber,
        });
      } catch (error) {
        providerError = error;
      }

      if (providerError === null) {
        const completedAt = this.dependencies.clock.now();
        try {
          await this.dependencies.repository.finalizeTrackingSubscriptionAttempt({
            subscriptionId: subscription.id,
            attemptNumber: subscription.attemptNumber,
            leaseOwner: subscription.leaseOwner,
            outcome: "activated",
            httpStatus: 204,
            errorCode: null,
            errorMessage: null,
            requestEvidence: trackingSubscriptionRequestEvidence(subscription),
            responseEvidence: { httpStatus: 204 },
            startedAt: subscription.startedAt,
            completedAt,
            nextAttemptAt: null,
          });
          summary.subscriptionsActivated += 1;
          this.logTrackingSubscriptionResult("CARRIER_TRACKING_SUBSCRIPTION_ACTIVATED", subscription, {
            attemptNumber: subscription.attemptNumber,
            httpStatus: 204,
          });
        } catch (finalizationError) {
          summary.errors += 1;
          this.dependencies.logger.error({
            code: "CARRIER_TRACKING_SUBSCRIPTION_FINALIZATION_FAILED",
            message: "A successful tracking subscription could not be durably finalized.",
            context: {
              subscriptionId: subscription.id,
              attemptNumber: subscription.attemptNumber,
              providerHttpStatus: 204,
              finalizationError: finalizationError instanceof Error
                ? finalizationError.message
                : String(finalizationError),
            },
          });
        }
        continue;
      }

      const completedAt = this.dependencies.clock.now();
      const evidence = trackingSubscriptionErrorEvidence(providerError);
      const nextFailureCount = subscription.consecutiveFailureCount + 1;
      const retryable = isRetryableTrackingSubscriptionError(providerError)
        && nextFailureCount < SUBSCRIPTION_MAX_CONSECUTIVE_FAILURES;
      const nextAttemptAt = retryable
        ? new Date(completedAt.getTime() + trackingSubscriptionRetryDelayMs(
          nextFailureCount,
        ))
        : null;
      try {
        await this.dependencies.repository.finalizeTrackingSubscriptionAttempt({
          subscriptionId: subscription.id,
          attemptNumber: subscription.attemptNumber,
          leaseOwner: subscription.leaseOwner,
          outcome: retryable ? "retry_scheduled" : "review_required",
          httpStatus: evidence.httpStatus,
          errorCode: evidence.code,
          errorMessage: evidence.message,
          requestEvidence: trackingSubscriptionRequestEvidence(subscription),
          responseEvidence: evidence.details,
          startedAt: subscription.startedAt,
          completedAt,
          nextAttemptAt,
        });
        if (retryable) summary.subscriptionsRetryScheduled += 1;
        else summary.subscriptionsReviewRequired += 1;
        this.logTrackingSubscriptionResult(
          retryable
            ? "CARRIER_TRACKING_SUBSCRIPTION_RETRY_SCHEDULED"
            : "CARRIER_TRACKING_SUBSCRIPTION_REVIEW_REQUIRED",
          subscription,
          {
            attemptNumber: subscription.attemptNumber,
            errorCode: evidence.code,
            httpStatus: evidence.httpStatus,
            nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
          },
          "warn",
        );
      } catch (finalizationError) {
        summary.errors += 1;
        this.dependencies.logger.error({
          code: "CARRIER_TRACKING_SUBSCRIPTION_FINALIZATION_FAILED",
          message: "A failed tracking subscription attempt could not be durably finalized.",
          context: {
            subscriptionId: subscription.id,
            attemptNumber: subscription.attemptNumber,
            providerErrorCode: evidence.code,
            finalizationError: finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError),
          },
        });
      }
    }

    return summary;
  }

  private async persistAndMatch(
    event: NormalizedCarrierTrackingEvent,
    persistedEvent?: StoredCarrierTrackingEvent,
  ): Promise<CarrierTrackingNormalizedIngestResult> {
    return this.dependencies.repository.transaction(async (transaction) => {
      await transaction.acquireTrackingLock(event.provider, event.normalizedTrackingNumber);
      const storedEvent = persistedEvent ?? await transaction.insertOrGetEvent(event);
      const candidates = await transaction.findMatchCandidates(event);
      const resolution = resolveCarrierTrackingMatch(candidates);

      const shippingProviderLabelId = resolution.selectedCandidate?.shippingProviderLabelId ?? null;
      const reconciledAt = this.dependencies.clock.now();

      const match = await transaction.appendMatchAttempt(
        storedEvent.id,
        resolution,
        shippingProviderLabelId,
        reconciledAt,
      );
      await transaction.markEventReconciled(
        storedEvent.id,
        match.id,
        resolution,
        reconciledAt,
      );
      const selectedCandidate = resolution.selectedCandidate;
      const dispatchCommand =
        event.dispatchEvidence === "confirmed"
        && resolution.status === "matched"
        && selectedCandidate !== null
        && selectedCandidate.linkCount > 0
        && match.shippingProviderLabelId !== null
          ? await transaction.enqueueDispatchCommand(
              storedEvent.id,
              match.shippingProviderLabelId,
              event.eventOccurredAt ?? event.receivedAt,
              reconciledAt,
            )
          : null;
      return {
        ingestStatus: "normalized",
        eventId: storedEvent.id,
        eventInserted: storedEvent.inserted,
        webhookReceiptId: null,
        webhookReceiptInserted: false,
        parseAttemptId: null,
        parseAttemptInserted: false,
        matchAttemptId: match.id,
        matchAttemptInserted: match.inserted,
        matchStatus: resolution.status,
        matchReasonCode: resolution.reasonCode,
        candidateCount: resolution.candidateCount,
        shippingProviderLabelId: match.shippingProviderLabelId,
        dispatchEvidence: event.dispatchEvidence,
        dispatchCommandId: dispatchCommand?.id ?? null,
        dispatchCommandInserted: dispatchCommand?.inserted ?? false,
      };
    });
  }

  private logResult(
    code: string,
    event: NormalizedCarrierTrackingEvent,
    result: CarrierTrackingNormalizedIngestResult,
  ): void {
    const logEvent: CarrierTrackingLogEvent = {
      code,
      message: "Carrier tracking evidence was durably recorded and classified.",
      context: {
        provider: event.provider,
        trackingSuffix: trackingSuffix(event.normalizedTrackingNumber),
        providerStatusCode: event.providerStatusCode,
        canonicalStatus: event.canonicalStatus,
        dispatchEvidence: event.dispatchEvidence,
        eventId: result.eventId,
        eventInserted: result.eventInserted,
        webhookReceiptId: result.webhookReceiptId,
        webhookReceiptInserted: result.webhookReceiptInserted,
        matchStatus: result.matchStatus,
        matchReasonCode: result.matchReasonCode,
        candidateCount: result.candidateCount,
        matchAttemptInserted: result.matchAttemptInserted,
        dispatchCommandId: result.dispatchCommandId,
        dispatchCommandInserted: result.dispatchCommandInserted,
      },
    };
    if (result.matchStatus === "matched") this.dependencies.logger.info(logEvent);
    else this.dependencies.logger.warn(logEvent);
  }

  private logTrackingSubscriptionResult(
    code: string,
    subscription: ClaimedCarrierTrackingSubscription,
    context: Record<string, unknown>,
    level: "info" | "warn" = "info",
  ): void {
    this.dependencies.logger[level]({
      code,
      message: "Carrier tracking subscription enrollment was processed.",
      context: {
        subscriptionId: subscription.id,
        trackingProvider: subscription.trackingProvider,
        carrierCode: subscription.carrierCode,
        trackingSuffix: trackingSuffix(subscription.normalizedTrackingNumber),
        ...context,
      },
    });
  }

  private logTrackingHydrationResult(
    code: string,
    hydration: ClaimedCarrierTrackingWebhookHydration,
    context: Record<string, unknown>,
    level: "info" | "warn" = "info",
  ): void {
    this.dependencies.logger[level]({
      code,
      message: "Carrier tracking webhook hydration was processed.",
      context: {
        webhookReceiptId: hydration.receiptId,
        carrierCode: hydration.carrierCode,
        trackingSuffix: trackingSuffix(hydration.normalizedTrackingNumber),
        ...context,
      },
    });
  }
}

export const systemCarrierTrackingClock: CarrierTrackingClock = {
  now: () => new Date(),
};

export function makeCarrierTrackingLogger(): CarrierTrackingLogger {
  const write = (level: "info" | "warn" | "error", event: CarrierTrackingLogEvent): void => {
    console[level](JSON.stringify({
      level,
      component: "carrier_tracking",
      ...event,
    }));
  };
  return {
    info: (event) => write("info", event),
    warn: (event) => write("warn", event),
    error: (event) => write("error", event),
  };
}

function trackingSuffix(normalizedTrackingNumber: string): string {
  return normalizedTrackingNumber.slice(-6);
}

function normalizeTrackingSnapshot(
  payload: Record<string, unknown>,
  request: ShipStationTrackingHydrationRequest,
  observedAt: Date,
): NormalizedCarrierTrackingEvent {
  let event: NormalizedCarrierTrackingEvent;
  try {
    event = normalizeShipStationTrackingWebhook({
      resource_type: "API_TRACK",
      resource_url: request.resourceUrl,
      data: payload,
    }, observedAt);
  } catch (error) {
    if (!(error instanceof CarrierTrackingPayloadError)) throw error;
    throw new ShipStationTrackingEventsError(
      "INVALID_RESPONSE",
      "ShipStation tracking hydration response failed normalization",
      { parserCode: error.code, parserDetails: error.details },
    );
  }
  if (
    event.normalizedTrackingNumber !== request.normalizedTrackingNumber
    || event.carrier !== request.carrierCode
  ) {
    throw new ShipStationTrackingEventsError(
      "INVALID_RESPONSE",
      "ShipStation tracking hydration response returned a different tracking identity",
      {
        requestedTrackingSuffix: trackingSuffix(request.normalizedTrackingNumber),
        returnedTrackingSuffix: trackingSuffix(event.normalizedTrackingNumber),
        requestedCarrierCode: request.carrierCode,
        returnedCarrierCode: event.carrier,
      },
    );
  }
  return event;
}

function trackingSubscriptionRequestEvidence(
  subscription: ClaimedCarrierTrackingSubscription,
): Record<string, unknown> {
  return {
    trackingProvider: subscription.trackingProvider,
    carrierCode: subscription.carrierCode,
    trackingNumber: subscription.trackingNumber,
  };
}

function trackingSubscriptionRetryDelayMs(consecutiveFailureCount: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailureCount - 1, 6));
  return Math.min(SUBSCRIPTION_RETRY_BASE_MS * (2 ** exponent), SUBSCRIPTION_RETRY_MAX_MS);
}

function trackingHydrationPreparation(error: CarrierTrackingPayloadError): {
  request?: ShipStationTrackingHydrationRequest;
  details: Record<string, unknown>;
} {
  if (error.code !== "SHIPSTATION_TRACKING_DATA_MISSING") {
    return { details: error.details };
  }
  const resourceUrl = typeof error.details.resourceUrl === "string"
    ? error.details.resourceUrl
    : "";
  try {
    return {
      request: parseShipStationTrackingResourceUrl(resourceUrl),
      details: { ...error.details, hydrationDisposition: "scheduled" },
    };
  } catch (hydrationError) {
    const evidence = trackingEventsErrorEvidence(hydrationError);
    return {
      details: {
        ...error.details,
        hydrationDisposition: "review_required",
        hydrationErrorCode: evidence.code,
        hydrationErrorMessage: evidence.message,
        hydrationErrorDetails: evidence.details,
      },
    };
  }
}

function trackingHydrationRequestEvidence(
  hydration: ClaimedCarrierTrackingWebhookHydration,
): Record<string, unknown> {
  const resourceUrl = new URL(hydration.resourceUrl);
  return {
    resourceOrigin: resourceUrl.origin,
    resourcePath: resourceUrl.pathname,
    carrierCode: hydration.carrierCode,
    trackingNumber: hydration.trackingNumber,
  };
}

function trackingHydrationRetryDelayMs(consecutiveFailureCount: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailureCount - 1, 6));
  return Math.min(HYDRATION_RETRY_BASE_MS * (2 ** exponent), HYDRATION_RETRY_MAX_MS);
}

function carrierDispatchRetryDelayMs(consecutiveFailureCount: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailureCount - 1, 6));
  return Math.min(DISPATCH_RETRY_BASE_MS * (2 ** exponent), DISPATCH_RETRY_MAX_MS);
}

function incrementCarrierDispatchOutcome(
  summary: CarrierDispatchSweepResult,
  outcome: StoredCarrierDispatchAttempt["outcome"],
): void {
  if (outcome === "succeeded") {
    summary.dispatchCommandsSucceeded += 1;
    return;
  }
  if (outcome === "retry_scheduled") {
    summary.dispatchCommandsRetryScheduled += 1;
    return;
  }
  summary.dispatchCommandsReviewRequired += 1;
}

function carrierDispatchOutcomeLog(
  outcome: StoredCarrierDispatchAttempt["outcome"],
): {
  level: "info" | "warn";
  code: string;
  message: string;
} {
  if (outcome === "succeeded") {
    return {
      level: "info",
      code: "CARRIER_DISPATCH_COMMAND_SUCCEEDED",
      message: "Confirmed carrier possession was promoted into physical shipment authority.",
    };
  }
  if (outcome === "retry_scheduled") {
    return {
      level: "warn",
      code: "CARRIER_DISPATCH_COMMAND_RETRY_SCHEDULED",
      message: "Carrier dispatch promotion failed transiently and was scheduled for retry.",
    };
  }
  return {
    level: "warn",
    code: "CARRIER_DISPATCH_COMMAND_REVIEW_REQUIRED",
    message: "Carrier dispatch promotion requires operator review.",
  };
}

function carrierDispatchErrorEvidence(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  context: Record<string, unknown>;
} {
  if (error instanceof CarrierDispatchAuthorityError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      context: { ...error.context },
    };
  }
  return {
    code: "CARRIER_DISPATCH_UNCLASSIFIED_FAILURE",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    context: {},
  };
}

function defaultTrackingSubscriptionLeaseOwner(): string {
  const runtime = process.env.DYNO?.trim() || process.env.HOSTNAME?.trim() || "local";
  return `carrier-tracking:${runtime}:${process.pid}`.slice(0, 200);
}

function defaultCarrierDispatchLeaseOwner(): string {
  const runtime = process.env.DYNO?.trim() || process.env.HOSTNAME?.trim() || "local";
  return `carrier-dispatch:${runtime}:${process.pid}`.slice(0, 150);
}

function defaultTrackingHydrationLeaseOwner(): string {
  const runtime = process.env.DYNO?.trim() || process.env.HOSTNAME?.trim() || "local";
  return `carrier-tracking-hydration:${runtime}:${process.pid}`.slice(0, 200);
}
