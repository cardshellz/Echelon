import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  StripeDropshipFundingProvider,
  bankBalanceSnapshotFromAccount,
} from "../../infrastructure/dropship-stripe-funding.provider";

describe("StripeDropshipFundingProvider", () => {
  it("creates setup sessions without creating duplicate customers when one is reusable", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    const session = await provider.createStripeSetupSession({
      vendorId: 10,
      memberId: "member-1",
      rail: "stripe_ach",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      successUrl: "https://cardshellz.io/wallet?funding_setup=success",
      cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(session).toMatchObject({
      checkoutUrl: "https://checkout.stripe.test/cs_1",
      providerSessionId: "cs_1",
      providerCustomerId: "cus_existing",
    });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "setup",
      customer: "cus_existing",
      payment_method_types: ["us_bank_account"],
      // Balances are NOT asked for by default. Stripe refuses the whole bank
      // link when an unregistered account requests them, which is exactly how
      // this reached a vendor as a bare failure at "Add a bank account".
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ["payment_method"] },
        },
      },
      metadata: expect.objectContaining({
        type: "dropship_funding_setup",
        dropship_vendor_id: "10",
        member_id: "member-1",
        requested_rail: "stripe_ach",
      }),
    }));
  });

  it("asks for the balance permission only when it is turned on", async () => {
    const setupSession = async (requestBankBalances: boolean | undefined) => {
      const stripe = makeStripeDouble();
      const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test", requestBankBalances });
      await provider.createStripeSetupSession({
        vendorId: 10,
        memberId: "member-1",
        rail: "stripe_ach",
        customerEmail: "vendor@cardshellz.test",
        customerName: "Vendor",
        existingProviderCustomerId: "cus_existing",
        successUrl: "https://cardshellz.io/wallet?funding_setup=success",
        cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
        now: new Date("2026-05-03T12:00:00.000Z"),
      });
      const params = stripe.checkout.sessions.create.mock.calls[0][0] as Record<string, any>;
      return params.payment_method_options.us_bank_account.financial_connections.permissions as string[];
    };

    // Turned on, once the Stripe registration is approved: the advance can read
    // a balance. Left alone, the link collects bank details and nothing else.
    expect(await setupSession(true)).toEqual(["payment_method", "balances"]);
    expect(await setupSession(false)).toEqual(["payment_method"]);
  });

  it("opens a card setup session with no currency and no bank options", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    await provider.createStripeSetupSession({
      vendorId: 10,
      memberId: "member-1",
      rail: "stripe_card",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      successUrl: "https://cardshellz.io/wallet?funding_setup=success",
      cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    // A card mandate needs no currency, so the card path is left exactly as it
    // was: the bank fix must not change a rail that already worked.
    const params = stripe.checkout.sessions.create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params).not.toHaveProperty("currency");
    expect(params).not.toHaveProperty("payment_method_options");
  });

  it("takes a payment-mode session's currency from its line items, not from a second field", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    await provider.createStripeWalletFundingSession({
      vendorId: 10,
      memberId: "member-1",
      fundingMethodId: 1,
      rail: "stripe_ach",
      amountCents: 10_000,
      cardFee: null,
      currency: "usd",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      providerPaymentMethodId: null,
      successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
      cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    // Stating it twice would let the two disagree, so only setup mode carries it.
    const params = stripe.checkout.sessions.create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.mode).toBe("payment");
    expect(params).not.toHaveProperty("currency");
    expect(params.payment_method_options).toEqual({
      us_bank_account: {
        financial_connections: { permissions: ["payment_method"] },
      },
    });
  });

  it("reads which rails the Stripe account can run, treating an absent capability as not enabled", async () => {
    const stripe = makeStripeDouble();
    // ACH was never enabled on this account: the capability is simply absent,
    // which is the shape that produced an unexplained refusal for a vendor.
    // Cast for the same reason the whole double is cast: a partial account is
    // all this call reads, and spelling out every Account field proves nothing.
    stripe.accounts.retrieve = vi.fn(async () => (
      { id: "acct_live", capabilities: { card_payments: "active" } } as unknown as Stripe.Response<Stripe.Account>
    ));
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    expect(await provider.readRailAvailability()).toEqual({
      outcome: "read",
      accountId: "acct_live",
      cardPayments: "active",
      achPayments: null,
      reason: null,
    });
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith();
  });

  it("records why Stripe refused a call without putting Stripe's wording in front of the vendor", async () => {
    // A refusal Stripe explains only in its message: no code, no param, which is
    // exactly the shape that left an operator with a bare 400 and no reason.
    const refusal = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message: "The payment method type \"us_bank_account\" is not activated for your account.",
      requestId: "req_test_1",
      statusCode: 400,
    });
    const stripe = makeStripeDouble();
    stripe.checkout.sessions.create = vi.fn(async () => { throw refusal; });
    const logger = makeLoggerDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" }, logger);

    const thrown = await provider.createStripeSetupSession({
      vendorId: 10,
      memberId: "member-1",
      rail: "stripe_ach",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      successUrl: "https://cardshellz.io/wallet?funding_setup=success",
      cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    }).catch((error: unknown) => error);

    // The vendor is told nothing about our account configuration, and neither
    // is the error context, which routes echo back to the caller verbatim.
    expect(thrown).toBeInstanceOf(DropshipError);
    const error = thrown as DropshipError;
    expect(error.code).toBe("DROPSHIP_STRIPE_REQUEST_REJECTED");
    expect(error.message).toBe("Stripe rejected the payment request. Card Shellz has been notified.");
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain("not activated");

    // Our account settings are nobody else's to fix, so this needs a human.
    expect(logger.warns).toHaveLength(0);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({
      code: "DROPSHIP_STRIPE_CALL_FAILED",
      message: 'Stripe refused createStripeSetupSession: The payment method type "us_bank_account" is not activated for your account.',
      context: expect.objectContaining({
        operation: "createStripeSetupSession",
        classification: "permanent",
        errorCode: "DROPSHIP_STRIPE_REQUEST_REJECTED",
        stripeRawType: "invalid_request_error",
        stripeStatusCode: 400,
        stripeRequestId: "req_test_1",
      }),
    });
  });

  it("logs a declined card as the vendor's to fix, not a human's", async () => {
    const decline = new Stripe.errors.StripeCardError({
      type: "card_error",
      message: "Your card was declined.",
      code: "card_declined",
      decline_code: "insufficient_funds",
      requestId: "req_test_2",
      statusCode: 402,
    });
    const stripe = makeStripeDouble();
    stripe.paymentIntents.create = vi.fn(async () => { throw decline; });
    const logger = makeLoggerDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" }, logger);

    await expect(provider.createStripeAutoReloadPaymentIntent({
      vendorId: 10,
      fundingMethodId: 1,
      rail: "stripe_card",
      amountCents: 6_500,
      cardFee: null,
      currency: "usd",
      providerCustomerId: "cus_existing",
      providerPaymentMethodId: "pm_1",
      reason: "minimum_balance",
      intakeId: null,
      requiredBalanceCents: null,
      idempotencyKey: "auto-reload:10:1",
      now: new Date("2026-05-03T12:00:00.000Z"),
    })).rejects.toMatchObject({ code: "DROPSHIP_STRIPE_CARD_DECLINED" });

    expect(logger.errors).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toMatchObject({
      code: "DROPSHIP_STRIPE_CALL_FAILED",
      context: expect.objectContaining({ stripeCode: "card_declined", stripeRequestId: "req_test_2" }),
    });
  });

  it("creates wallet funding payment sessions with reusable Stripe funding methods", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    const session = await provider.createStripeWalletFundingSession({
      vendorId: 10,
      memberId: "member-1",
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 25000,
      cardFee: null,
      currency: "USD",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      providerPaymentMethodId: "pm_4242",
      successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
      cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(session).toMatchObject({
      checkoutUrl: "https://checkout.stripe.test/cs_1",
      providerSessionId: "cs_1",
      providerCustomerId: "cus_existing",
      amountCents: 25000,
      currency: "USD",
    });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "payment",
      customer: "cus_existing",
      payment_method_types: ["card"],
      line_items: [
        expect.objectContaining({
          price_data: expect.objectContaining({
            currency: "usd",
            unit_amount: 25000,
          }),
          quantity: 1,
        }),
      ],
      payment_intent_data: expect.objectContaining({
        setup_future_usage: "off_session",
        metadata: expect.objectContaining({
          type: "dropship_wallet_funding",
          dropship_vendor_id: "10",
          member_id: "member-1",
          funding_method_id: "99",
          requested_rail: "stripe_card",
          requested_provider_payment_method_id: "pm_4242",
        }),
      }),
    }));
  });

  it("creates off-session auto-reload payment intents with deterministic metadata", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    const payment = await provider.createStripeAutoReloadPaymentIntent({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 6500,
      cardFee: null,
      currency: "USD",
      providerCustomerId: "cus_existing",
      providerPaymentMethodId: "pm_4242",
      reason: "payment_hold",
      intakeId: 456,
      requiredBalanceCents: 7500,
      idempotencyKey: "dropship-auto-reload:key-1",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(payment).toEqual({
      providerPaymentIntentId: "pi_auto_1",
      status: "settled",
      amountCents: 6500,
      currency: "USD",
      externalTransactionId: "ch_auto_1",
    });
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 6500,
      currency: "usd",
      customer: "cus_existing",
      payment_method: "pm_4242",
      payment_method_types: ["card"],
      confirm: true,
      off_session: true,
      metadata: expect.objectContaining({
        type: "dropship_wallet_funding",
        dropship_vendor_id: "10",
        funding_method_id: "99",
        requested_rail: "stripe_card",
        requested_provider_payment_method_id: "pm_4242",
        auto_reload: "true",
        auto_reload_reason: "payment_hold",
        intake_id: "456",
        required_balance_cents: "7500",
      }),
    }), {
      idempotencyKey: "dropship-auto-reload:key-1",
    });
  });

  it("parses verified setup webhooks into sanitized V2 funding methods", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "setup",
          setup_intent: "seti_1",
          customer: "cus_1",
          metadata: {
            type: "dropship_funding_setup",
            dropship_vendor_id: "10",
            requested_rail: "stripe_card",
          },
        },
      },
    });
    stripe.setupIntents.retrieve.mockResolvedValueOnce({
      id: "seti_1",
      customer: "cus_1",
      payment_method: "pm_1",
      metadata: {
        type: "dropship_funding_setup",
        dropship_vendor_id: "10",
        requested_rail: "stripe_card",
      },
    });
    stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_1",
      type: "card",
      card: {
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
      },
    });

    const event = await provider.parseWebhookEvent({
      rawBody: Buffer.from("{}"),
      signature: "stripe-signature",
    });

    expect(event).toMatchObject({
      kind: "funding_method_setup_completed",
      providerEventId: "evt_1",
      fundingMethod: {
        vendorId: 10,
        rail: "stripe_card",
        status: "active",
        providerCustomerId: "cus_1",
        providerPaymentMethodId: "pm_1",
        displayLabel: "Visa ending in 4242",
      },
    });
    expect(event.kind === "funding_method_setup_completed" ? event.fundingMethod.metadata : {}).toEqual(expect.objectContaining({
      provider: "stripe",
      paymentMethodType: "card",
      setupIntentId: "seti_1",
      setupSessionId: "cs_1",
      providerEventId: "evt_1",
      brand: "visa",
      last4: "4242",
    }));
    expect(JSON.stringify(event)).not.toContain("routing");
    expect(JSON.stringify(event)).not.toContain("account_number");
  });

  it("parses wallet funding succeeded webhooks into settled wallet credits", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_pi_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          amount: 25000,
          amount_received: 25000,
          currency: "usd",
          status: "succeeded",
          customer: "cus_1",
          payment_method: "pm_1",
          latest_charge: "ch_1",
          metadata: {
            type: "dropship_wallet_funding",
            dropship_vendor_id: "10",
            funding_method_id: "99",
            requested_rail: "stripe_card",
          },
        },
      },
    });
    stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_1",
      type: "card",
      card: {
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
      },
    });

    const event = await provider.parseWebhookEvent({
      rawBody: Buffer.from("{}"),
      signature: "stripe-signature",
    });

    expect(event).toMatchObject({
      kind: "wallet_funding_recorded",
      providerEventId: "evt_pi_1",
      fundingMethod: {
        vendorId: 10,
        rail: "stripe_card",
        status: "active",
        providerCustomerId: "cus_1",
        providerPaymentMethodId: "pm_1",
        displayLabel: "Visa ending in 4242",
      },
      fundingCredit: {
        vendorId: 10,
        rail: "stripe_card",
        status: "settled",
        amountCents: 25000,
        currency: "USD",
        referenceType: "stripe_payment_intent",
        referenceId: "pi_1",
        externalTransactionId: "ch_1",
        idempotencyKey: "stripe-funding:pi_1",
      },
    });
  });

  it("parses wallet funding processing webhooks into pending ACH wallet credits", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_pi_processing",
      type: "payment_intent.processing",
      data: {
        object: {
          id: "pi_ach",
          amount: 48000,
          currency: "usd",
          status: "processing",
          customer: "cus_1",
          payment_method: "pm_bank",
          latest_charge: null,
          metadata: {
            type: "dropship_wallet_funding",
            dropship_vendor_id: "10",
            funding_method_id: "100",
            requested_rail: "stripe_ach",
          },
        },
      },
    });
    stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_bank",
      type: "us_bank_account",
      us_bank_account: {
        bank_name: "Test Bank",
        last4: "6789",
        account_type: "checking",
        account_holder_type: "company",
      },
    });

    const event = await provider.parseWebhookEvent({
      rawBody: Buffer.from("{}"),
      signature: "stripe-signature",
    });

    expect(event).toMatchObject({
      kind: "wallet_funding_recorded",
      providerEventId: "evt_pi_processing",
      fundingMethod: {
        vendorId: 10,
        rail: "stripe_ach",
        status: "active",
        providerCustomerId: "cus_1",
        providerPaymentMethodId: "pm_bank",
        displayLabel: "Test Bank ending in 6789",
      },
      fundingCredit: {
        vendorId: 10,
        rail: "stripe_ach",
        status: "pending",
        amountCents: 48000,
        currency: "USD",
        referenceType: "stripe_payment_intent",
        referenceId: "pi_ach",
        idempotencyKey: "stripe-funding:pi_ach",
      },
    });
    // The holder type decides the ACH return window (2 banking days for a
    // company account, ~60 for a consumer one) and so whether the pending-ACH
    // advance may be offered; it is kept exactly as Stripe reports it.
    const metadata = (event as { fundingMethod?: { metadata?: Record<string, unknown> } }).fundingMethod?.metadata;
    expect(metadata).toEqual(expect.objectContaining({
      accountType: "checking",
      accountHolderType: "company",
    }));
    expect(JSON.stringify(event)).not.toContain("routing");
    expect(JSON.stringify(event)).not.toContain("account_number");
  });

  it("parses wallet funding failed webhooks into vendor failure notifications", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_pi_failed",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_failed",
          amount: 25000,
          currency: "usd",
          status: "requires_payment_method",
          metadata: {
            type: "dropship_wallet_funding",
            dropship_vendor_id: "10",
            funding_method_id: "99",
            requested_rail: "stripe_card",
            auto_reload: "true",
            auto_reload_reason: "payment_hold",
            intake_id: "456",
          },
          last_payment_error: {
            code: "card_declined",
            message: "Your card was declined.",
          },
        },
      },
    });

    const event = await provider.parseWebhookEvent({
      rawBody: Buffer.from("{}"),
      signature: "stripe-signature",
    });

    expect(event).toMatchObject({
      kind: "wallet_funding_failed",
      providerEventId: "evt_pi_failed",
      eventType: "payment_intent.payment_failed",
      failure: {
        vendorId: 10,
        fundingMethodId: 99,
        rail: "stripe_card",
        amountCents: 25000,
        currency: "USD",
        provider: "stripe",
        providerEventId: "evt_pi_failed",
        providerPaymentIntentId: "pi_failed",
        providerStatus: "requires_payment_method",
        failureCode: "card_declined",
        failureMessage: "Your card was declined.",
        autoReload: true,
        autoReloadReason: "payment_hold",
        intakeId: 456,
        idempotencyKey: "stripe-funding-failed:pi_failed",
      },
    });
  });
});

