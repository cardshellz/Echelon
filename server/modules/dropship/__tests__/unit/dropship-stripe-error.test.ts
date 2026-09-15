import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  httpStatusForDropshipStripeErrorCode,
  toDropshipStripeError,
} from "../../infrastructure/dropship-stripe-error";

function asDropshipError(value: unknown): DropshipError {
  if (!(value instanceof DropshipError)) {
    throw new Error(`expected a DropshipError, received ${String(value)}`);
  }
  return value;
}

describe("toDropshipStripeError", () => {
  it("classifies a declined card as permanent and forwards Stripe's cardholder message", () => {
    const error = asDropshipError(toDropshipStripeError(
      "createStripeAutoReloadPaymentIntent",
      new Stripe.errors.StripeCardError({
        type: "card_error",
        message: "Your card was declined.",
        code: "card_declined",
        decline_code: "insufficient_funds",
        statusCode: 402,
        requestId: "req_card",
      }),
    ));

    expect(error.code).toBe("DROPSHIP_STRIPE_CARD_DECLINED");
    expect(error.message).toBe("Your card was declined.");
    expect(error.context).toMatchObject({
      operation: "createStripeAutoReloadPaymentIntent",
      classification: "permanent",
      provider: "stripe",
      stripeCode: "card_declined",
      stripeDeclineCode: "insufficient_funds",
      stripeRequestId: "req_card",
    });
    expect(httpStatusForDropshipStripeErrorCode(error.code)).toBe(402);
  });

  it("treats a rejected credential as fatal and never repeats Stripe's message to the vendor", () => {
    const error = asDropshipError(toDropshipStripeError(
      "customers.create",
      new Stripe.errors.StripeAuthenticationError({
        type: "authentication_error",
        message: "Invalid API Key provided: sk_live_***",
        statusCode: 401,
        requestId: "req_auth",
      }),
    ));

    expect(error.code).toBe("DROPSHIP_STRIPE_CREDENTIALS_REJECTED");
    expect(error.message).not.toContain("sk_live");
    expect(error.message).not.toContain("API Key");
    expect(error.context).toMatchObject({ classification: "fatal", stripeStatusCode: 401 });
    // Retryable status: the request can succeed once the credential is fixed.
    expect(httpStatusForDropshipStripeErrorCode(error.code)).toBe(503);
  });

  it("classifies connection and rate-limit failures as transient with a retryable status", () => {
    const connection = asDropshipError(toDropshipStripeError(
      "checkout.sessions.create",
      new Stripe.errors.StripeConnectionError({ type: "api_error", message: "socket hang up" }),
    ));
    expect(connection.code).toBe("DROPSHIP_STRIPE_UNREACHABLE");
    expect(connection.context).toMatchObject({ classification: "transient" });
    expect(httpStatusForDropshipStripeErrorCode(connection.code)).toBe(503);

    const rateLimited = asDropshipError(toDropshipStripeError(
      "checkout.sessions.create",
      new Stripe.errors.StripeRateLimitError({ type: "rate_limit_error", message: "too many requests" }),
    ));
    expect(rateLimited.code).toBe("DROPSHIP_STRIPE_RATE_LIMITED");
    expect(rateLimited.context).toMatchObject({ classification: "transient" });
    expect(httpStatusForDropshipStripeErrorCode(rateLimited.code)).toBe(503);
  });

  it("keeps an invalid request terminal so the webhook sender stops retrying it", () => {
    const error = asDropshipError(toDropshipStripeError(
      "createStripeSetupSession",
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "The payment method type 'us_bank_account' is not activated for this account.",
        code: "payment_method_unactivated",
        param: "payment_method_types",
        statusCode: 400,
        requestId: "req_invalid",
      }),
    ));

    expect(error.code).toBe("DROPSHIP_STRIPE_REQUEST_REJECTED");
    // Stripe's message names internal request parameters: it belongs in the
    // structured context, not in the vendor-facing message.
    expect(error.message).not.toContain("payment_method_types");
    expect(error.context).toMatchObject({
      classification: "permanent",
      stripeCode: "payment_method_unactivated",
      stripeParam: "payment_method_types",
    });
    expect(httpStatusForDropshipStripeErrorCode(error.code)).toBe(400);
  });

  it("falls back to a terminal unclassified failure for an unrecognized Stripe error", () => {
    const error = asDropshipError(toDropshipStripeError(
      "setupIntents.retrieve",
      new Stripe.errors.StripeError({ type: "api_error", message: "unmapped" }),
    ));

    expect(error.code).toBe("DROPSHIP_STRIPE_REQUEST_FAILED");
    expect(error.context).toMatchObject({ classification: "permanent" });
    expect(httpStatusForDropshipStripeErrorCode(error.code)).toBe(502);
  });

  it("passes through a DropshipError and any error that did not come from Stripe", () => {
    const dropshipError = new DropshipError("DROPSHIP_WALLET_ACCOUNT_NOT_FOUND", "missing");
    expect(toDropshipStripeError("customers.create", dropshipError)).toBe(dropshipError);

    // A fault in our own code must not be relabelled as a payment-provider failure.
    const bug = new TypeError("cannot read properties of undefined");
    expect(toDropshipStripeError("customers.create", bug)).toBe(bug);
  });

  it("owns no status for codes produced elsewhere in the module", () => {
    expect(httpStatusForDropshipStripeErrorCode("DROPSHIP_WALLET_INSUFFICIENT_FUNDS")).toBeNull();
  });
});
