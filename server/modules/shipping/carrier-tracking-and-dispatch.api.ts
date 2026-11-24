export {
  CarrierDispatchAuthorityError,
  type CarrierDispatchAuthority,
  type ConfirmCarrierDispatchInput,
  type ConfirmCarrierDispatchResult,
  type ReviewedCarrierDispatchRepairAuthorization,
} from "./application/carrier-dispatch-authority";

export {
  CARRIER_TRACKING_PARSER_VERSION,
  normalizeShipStationTrackingWebhook,
  normalizeTrackingNumber,
  type CanonicalCarrierTrackingStatus,
  type VerifiedCarrierWebhookReceipt,
} from "./domain/carrier-tracking.domain";

export {
  createDrizzleCarrierTrackingRepository,
  type CarrierTrackingRepository,
  type HistoricalCarrierDispatchRepairCohort,
  type HistoricalCarrierDispatchRepairPreview,
  type RequeueReviewedCarrierDispatchCommandsResult,
  type RequeueReviewedTrackingSubscriptionsResult,
  type StoredShippingProviderLabelObservation,
} from "./infrastructure/carrier-tracking.repository";

export {
  CarrierTrackingService,
  makeCarrierTrackingLogger,
  systemCarrierTrackingClock,
  type CarrierTrackingIngestResult,
  type CarrierTrackingSubscriptionSweepResult,
  type CarrierTrackingWebhookReplayContext,
  type ShippingProviderLabelObserver,
} from "./application/carrier-tracking.service";

export { createCarrierTrackingProjectionReader } from "./infrastructure/carrier-tracking-projection.repository";
export { registerCarrierTrackingProjectionRoutes } from "./interfaces/http/carrier-tracking-projection.routes";
export { startCarrierTrackingReconciliationScheduler } from "./application/carrier-tracking-reconciliation.scheduler";