describe("StripeDropshipFundingProvider Stripe failures", () => {
  it("classifies a Stripe failure raised while creating the checkout session", async () => {
    const stripe = makeStripeDouble();
    stripe.checkout.sessions.create.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message: "The payment method type 'us_bank_account' is not activated for this account.",
      code: "payment_method_unactivated",
      param: "payment_method_types",
      statusCode: 400,
      requestId: "req_setup",
    }));
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    await expect(provider.createStripeSetupSession({
      vendorId: 10,
      memberId: "member-1",
      rail: "stripe_ach",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      successUrl: "https://cardshellz.io/wallet?funding_setup=success",
      cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    })).rejects.toMatchObject({
      code: "DROPSHIP_STRIPE_REQUEST_REJECTED",
      context: expect.objectContaining({
        operation: "createStripeSetupSession",
        classification: "permanent",
        stripeRequestId: "req_setup",
      }),
    });
  });

  it("classifies a Stripe failure raised while creating the customer", async () => {
    const stripe = makeStripeDouble();
    stripe.customers.create.mockRejectedValueOnce(new Stripe.errors.StripeAuthenticationError({
      type: "authentication_error",
      message: "Invalid API Key provided: sk_live_***",
      statusCode: 401,
      requestId: "req_customer",
    }));
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    const failure = await provider.createStripeSetupSession({
      vendorId: 10,
      memberId: "member-1",
      rail: "stripe_card",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: null,
      successUrl: "https://cardshellz.io/wallet?funding_setup=success",
      cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DropshipError);
    expect(failure).toMatchObject({
      code: "DROPSHIP_STRIPE_CREDENTIALS_REJECTED",
      context: expect.objectContaining({ operation: "customers.create", classification: "fatal" }),
    });
    expect((failure as DropshipError).message).not.toContain("sk_live");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("classifies a declined card raised while charging an auto-reload", async () => {
    const stripe = makeStripeDouble();
    stripe.paymentIntents.create.mockRejectedValueOnce(new Stripe.errors.StripeCardError({
      type: "card_error",
      message: "Your card was declined.",
      code: "card_declined",
      decline_code: "insufficient_funds",
      statusCode: 402,
      requestId: "req_reload",
    }));
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    await expect(provider.createStripeAutoReloadPaymentIntent({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 6500,
      cardFee: null,
      currency: "USD",
      providerCustomerId: "cus_existing",
      providerPaymentMethodId: "pm_1",
      reason: "minimum_balance",
      intakeId: null,
      requiredBalanceCents: null,
      idempotencyKey: "auto-reload:10:1",
      now: new Date("2026-05-03T12:00:00.000Z"),
    })).rejects.toMatchObject({
      code: "DROPSHIP_STRIPE_CARD_DECLINED",
      message: "Your card was declined.",
      context: expect.objectContaining({
        operation: "createStripeAutoReloadPaymentIntent",
        classification: "permanent",
        stripeDeclineCode: "insufficient_funds",
      }),
    });
  });

  it("puts the card fee on a manual top-up as its own line and records the breakdown on the payment intent", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    const session = await provider.createStripeWalletFundingSession({
      vendorId: 10,
      memberId: "member-1",
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 10_000,
      cardFee: { feeCents: 300, feeBps: 300 },
      currency: "USD",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      providerPaymentMethodId: "pm_4242",
      successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
      cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(session).toMatchObject({ amountCents: 10_000, cardFeeCents: 300, chargedCents: 10_300 });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [
        expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 10_000 }), quantity: 1 }),
        expect.objectContaining({
          price_data: expect.objectContaining({ unit_amount: 300, product_data: { name: "Card processing fee (3%)" } }),
          quantity: 1,
        }),
      ],
      payment_intent_data: expect.objectContaining({
        metadata: expect.objectContaining({ wallet_credit_cents: "10000", card_fee_cents: "300", card_fee_bps: "300" }),
      }),
    }));
  });

  it("charges an auto-reload card the credit plus the fee and records the breakdown", async () => {
    const stripe = makeStripeDouble();
    stripe.paymentIntents.create.mockResolvedValueOnce({
      id: "pi_auto_2",
      status: "succeeded",
      amount: 6695,
      amount_received: 6695,
      currency: "usd",
      latest_charge: "ch_auto_2",
      last_payment_error: null,
    });
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    const payment = await provider.createStripeAutoReloadPaymentIntent({
      vendorId: 10,
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 6500,
      cardFee: { feeCents: 195, feeBps: 300 },
      currency: "USD",
      providerCustomerId: "cus_existing",
      providerPaymentMethodId: "pm_4242",
      reason: "payment_hold",
      intakeId: 456,
      requiredBalanceCents: 7500,
      idempotencyKey: "dropship-auto-reload:key-2",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(payment).toMatchObject({ providerPaymentIntentId: "pi_auto_2", amountCents: 6695, status: "settled" });
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 6695,
      metadata: expect.objectContaining({ wallet_credit_cents: "6500", card_fee_cents: "195", card_fee_bps: "300" }),
    }), { idempotencyKey: "dropship-auto-reload:key-2" });
  });

  it("credits the wallet net of the fee when a card funding webhook carries the breakdown", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    stripe.webhooks.constructEvent.mockReturnValueOnce(walletFundingSucceededEvent({
      amount: 10_300,
      metadata: { wallet_credit_cents: "10000", card_fee_cents: "300", card_fee_bps: "300" },
    }));
    stripe.paymentMethods.retrieve.mockResolvedValueOnce(visaPaymentMethod());

    const event = await provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "stripe-signature" });

    expect(event).toMatchObject({
      kind: "wallet_funding_recorded",
      fundingCredit: {
        rail: "stripe_card",
        status: "settled",
        amountCents: 10_000,
        cardFee: { feeCents: 300, feeBps: 300, chargedCents: 10_300 },
        referenceId: "pi_fee_1",
        idempotencyKey: "stripe-funding:pi_fee_1",
      },
    });
  });

  it("credits the full charged amount for a card intent created before the fee existed", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    stripe.webhooks.constructEvent.mockReturnValueOnce(walletFundingSucceededEvent({ amount: 10_000, metadata: {} }));
    stripe.paymentMethods.retrieve.mockResolvedValueOnce(visaPaymentMethod());

    const event = await provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "stripe-signature" });

    expect(event).toMatchObject({ kind: "wallet_funding_recorded", fundingCredit: { amountCents: 10_000 } });
    expect((event as { fundingCredit: { cardFee?: unknown } }).fundingCredit.cardFee).toBeUndefined();
  });

  it("refuses a fee breakdown that does not reconcile with the charged amount", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    stripe.webhooks.constructEvent.mockReturnValueOnce(walletFundingSucceededEvent({
      amount: 10_300,
      metadata: { wallet_credit_cents: "10000", card_fee_cents: "200", card_fee_bps: "300" },
    }));
    stripe.paymentMethods.retrieve.mockResolvedValueOnce(visaPaymentMethod());

    await expect(provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "stripe-signature" })).rejects.toMatchObject({
      code: "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      context: expect.objectContaining({ providerPaymentIntentId: "pi_fee_1", creditCents: 10_000, feeCents: 200, chargedCents: 10_300 }),
    });
  });

  it("refuses a partial fee breakdown rather than guessing the missing part", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    stripe.webhooks.constructEvent.mockReturnValueOnce(walletFundingSucceededEvent({
      amount: 10_300,
      metadata: { wallet_credit_cents: "10000" },
    }));
    stripe.paymentMethods.retrieve.mockResolvedValueOnce(visaPaymentMethod());

    await expect(provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "stripe-signature" })).rejects.toMatchObject({
      code: "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      context: { field: "card_fee_cents" },
    });
  });
});

