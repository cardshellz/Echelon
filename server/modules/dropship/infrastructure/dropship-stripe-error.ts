import Stripe from "stripe";
import { DropshipError } from "../domain/errors";

/**
 * Failure class for a Stripe call, per the module error contract:
 * - `transient`: safe to retry with backoff (Stripe outage, rate limit, network).
 * - `permanent`: terminal for this request. Never retried (declined card, request
 *   Stripe refuses, replayed idempotency key).
 * - `fatal`: credential/configuration problem. Needs a human, not a retry loop.
 */
export type DropshipStripeFailureClass = "transient" | "permanent" | "fatal";

interface StripeFailureMapping {
  /** Namespaced structured error code. */
  readonly code: string;
  readonly classification: DropshipStripeFailureClass;
  /** Vendor-facing copy. Never carries Stripe's internal parameter detail. */
  readonly message: string;
  /**
   * Stripe writes card-error messages for cardholders and documents them as safe
   * to display. Every other Stripe message can name request parameters and account
   * configuration, so it stays in the structured context and the log instead.
   */
  readonly useStripeMessage: boolean;
  /** HTTP status. 5xx means "retryable", 4xx means "terminal" — senders key off this. */
  readonly httpStatus: number;
}

/**
 * Keyed by `StripeError.type`, the stripe-node error class name
 * (see node_modules/stripe/types/Errors.d.ts, `errorClassNameEnum`).
 */
const STRIPE_FAILURE_MAPPINGS: Readonly<Record<string, StripeFailureMapping>> = {
  StripeCardError: {
    code: "DROPSHIP_STRIPE_CARD_DECLINED",
    classification: "permanent",
    message: "The card was declined.",
    useStripeMessage: true,
    httpStatus: 402,
  },
  StripeInvalidRequestError: {
    code: "DROPSHIP_STRIPE_REQUEST_REJECTED",
    classification: "permanent",
    message: "Stripe rejected the payment request. Card Shellz has been notified.",
    useStripeMessage: false,
    httpStatus: 400,
  },
  StripeIdempotencyError: {
    code: "DROPSHIP_STRIPE_IDEMPOTENCY_CONFLICT",
    classification: "permanent",
    message: "This payment request was already submitted with different details.",
    useStripeMessage: false,
    httpStatus: 409,
  },
  StripeInvalidGrantError: {
    code: "DROPSHIP_STRIPE_GRANT_INVALID",
    classification: "permanent",
    message: "Stripe rejected the payment authorization.",
    useStripeMessage: false,
    httpStatus: 400,
  },
  StripeSignatureVerificationError: {
    code: "DROPSHIP_STRIPE_WEBHOOK_SIGNATURE_INVALID",
    classification: "permanent",
    message: "Stripe webhook signature verification failed.",
    useStripeMessage: false,
    httpStatus: 400,
  },
  StripeAuthenticationError: {
    code: "DROPSHIP_STRIPE_CREDENTIALS_REJECTED",
    classification: "fatal",
    message: "Card payments are unavailable right now. Card Shellz has been notified.",
    useStripeMessage: false,
    httpStatus: 503,
  },
  StripePermissionError: {
    code: "DROPSHIP_STRIPE_PERMISSION_DENIED",
    classification: "fatal",
    message: "Card payments are unavailable right now. Card Shellz has been notified.",
    useStripeMessage: false,
    httpStatus: 503,
  },
  StripeRateLimitError: {
    code: "DROPSHIP_STRIPE_RATE_LIMITED",
    classification: "transient",
    message: "Stripe is busy. Try again in a moment.",
    useStripeMessage: false,
    httpStatus: 503,
  },
  StripeConnectionError: {
    code: "DROPSHIP_STRIPE_UNREACHABLE",
    classification: "transient",
    message: "Could not reach Stripe. Try again in a moment.",
    useStripeMessage: false,
    httpStatus: 503,
  },
  StripeAPIError: {
    code: "DROPSHIP_STRIPE_API_ERROR",
    classification: "transient",
    message: "Stripe had a problem completing the request. Try again in a moment.",
    useStripeMessage: false,
    httpStatus: 503,
  },
  TemporarySessionExpiredError: {
    code: "DROPSHIP_STRIPE_SESSION_EXPIRED",
    classification: "transient",
    message: "The Stripe session expired. Try again.",
    useStripeMessage: false,
    httpStatus: 503,
  },
};

/**
 * An unrecognized Stripe failure is treated as terminal on purpose: this module
 * moves money, and retrying a failure we cannot classify is the more expensive
 * mistake. It surfaces for review rather than looping.
 */
const UNCLASSIFIED_STRIPE_FAILURE: StripeFailureMapping = {
  code: "DROPSHIP_STRIPE_REQUEST_FAILED",
  classification: "permanent",
  message: "The payment provider returned an unexpected error.",
  useStripeMessage: false,
  httpStatus: 502,
};

/** HTTP status for a code this module produced, or null when it owns no mapping. */
export function httpStatusForDropshipStripeErrorCode(code: string): number | null {
  if (code === UNCLASSIFIED_STRIPE_FAILURE.code) return UNCLASSIFIED_STRIPE_FAILURE.httpStatus;
  for (const mapping of Object.values(STRIPE_FAILURE_MAPPINGS)) {
    if (mapping.code === code) return mapping.httpStatus;
  }
  return null;
}

function mappingForStripeError(error: Stripe.errors.StripeError): StripeFailureMapping {
  return STRIPE_FAILURE_MAPPINGS[error.type] ?? UNCLASSIFIED_STRIPE_FAILURE;
}

/**
 * Convert a Stripe SDK failure into a classified `DropshipError`.
 *
 * Errors that are already `DropshipError`s pass through untouched, and errors
 * that did not come from Stripe are returned as-is: wrapping a bug in our own
 * code as a payment-provider failure would misreport where the fault is.
 */
export function toDropshipStripeError(operation: string, error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  if (!(error instanceof Stripe.errors.StripeError)) return error;

  const mapping = mappingForStripeError(error);
  const message = mapping.useStripeMessage && error.message.trim()
    ? error.message
    : mapping.message;

  return new DropshipError(mapping.code, message, {
    operation,
    classification: mapping.classification,
    provider: "stripe",
    stripeType: error.type,
    stripeRawType: error.rawType ?? null,
    stripeCode: error.code ?? null,
    stripeDeclineCode: (error as Stripe.errors.StripeCardError).decline_code ?? null,
    stripeParam: error.param ?? null,
    stripeStatusCode: error.statusCode ?? null,
    stripeRequestId: error.requestId ?? null,
    stripeDocUrl: error.doc_url ?? null,
  });
}
