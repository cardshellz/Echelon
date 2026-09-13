export type HistoricalCarrierDispatchRepairCohort =
  | "active_combined_package_resolution"
  | "aggregate_package_identity_conflict"
  | "immutable_command_request_conflict"
  | "package_resolution_retry"
  | "legacy_outbound_shipment_identity_conflict"
  | "confirmed_historical_inventory_gap";

export interface ReviewedCarrierDispatchRepairAuthorization {
  requeueId: number;
  repairCohort: HistoricalCarrierDispatchRepairCohort;
  operator: string;
  reason: string;
  idempotencyKey: string;
  requeuedAt: Date;
}

export interface ConfirmCarrierDispatchInput {
  commandId: number;
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
  reviewedRepair?: ReviewedCarrierDispatchRepairAuthorization | null;
}

export interface ConfirmCarrierDispatchResult {
  processed: boolean;
  evidence: Readonly<Record<string, unknown>>;
}

export interface CarrierDispatchAuthority {
  confirmDispatch(
    input: ConfirmCarrierDispatchInput,
  ): Promise<ConfirmCarrierDispatchResult>;
}

export class CarrierDispatchAuthorityError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options: {
      retryable: boolean;
      context?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CarrierDispatchAuthorityError";
    this.code = code;
    this.retryable = options.retryable;
    this.context = Object.freeze({ ...(options.context ?? {}) });
  }
}