/** A succeeded card funding PaymentIntent event with the given amount and extra metadata. */
function walletFundingSucceededEvent(input: { amount: number; metadata: Record<string, string> }) {
  return {
    id: "evt_fee_1",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_fee_1",
        amount: input.amount,
        amount_received: input.amount,
        currency: "usd",
        status: "succeeded",
        customer: "cus_1",
        payment_method: "pm_1",
        latest_charge: "ch_fee_1",
        metadata: {
          type: "dropship_wallet_funding",
          dropship_vendor_id: "10",
          funding_method_id: "99",
          requested_rail: "stripe_card",
          ...input.metadata,
        },
      },
    },
  };
}

function visaPaymentMethod() {
  return {
    id: "pm_1",
    type: "card",
    card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
  };
}

/** Collects what a failed Stripe call recorded, by level. */
function makeLoggerDouble() {
  const warns: Array<{ code: string; message: string; context?: Record<string, unknown> }> = [];
  const errors: Array<{ code: string; message: string; context?: Record<string, unknown> }> = [];
  return {
    warns,
    errors,
    info: () => {},
    warn: (event: { code: string; message: string; context?: Record<string, unknown> }) => { warns.push(event); },
    error: (event: { code: string; message: string; context?: Record<string, unknown> }) => { errors.push(event); },
  };
}

