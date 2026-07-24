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