function makeStripeDouble() {
  return {
    customers: {
      create: vi.fn(async () => ({ id: "cus_created" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({
          id: "cs_1",
          url: "https://checkout.stripe.test/cs_1",
          expires_at: 1_777_777_777,
        })),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
    paymentIntents: {
      create: vi.fn(async () => ({
        id: "pi_auto_1",
        status: "succeeded",
        amount: 6500,
        amount_received: 6500,
        currency: "usd",
        latest_charge: "ch_auto_1",
        last_payment_error: null,
      })),
    },
    setupIntents: {
      retrieve: vi.fn(),
    },
    accounts: {
      retrieve: vi.fn(async () => ({
        id: "acct_test",
        capabilities: { card_payments: "active", us_bank_account_ach_payments: "active" },
      })),
    },
    paymentMethods: {
      retrieve: vi.fn(),
    },
  } as unknown as Stripe & {
    customers: { create: ReturnType<typeof vi.fn> };
    checkout: { sessions: { create: ReturnType<typeof vi.fn> } };
    webhooks: { constructEvent: ReturnType<typeof vi.fn> };
    paymentIntents: { create: ReturnType<typeof vi.fn> };
    setupIntents: { retrieve: ReturnType<typeof vi.fn> };
    accounts: { retrieve: ReturnType<typeof vi.fn> };
    paymentMethods: { retrieve: ReturnType<typeof vi.fn> };
  };
}

describe("StripeDropshipFundingProvider bank balances (funding design phase 3)", () => {
  function makeStripeWithFinancialConnections() {
    const stripe = makeStripeDouble();
    const financialConnections = { accounts: { retrieve: vi.fn(), refresh: vi.fn() } };
    return Object.assign(stripe, { financialConnections });
  }

  function linkedAccount(overrides: Record<string, unknown> = {}) {
    return {
      id: "fca_1",
      status: "active",
      permissions: ["payment_method", "balances"],
      balance: { as_of: 1_780_000_000, type: "cash", cash: { available: { usd: 250_000 } }, current: { usd: 250_000 } },
      balance_refresh: { status: "succeeded", last_attempted_at: 1_780_000_000, next_refresh_available_at: 1_780_003_600 },
      ...overrides,
    };
  }

  it("asks for the balances permission when a bank account is linked, and nothing for a card", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    const base = {
      vendorId: 10, memberId: "member-1", customerEmail: null, customerName: "Vendor", existingProviderCustomerId: "cus_existing",
      successUrl: "https://cardshellz.io/wallet?ok", cancelUrl: "https://cardshellz.io/wallet?cancel", now: new Date("2026-09-20T12:00:00.000Z"),
    };

    await provider.createStripeSetupSession({ ...base, rail: "stripe_ach" });
    await provider.createStripeSetupSession({ ...base, rail: "stripe_card" });

    const [bank, card] = stripe.checkout.sessions.create.mock.calls.map((call) => call[0]);
    expect(bank.payment_method_options).toEqual({
      us_bank_account: { financial_connections: { permissions: ["payment_method"] } },
    });
    expect(card.payment_method_options).toBeUndefined();
  });

  it("records the Financial Connections account behind a linked bank account, and null for one entered by hand", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    const setupEvent = {
      id: "evt_bank_1",
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_bank", customer: "cus_1", payment_method: "pm_bank", metadata: { type: "dropship_funding_setup", dropship_vendor_id: "10", requested_rail: "stripe_ach" } } },
    };
    const bankMethod = (financialConnectionsAccount: string | null) => ({
      id: "pm_bank",
      type: "us_bank_account",
      us_bank_account: { bank_name: "Test Bank", last4: "6789", account_type: "checking", account_holder_type: "company", financial_connections_account: financialConnectionsAccount },
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce(setupEvent);
    stripe.paymentMethods.retrieve.mockResolvedValueOnce(bankMethod("fca_1"));
    const linked = await provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "sig" });
    expect(linked.kind === "funding_method_setup_completed" ? linked.fundingMethod.metadata : {}).toEqual(expect.objectContaining({
      accountHolderType: "company",
      financialConnectionsAccountId: "fca_1",
      last4: "6789",
    }));

    stripe.webhooks.constructEvent.mockReturnValueOnce(setupEvent);
    stripe.paymentMethods.retrieve.mockResolvedValueOnce(bankMethod(null));
    const manual = await provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "sig" });
    expect(manual.kind === "funding_method_setup_completed" ? manual.fundingMethod.metadata?.financialConnectionsAccountId : "x").toBeNull();
  });

  it("reads a linked account's balance as reported: integer minor units by lowercase currency", () => {
    expect(bankBalanceSnapshotFromAccount(linkedAccount() as never)).toEqual({
      status: "succeeded",
      availableByCurrency: { usd: 250_000 },
      asOf: new Date(1_780_000_000 * 1000),
    });
    expect(bankBalanceSnapshotFromAccount(linkedAccount({ status: "disconnected" }) as never)).toEqual({ status: "failed", reason: "account_disconnected" });
    expect(bankBalanceSnapshotFromAccount(linkedAccount({ permissions: ["payment_method"] }) as never)).toEqual({ status: "failed", reason: "balances_permission_missing" });
    expect(bankBalanceSnapshotFromAccount(linkedAccount({ balance: { as_of: 1, type: "credit", credit: { used: { usd: 5 } }, current: { usd: -5 } } }) as never))
      .toEqual({ status: "failed", reason: "balance_not_cash" });
    expect(bankBalanceSnapshotFromAccount(linkedAccount({ balance: null, balance_refresh: { status: "pending", last_attempted_at: 1, next_refresh_available_at: null } }) as never))
      .toEqual({ status: "pending", nextRefreshAvailableAt: null });
    expect(bankBalanceSnapshotFromAccount(linkedAccount({ balance: null, balance_refresh: { status: "failed", last_attempted_at: 1, next_refresh_available_at: 1_780_003_600 } }) as never))
      .toEqual({ status: "failed", reason: "balance_refresh_failed" });
    expect(bankBalanceSnapshotFromAccount(linkedAccount({ balance: null, balance_refresh: null }) as never)).toEqual({ status: "pending", nextRefreshAvailableAt: null });
  });

  it("returns the balance on the account without requesting a refresh", async () => {
    const stripe = makeStripeWithFinancialConnections();
    stripe.financialConnections.accounts.retrieve.mockResolvedValueOnce(linkedAccount());
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    const snapshot = await provider.readBankBalance({ providerAccountId: "fca_1", now: new Date("2026-09-20T12:00:00.000Z") });

    expect(snapshot).toMatchObject({ status: "succeeded", availableByCurrency: { usd: 250_000 } });
    expect(stripe.financialConnections.accounts.retrieve).toHaveBeenCalledWith("fca_1");
    expect(stripe.financialConnections.accounts.refresh).not.toHaveBeenCalled();
  });

  it("requests one balance refresh when the account carries none, and none while a refresh is already pending", async () => {
    const stripe = makeStripeWithFinancialConnections();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    const pendingRefresh = { status: "pending", last_attempted_at: 1_780_000_000, next_refresh_available_at: null };

    stripe.financialConnections.accounts.retrieve.mockResolvedValueOnce(linkedAccount({ balance: null, balance_refresh: null }));
    stripe.financialConnections.accounts.refresh.mockResolvedValueOnce(linkedAccount({ balance: null, balance_refresh: pendingRefresh }));
    expect(await provider.readBankBalance({ providerAccountId: "fca_1", now: new Date() })).toEqual({ status: "pending", nextRefreshAvailableAt: null });
    expect(stripe.financialConnections.accounts.refresh).toHaveBeenCalledWith("fca_1", { features: ["balance"] });

    stripe.financialConnections.accounts.retrieve.mockResolvedValueOnce(linkedAccount({ balance: null, balance_refresh: pendingRefresh }));
    expect(await provider.readBankBalance({ providerAccountId: "fca_1", now: new Date() })).toEqual({ status: "pending", nextRefreshAvailableAt: null });
    expect(stripe.financialConnections.accounts.refresh).toHaveBeenCalledTimes(1);
  });

  it("classifies a provider failure while reading a balance", async () => {
    const stripe = makeStripeWithFinancialConnections();
    stripe.financialConnections.accounts.retrieve.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ type: "api_error", message: "socket hang up" }));
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });

    await expect(provider.readBankBalance({ providerAccountId: "fca_1", now: new Date() })).rejects.toMatchObject({ code: "DROPSHIP_STRIPE_UNREACHABLE" });
  });

  it("parses a refreshed-balance webhook into a snapshot for the account it names", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_refresh_1",
      type: "financial_connections.account.refreshed_balance",
      data: { object: linkedAccount({ balance: { as_of: 1_780_100_000, type: "cash", cash: { available: { usd: 90_000 } }, current: { usd: 90_000 } } }) },
    });

    const event = await provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "sig" });

    expect(event).toEqual({
      kind: "bank_balance_refreshed",
      providerEventId: "evt_refresh_1",
      eventType: "financial_connections.account.refreshed_balance",
      providerAccountId: "fca_1",
      snapshot: { status: "succeeded", availableByCurrency: { usd: 90_000 }, asOf: new Date(1_780_100_000 * 1000) },
    });
  });
});

describe("StripeDropshipFundingProvider disputes (funding design phase 4)", () => {
  /** A Stripe dispute event as the SDK delivers it, with the fields the wallet reads. */
  function disputeEvent(type: string, dispute: Record<string, unknown> = {}) {
    return {
      id: "evt_dp_1",
      type,
      data: {
        object: {
          id: "dp_1",
          object: "dispute",
          amount: 5000,
          currency: "usd",
          charge: "ch_1",
          payment_intent: "pi_1",
          reason: "fraudulent",
          status: "needs_response",
          ...dispute,
        },
      },
    };
  }

  async function parse(event: unknown) {
    const stripe = makeStripeDouble();
    stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    const provider = new StripeDropshipFundingProvider({ stripeClient: stripe, webhookSecret: "whsec_test" });
    return provider.parseWebhookEvent({ rawBody: Buffer.from("{}"), signature: "sig" });
  }

  it("turns a chargeback that has taken the funds into a reversal the wallet can post", async () => {
    await expect(parse(disputeEvent("charge.dispute.created"))).resolves.toEqual({
      kind: "wallet_funding_disputed",
      providerEventId: "evt_dp_1",
      eventType: "charge.dispute.created",
      reversal: {
        provider: "stripe",
        providerEventId: "evt_dp_1",
        providerDisputeId: "dp_1",
        providerPaymentIntentId: "pi_1",
        amountCents: 5000,
        currency: "USD",
        status: "needs_response",
        reason: "fraudulent",
        fundsWithdrawn: true,
      },
    });
  });

  it("reports an inquiry as opened but not withdrawn, and a funds_withdrawn event as withdrawn whatever the status says", async () => {
    expect(await parse(disputeEvent("charge.dispute.created", { status: "warning_needs_response", reason: null })))
      .toMatchObject({ kind: "wallet_funding_disputed", reversal: { status: "warning_needs_response", reason: null, fundsWithdrawn: false } });
    expect(await parse(disputeEvent("charge.dispute.funds_withdrawn", { status: "warning_under_review" })))
      .toMatchObject({ kind: "wallet_funding_disputed", eventType: "charge.dispute.funds_withdrawn", reversal: { fundsWithdrawn: true } });
    expect(await parse(disputeEvent("charge.dispute.updated", { status: "under_review" })))
      .toMatchObject({ kind: "wallet_funding_disputed", reversal: { status: "under_review", fundsWithdrawn: true } });
  });

  it("turns a closed dispute into an outcome: won or funds_reinstated bring the money back, lost does not", async () => {
    await expect(parse(disputeEvent("charge.dispute.closed", { status: "won" }))).resolves.toEqual({
      kind: "wallet_funding_dispute_closed",
      providerEventId: "evt_dp_1",
      eventType: "charge.dispute.closed",
      outcome: {
        provider: "stripe",
        providerEventId: "evt_dp_1",
        providerDisputeId: "dp_1",
        providerPaymentIntentId: "pi_1",
        amountCents: 5000,
        currency: "USD",
        status: "won",
        fundsReinstated: true,
      },
    });
    expect(await parse(disputeEvent("charge.dispute.closed", { status: "lost" })))
      .toMatchObject({ kind: "wallet_funding_dispute_closed", outcome: { status: "lost", fundsReinstated: false } });
    expect(await parse(disputeEvent("charge.dispute.closed", { status: "warning_closed" })))
      .toMatchObject({ outcome: { status: "warning_closed", fundsReinstated: false } });
    expect(await parse(disputeEvent("charge.dispute.funds_reinstated", { status: "under_review" })))
      .toMatchObject({ eventType: "charge.dispute.funds_reinstated", outcome: { fundsReinstated: true } });
  });

  it("reads an expanded payment intent by its id, trims the reason to what the wallet stores, and treats a blank reason as none", async () => {
    expect(await parse(disputeEvent("charge.dispute.created", { payment_intent: { id: "pi_expanded" }, reason: `  ${"x".repeat(200)}  ` })))
      .toMatchObject({ reversal: { providerPaymentIntentId: "pi_expanded", reason: "x".repeat(120) } });
    expect(await parse(disputeEvent("charge.dispute.created", { reason: "   " }))).toMatchObject({ reversal: { reason: null } });
  });

  it("ignores a dispute that names no payment intent, or carries a status the wallet does not know", async () => {
    expect(await parse(disputeEvent("charge.dispute.created", { payment_intent: null }))).toEqual({
      kind: "ignored", providerEventId: "evt_dp_1", eventType: "charge.dispute.created", reason: "dispute_without_payment_intent",
    });
    expect(await parse(disputeEvent("charge.dispute.closed", { status: "something_new" }))).toEqual({
      kind: "ignored", providerEventId: "evt_dp_1", eventType: "charge.dispute.closed", reason: "unknown_dispute_status:something_new",
    });
  });

  it("refuses a dispute whose amount is not a positive integer rather than posting a guess", async () => {
    for (const amount of [0, -5000, 12.5]) {
      await expect(parse(disputeEvent("charge.dispute.created", { amount })))
        .rejects.toMatchObject({ code: "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID" });
    }
  });
});
