import Stripe from "stripe";
import { formatFeeRate } from "../../../../shared/dropship/wallet-funding-fee";
import { DropshipError } from "../domain/errors";
import {
  FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY,
  FUNDING_METHOD_FINANCIAL_CONNECTIONS_ACCOUNT_KEY,
} from "../domain/funding-method";
import { makeDropshipWalletLogger } from "../application/dropship-wallet-service";
import type { DropshipLogger } from "../application/dropship-ports";
import { logStripeCallFailure, toDropshipStripeError } from "./dropship-stripe-error";
import {
  DROPSHIP_DISPUTE_STATUSES,
  disputeOutcomeFor,
  disputeWithdrawsFunds,
  type DropshipDisputeStatus,
} from "../domain/funding-reversal";
import type {
  CreditDropshipWalletFundingInput,
  DropshipBankBalanceSnapshot,
  DropshipStripeAutoReloadPaymentIntent,
  DropshipStripeFundingSetupRail,
  DropshipStripeRailAvailability,
  DropshipStripeWalletFundingSession,
  DropshipWalletFundingCardFee,
  DropshipWalletFundingCardFeeRate,
  DropshipWalletFundingProvider,
  HandleDropshipAutoReloadInput,
  RecordDropshipWalletDisputeOutcomeInput,
  RecordDropshipWalletFundingFailureInput,
  RecordDropshipWalletFundingReversalInput,
  RegisterDropshipFundingMethodInput,
} from "../application/dropship-wallet-service";

const STRIPE_API_VERSION = "2024-12-18.acacia";
const STRIPE_FUNDING_SETUP_TYPE = "dropship_funding_setup";
const STRIPE_WALLET_FUNDING_TYPE = "dropship_wallet_funding";
/**
 * Fee breakdown carried on every card PaymentIntent. The webhook re-derives
 * the wallet credit from these rather than from the charged amount, so the
 * fee never lands in the wallet.
 */
const METADATA_WALLET_CREDIT_CENTS = "wallet_credit_cents";
const METADATA_CARD_FEE_CENTS = "card_fee_cents";
const METADATA_CARD_FEE_BPS = "card_fee_bps";

export type DropshipStripeFundingWebhookEvent =
  | {
      kind: "funding_method_setup_completed";
      providerEventId: string;
      eventType: string;
      fundingMethod: RegisterDropshipFundingMethodInput;
    }
  | {
      kind: "wallet_funding_recorded";
      providerEventId: string;
      eventType: string;
      fundingMethod: RegisterDropshipFundingMethodInput;
      fundingCredit: Omit<CreditDropshipWalletFundingInput, "fundingMethodId">;
    }
  | {
      kind: "wallet_funding_failed";
      providerEventId: string;
      eventType: string;
      failure: RecordDropshipWalletFundingFailureInput;
    }
  | {
      /** A dispute on a payment: a card chargeback or an ACH debit returned after it cleared. */
      kind: "wallet_funding_disputed";
      providerEventId: string;
      eventType: string;
      reversal: RecordDropshipWalletFundingReversalInput;
    }
  | {
      /** A dispute closed or its funds came back. */
      kind: "wallet_funding_dispute_closed";
      providerEventId: string;
      eventType: string;
      outcome: RecordDropshipWalletDisputeOutcomeInput;
    }
  | {
      /** Financial Connections reported a refreshed balance for a linked bank account. */
      kind: "bank_balance_refreshed";
      providerEventId: string;
      eventType: string;
      providerAccountId: string;
      snapshot: DropshipBankBalanceSnapshot;
    }
  | {
      kind: "ignored";
      providerEventId: string;
      eventType: string;
      reason: string;
    };

export class StripeDropshipFundingProvider implements DropshipWalletFundingProvider {
  private stripeClient: Stripe | null = null;

  constructor(
    private readonly config: {
      secretKey?: string;
      webhookSecret?: string;
      stripeClient?: Stripe;
    } = {},
    /** Injected so a test can assert what a Stripe refusal records. */
    private readonly logger: DropshipLogger = makeDropshipWalletLogger(),
  ) {}

  /**
   * Which funding rails the Stripe account can actually run.
   *
   * A rail that is configured in our environment can still be refused by
   * Stripe because the account never enabled it, and Stripe explains that
   * only in prose on the failing request. Reading the account's capabilities
   * turns the same fact into something the readiness page can state before a
   * vendor ever meets it. Read-only: it retrieves the platform account and
   * changes nothing.
   */
  async readRailAvailability(): Promise<DropshipStripeRailAvailability> {
    const stripe = this.getStripe();
    const account = await this.callStripe("readRailAvailability", () => stripe.accounts.retrieve());
    return {
      outcome: "read",
      accountId: account.id ?? null,
      cardPayments: account.capabilities?.card_payments ?? null,
      achPayments: account.capabilities?.us_bank_account_ach_payments ?? null,
      reason: null,
    };
  }

  async createStripeSetupSession(input: {
    vendorId: number;
    memberId: string;
    rail: DropshipStripeFundingSetupRail;
    customerEmail: string | null;
    customerName: string;
    existingProviderCustomerId: string | null;
    successUrl: string;
    cancelUrl: string;
    now: Date;
  }) {
    const stripe = this.getStripe();
    const customerId = input.existingProviderCustomerId
      ?? await this.createCustomer({
        email: input.customerEmail,
        name: input.customerName,
        vendorId: input.vendorId,
        memberId: input.memberId,
      });
    const metadata = {
      type: STRIPE_FUNDING_SETUP_TYPE,
      dropship_vendor_id: String(input.vendorId),
      member_id: input.memberId,
      requested_rail: input.rail,
      requested_at: input.now.toISOString(),
    };
    const session = await this.callStripe("createStripeSetupSession", () => stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: paymentMethodTypesForRail(input.rail),
      ...paymentMethodOptionsForRail(input.rail),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      setup_intent_data: {
        metadata,
      },
    }));

    if (!session.url) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_SETUP_SESSION_URL_MISSING",
        "Stripe did not return a checkout URL for funding setup.",
        { vendorId: input.vendorId, rail: input.rail, providerSessionId: session.id },
      );
    }

    return {
      checkoutUrl: session.url,
      providerSessionId: session.id,
      providerCustomerId: customerId,
      expiresAt: typeof session.expires_at === "number" ? new Date(session.expires_at * 1000) : null,
    };
  }

  async createStripeWalletFundingSession(input: {
    vendorId: number;
    memberId: string;
    fundingMethodId: number;
    rail: DropshipStripeFundingSetupRail;
    amountCents: number;
    cardFee: DropshipWalletFundingCardFeeRate | null;
    currency: string;
    customerEmail: string | null;
    customerName: string;
    existingProviderCustomerId: string | null;
    providerPaymentMethodId: string | null;
    successUrl: string;
    cancelUrl: string;
    now: Date;
  }): Promise<DropshipStripeWalletFundingSession> {
    const stripe = this.getStripe();
    const customerId = input.existingProviderCustomerId
      ?? await this.createCustomer({
        email: input.customerEmail,
        name: input.customerName,
        vendorId: input.vendorId,
        memberId: input.memberId,
      });
    const metadata = {
      type: STRIPE_WALLET_FUNDING_TYPE,
      dropship_vendor_id: String(input.vendorId),
      member_id: input.memberId,
      funding_method_id: String(input.fundingMethodId),
      requested_rail: input.rail,
      requested_provider_payment_method_id: input.providerPaymentMethodId ?? "",
      requested_at: input.now.toISOString(),
      ...cardFeeMetadata(input.amountCents, input.cardFee),
    };
    const currency = input.currency.toLowerCase();
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency,
          product_data: {
            name: "Card Shellz dropship wallet funding",
          },
          unit_amount: input.amountCents,
        },
        quantity: 1,
      },
    ];
    // The fee is its own line so the hosted page and the receipt show it
    // apart from the amount that lands in the wallet.
    if (input.cardFee && input.cardFee.feeCents > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: {
            name: `Card processing fee (${formatFeeRate(input.cardFee.feeBps)})`,
          },
          unit_amount: input.cardFee.feeCents,
        },
        quantity: 1,
      });
    }
    const session = await this.callStripe("createStripeWalletFundingSession", () => stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      payment_method_types: paymentMethodTypesForRail(input.rail),
      ...paymentMethodOptionsForRail(input.rail),
      line_items: lineItems,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata,
      },
    }));

    if (!session.url) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_FUNDING_SESSION_URL_MISSING",
        "Stripe did not return a checkout URL for wallet funding.",
        { vendorId: input.vendorId, rail: input.rail, providerSessionId: session.id },
      );
    }

    const cardFeeCents = input.cardFee?.feeCents ?? 0;
    return {
      checkoutUrl: session.url,
      providerSessionId: session.id,
      providerCustomerId: customerId,
      amountCents: input.amountCents,
      cardFeeCents,
      chargedCents: input.amountCents + cardFeeCents,
      currency: input.currency,
      expiresAt: typeof session.expires_at === "number" ? new Date(session.expires_at * 1000) : null,
    };
  }

  async createStripeAutoReloadPaymentIntent(input: {
    vendorId: number;
    fundingMethodId: number;
    rail: DropshipStripeFundingSetupRail;
    amountCents: number;
    cardFee: DropshipWalletFundingCardFeeRate | null;
    currency: string;
    providerCustomerId: string;
    providerPaymentMethodId: string;
    reason: HandleDropshipAutoReloadInput["reason"];
    intakeId: number | null;
    requiredBalanceCents: number | null;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipStripeAutoReloadPaymentIntent> {
    const stripe = this.getStripe();
    const metadata = {
      type: STRIPE_WALLET_FUNDING_TYPE,
      dropship_vendor_id: String(input.vendorId),
      funding_method_id: String(input.fundingMethodId),
      requested_rail: input.rail,
      requested_provider_payment_method_id: input.providerPaymentMethodId,
      auto_reload: "true",
      auto_reload_reason: input.reason,
      intake_id: input.intakeId ? String(input.intakeId) : "",
      required_balance_cents: input.requiredBalanceCents ? String(input.requiredBalanceCents) : "",
      requested_at: input.now.toISOString(),
      ...cardFeeMetadata(input.amountCents, input.cardFee),
    };
    const paymentIntent = await this.callStripe("createStripeAutoReloadPaymentIntent", () => stripe.paymentIntents.create({
      amount: input.amountCents + (input.cardFee?.feeCents ?? 0),
      currency: input.currency.toLowerCase(),
      customer: input.providerCustomerId,
      payment_method: input.providerPaymentMethodId,
      payment_method_types: paymentMethodTypesForRail(input.rail),
      confirm: true,
      off_session: true,
      metadata,
    }, {
      idempotencyKey: input.idempotencyKey,
    }));
    const status = walletFundingStatusForPaymentIntent(paymentIntent);
    if (!status) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_AUTO_RELOAD_PAYMENT_FAILED",
        "Stripe auto-reload payment did not enter a fundable state.",
        {
          vendorId: input.vendorId,
          fundingMethodId: input.fundingMethodId,
          providerPaymentIntentId: paymentIntent.id,
          paymentIntentStatus: paymentIntent.status,
          lastPaymentErrorCode: paymentIntent.last_payment_error?.code ?? null,
        },
      );
    }
    return {
      providerPaymentIntentId: paymentIntent.id,
      status,
      amountCents: amountForPaymentIntent(paymentIntent, status),
      currency: paymentIntent.currency.toUpperCase(),
      externalTransactionId: idFromExpandable(paymentIntent.latest_charge),
    };
  }

  async parseWebhookEvent(input: {
    rawBody: Buffer;
    signature: string;
  }): Promise<DropshipStripeFundingWebhookEvent> {
    const stripe = this.getStripe();
    const webhookSecret = this.getWebhookSecret();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(input.rawBody, input.signature, webhookSecret);
    } catch (error) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_WEBHOOK_SIGNATURE_INVALID",
        "Stripe webhook signature verification failed.",
        { provider: "stripe", detail: error instanceof Error ? error.message : "unknown" },
      );
    }

    if (event.type === "checkout.session.completed") {
      return this.parseCheckoutSessionCompleted(event);
    }
    if (event.type === "setup_intent.succeeded") {
      return this.parseSetupIntentSucceeded(event);
    }
    if (event.type === "payment_intent.processing" || event.type === "payment_intent.succeeded") {
      return this.parsePaymentIntentFundingEvent(event);
    }
    if (event.type === "payment_intent.payment_failed") {
      return this.parsePaymentIntentFundingFailureEvent(event);
    }
    if (
      event.type === "charge.dispute.created"
      || event.type === "charge.dispute.updated"
      || event.type === "charge.dispute.funds_withdrawn"
    ) {
      return this.parseDisputeEvent(event, "reversal");
    }
    if (event.type === "charge.dispute.closed" || event.type === "charge.dispute.funds_reinstated") {
      return this.parseDisputeEvent(event, "outcome");
    }
    if (event.type === "financial_connections.account.refreshed_balance") {
      const account = event.data.object as Stripe.FinancialConnections.Account;
      return {
        kind: "bank_balance_refreshed",
        providerEventId: event.id,
        eventType: event.type,
        providerAccountId: account.id,
        snapshot: bankBalanceSnapshotFromAccount(account),
      };
    }

    return {
      kind: "ignored",
      providerEventId: event.id,
      eventType: event.type,
      reason: "unsupported_event_type",
    };
  }

  /**
   * A dispute event, as the wallet needs it. Every dispute on the Stripe
   * account arrives here, so the wallet decides whether the payment is one of
   * its funding credits; the provider only says what Stripe said. A dispute
   * that names no payment intent cannot be matched and is ignored.
   */
  private parseDisputeEvent(event: Stripe.Event, kind: "reversal" | "outcome"): DropshipStripeFundingWebhookEvent {
    const dispute = event.data.object as Stripe.Dispute;
    const providerPaymentIntentId = idFromExpandable(dispute.payment_intent);
    if (!providerPaymentIntentId) {
      return { kind: "ignored", providerEventId: event.id, eventType: event.type, reason: "dispute_without_payment_intent" };
    }
    const status = parseDisputeStatus(dispute.status);
    if (!status) {
      return { kind: "ignored", providerEventId: event.id, eventType: event.type, reason: `unknown_dispute_status:${String(dispute.status)}` };
    }
    if (!Number.isSafeInteger(dispute.amount) || dispute.amount <= 0) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
        "Stripe dispute carries an amount that is not a positive integer.",
        { providerEventId: event.id, disputeId: dispute.id, amount: dispute.amount },
      );
    }
    const common = {
      provider: "stripe" as const,
      providerEventId: event.id,
      providerDisputeId: dispute.id,
      providerPaymentIntentId,
      amountCents: dispute.amount,
      currency: dispute.currency.toUpperCase(),
      status,
    };
    if (kind === "reversal") {
      return {
        kind: "wallet_funding_disputed",
        providerEventId: event.id,
        eventType: event.type,
        reversal: {
          ...common,
          reason: typeof dispute.reason === "string" && dispute.reason.trim() ? dispute.reason.trim().slice(0, 120) : null,
          fundsWithdrawn: event.type === "charge.dispute.funds_withdrawn" || disputeWithdrawsFunds(status),
        },
      };
    }
    return {
      kind: "wallet_funding_dispute_closed",
      providerEventId: event.id,
      eventType: event.type,
      outcome: {
        ...common,
        fundsReinstated: event.type === "charge.dispute.funds_reinstated" || disputeOutcomeFor(status) === "won",
      },
    };
  }

  /**
   * The balance behind a bank account linked through Financial Connections.
   * The account is read as it stands; when it carries no balance and no
   * refresh is in flight, one is requested, and the provider reports the
   * result through `financial_connections.account.refreshed_balance`.
   */
  async readBankBalance(input: { providerAccountId: string; now: Date }): Promise<DropshipBankBalanceSnapshot> {
    const stripe = this.getStripe();
    const account = await this.callStripe(
      "financialConnections.accounts.retrieve",
      () => stripe.financialConnections.accounts.retrieve(input.providerAccountId),
    );
    const snapshot = bankBalanceSnapshotFromAccount(account);
    if (snapshot.status !== "pending" || account.balance_refresh?.status === "pending") {
      return snapshot;
    }
    const refreshed = await this.callStripe(
      "financialConnections.accounts.refresh",
      () => stripe.financialConnections.accounts.refresh(input.providerAccountId, { features: ["balance"] }),
    );
    return bankBalanceSnapshotFromAccount(refreshed);
  }

  private parsePaymentIntentFundingFailureEvent(event: Stripe.Event): DropshipStripeFundingWebhookEvent {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    if (paymentIntent.metadata?.type !== STRIPE_WALLET_FUNDING_TYPE) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: "not_dropship_wallet_funding",
      };
    }

    const metadata = paymentIntent.metadata ?? {};
    const vendorId = parsePositiveInteger(metadata.dropship_vendor_id ?? metadata.vendor_id, "dropship_vendor_id");
    const fundingMethodId = parseOptionalPositiveInteger(metadata.funding_method_id, "funding_method_id");
    const rail = railFromMetadata(metadata.requested_rail);
    return {
      kind: "wallet_funding_failed",
      providerEventId: event.id,
      eventType: event.type,
      failure: {
        vendorId,
        fundingMethodId,
        rail,
        amountCents: amountCentsForPaymentIntentFailure(paymentIntent),
        currency: paymentIntent.currency.toUpperCase(),
        provider: "stripe",
        providerEventId: event.id,
        providerPaymentIntentId: paymentIntent.id,
        providerStatus: paymentIntent.status,
        failureCode: paymentIntent.last_payment_error?.code ?? null,
        failureMessage: paymentIntent.last_payment_error?.message ?? null,
        autoReload: metadata.auto_reload === "true",
        autoReloadReason: autoReloadReasonFromMetadata(metadata.auto_reload_reason),
        intakeId: parseOptionalPositiveInteger(metadata.intake_id, "intake_id"),
        idempotencyKey: `stripe-funding-failed:${paymentIntent.id}`,
      },
    };
  }

  private async parseCheckoutSessionCompleted(event: Stripe.Event): Promise<DropshipStripeFundingWebhookEvent> {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "setup" || session.metadata?.type !== STRIPE_FUNDING_SETUP_TYPE) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: "not_dropship_funding_setup",
      };
    }

    const setupIntentId = idFromExpandable(session.setup_intent);
    if (!setupIntentId) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_SETUP_INTENT_MISSING",
        "Stripe setup checkout completed without a setup intent id.",
        { providerEventId: event.id, providerSessionId: session.id },
      );
    }

    const setupIntent = await this.callStripe("setupIntents.retrieve", () => this.getStripe().setupIntents.retrieve(setupIntentId));
    return this.buildFundingMethodEvent({
      event,
      setupIntent,
      setupSessionId: session.id,
      fallbackCustomerId: idFromExpandable(session.customer),
      fallbackMetadata: session.metadata ?? {},
    });
  }

  private async parseSetupIntentSucceeded(event: Stripe.Event): Promise<DropshipStripeFundingWebhookEvent> {
    const setupIntent = event.data.object as Stripe.SetupIntent;
    if (setupIntent.metadata?.type !== STRIPE_FUNDING_SETUP_TYPE) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: "not_dropship_funding_setup",
      };
    }

    return this.buildFundingMethodEvent({
      event,
      setupIntent,
      setupSessionId: null,
      fallbackCustomerId: null,
      fallbackMetadata: {},
    });
  }

  private async buildFundingMethodEvent(input: {
    event: Stripe.Event;
    setupIntent: Stripe.SetupIntent;
    setupSessionId: string | null;
    fallbackCustomerId: string | null;
    fallbackMetadata: Record<string, string>;
  }): Promise<DropshipStripeFundingWebhookEvent> {
    const metadata = {
      ...input.fallbackMetadata,
      ...(input.setupIntent.metadata ?? {}),
    };
    const vendorId = parsePositiveInteger(metadata.dropship_vendor_id ?? metadata.vendor_id, "dropship_vendor_id");
    const paymentMethodId = idFromExpandable(input.setupIntent.payment_method);
    if (!paymentMethodId) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_PAYMENT_METHOD_MISSING",
        "Stripe setup intent completed without a payment method id.",
        { providerEventId: input.event.id, setupIntentId: input.setupIntent.id, vendorId },
      );
    }

    const paymentMethod = await this.callStripe("paymentMethods.retrieve", () => this.getStripe().paymentMethods.retrieve(paymentMethodId));
    const rail = railFromStripePaymentMethod(paymentMethod);
    if (!rail) {
      return {
        kind: "ignored",
        providerEventId: input.event.id,
        eventType: input.event.type,
        reason: `unsupported_payment_method:${paymentMethod.type}`,
      };
    }

    return {
      kind: "funding_method_setup_completed",
      providerEventId: input.event.id,
      eventType: input.event.type,
      fundingMethod: {
        vendorId,
        rail,
        status: "active",
        providerCustomerId: idFromExpandable(input.setupIntent.customer) ?? input.fallbackCustomerId,
        providerPaymentMethodId: paymentMethod.id,
        usdcWalletAddress: null,
        displayLabel: displayLabelForPaymentMethod(paymentMethod),
        isDefault: false,
        metadata: sanitizedPaymentMethodMetadata({
          paymentMethod,
          setupIntentId: input.setupIntent.id,
          setupSessionId: input.setupSessionId,
          providerEventId: input.event.id,
          requestedRail: metadata.requested_rail ?? null,
        }),
      },
    };
  }

  private async parsePaymentIntentFundingEvent(event: Stripe.Event): Promise<DropshipStripeFundingWebhookEvent> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    if (paymentIntent.metadata?.type !== STRIPE_WALLET_FUNDING_TYPE) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: "not_dropship_wallet_funding",
      };
    }

    const metadata = paymentIntent.metadata ?? {};
    const vendorId = parsePositiveInteger(metadata.dropship_vendor_id ?? metadata.vendor_id, "dropship_vendor_id");
    const fundingMethodId = parseOptionalPositiveInteger(metadata.funding_method_id, "funding_method_id");
    const paymentMethodId = idFromExpandable(paymentIntent.payment_method);
    if (!paymentMethodId) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_PAYMENT_METHOD_MISSING",
        "Stripe wallet funding event did not include a payment method id.",
        { providerEventId: event.id, paymentIntentId: paymentIntent.id, vendorId },
      );
    }

    const paymentMethod = await this.callStripe("paymentMethods.retrieve", () => this.getStripe().paymentMethods.retrieve(paymentMethodId));
    const rail = railFromStripePaymentMethod(paymentMethod);
    if (!rail) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: `unsupported_payment_method:${paymentMethod.type}`,
      };
    }

    const status = event.type === "payment_intent.succeeded" ? "settled" : "pending";
    const chargedCents = amountForPaymentIntent(paymentIntent, status);
    const cardFee = cardFeeFromMetadata({ metadata, rail, paymentIntentId: paymentIntent.id, chargedCents });
    const amountCents = cardFee ? chargedCents - cardFee.feeCents : chargedCents;
    const currency = paymentIntent.currency.toUpperCase();
    const fundingMethod: RegisterDropshipFundingMethodInput = {
      vendorId,
      rail,
      status: "active",
      providerCustomerId: idFromExpandable(paymentIntent.customer),
      providerPaymentMethodId: paymentMethod.id,
      usdcWalletAddress: null,
      displayLabel: displayLabelForPaymentMethod(paymentMethod),
      isDefault: false,
      metadata: sanitizedPaymentMethodMetadata({
        paymentMethod,
        setupIntentId: "",
        setupSessionId: null,
        providerEventId: event.id,
        requestedRail: metadata.requested_rail ?? null,
      }),
    };
    return {
      kind: "wallet_funding_recorded",
      providerEventId: event.id,
      eventType: event.type,
      fundingMethod,
      fundingCredit: {
        vendorId,
        walletAccountId: undefined,
        rail,
        status,
        amountCents,
        cardFee: cardFee ?? undefined,
        currency,
        referenceType: "stripe_payment_intent",
        referenceId: paymentIntent.id,
        externalTransactionId: idFromExpandable(paymentIntent.latest_charge) ?? undefined,
        metadata: {
          provider: "stripe",
          providerEventId: event.id,
          eventType: event.type,
          paymentIntentStatus: paymentIntent.status,
          fundingMethodId,
          providerPaymentMethodId: paymentMethod.id,
        },
        idempotencyKey: `stripe-funding:${paymentIntent.id}`,
      },
    };
  }

  private async createCustomer(input: {
    email: string | null;
    name: string;
    vendorId: number;
    memberId: string;
  }): Promise<string> {
    const customer = await this.callStripe("customers.create", () => this.getStripe().customers.create({
      email: input.email ?? undefined,
      name: input.name,
      metadata: {
        dropship_vendor_id: String(input.vendorId),
        member_id: input.memberId,
      },
    }));
    return customer.id;
  }

  /**
   * Single entry point for every Stripe SDK call.
   *
   * A Stripe failure that escapes unwrapped reaches the HTTP layer as an
   * unrecognized error, which the wallet routes can only report as an opaque
   * 500 with no code — the vendor learns nothing and the log carries no
   * classification. Routing calls through here guarantees the failure arrives
   * as a classified DropshipError. Errors that are not from Stripe pass
   * through untouched so a bug in our own code is not misreported as a
   * payment-provider fault.
   */
  private async callStripe<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // The thrown error is sanitized for the vendor, so Stripe's own reason is
      // recorded here or it is lost: without it an operator sees only a status
      // code and cannot tell a misconfigured account from a malformed request.
      logStripeCallFailure(this.logger, operation, error);
      throw toDropshipStripeError(operation, error);
    }
  }

  private getStripe(): Stripe {
    if (this.stripeClient) return this.stripeClient;
    if (this.config.stripeClient) {
      this.stripeClient = this.config.stripeClient;
      return this.stripeClient;
    }
    const secretKey = this.config.secretKey ?? process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_SECRET_NOT_CONFIGURED",
        "Stripe funding is not configured.",
        { env: "STRIPE_SECRET_KEY" },
      );
    }
    this.stripeClient = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
      typescript: true,
    });
    return this.stripeClient;
  }

  private getWebhookSecret(): string {
    const secret =
      this.config.webhookSecret
      ?? process.env.DROPSHIP_STRIPE_WEBHOOK_SECRET
      ?? process.env.STRIPE_DROPSHIP_WEBHOOK_SECRET
      ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_WEBHOOK_SECRET_NOT_CONFIGURED",
        "Stripe webhook secret is not configured.",
        { env: "DROPSHIP_STRIPE_WEBHOOK_SECRET" },
      );
    }
    return secret;
  }
}

export function createStripeDropshipFundingProviderFromEnv(): StripeDropshipFundingProvider {
  return new StripeDropshipFundingProvider();
}

function paymentMethodTypesForRail(rail: DropshipStripeFundingSetupRail): Array<"card" | "us_bank_account"> {
  return rail === "stripe_card" ? ["card"] : ["us_bank_account"];
}

function railFromStripePaymentMethod(paymentMethod: Stripe.PaymentMethod): RegisterDropshipFundingMethodInput["rail"] | null {
  if (paymentMethod.type === "card") return "stripe_card";
  if (paymentMethod.type === "us_bank_account") return "stripe_ach";
  return null;
}

function displayLabelForPaymentMethod(paymentMethod: Stripe.PaymentMethod): string {
  if (paymentMethod.type === "card" && paymentMethod.card) {
    const brand = titleCase(paymentMethod.card.brand || "card");
    return `${brand} ending in ${paymentMethod.card.last4}`;
  }
  if (paymentMethod.type === "us_bank_account" && paymentMethod.us_bank_account) {
    const bankName = paymentMethod.us_bank_account.bank_name || "Bank account";
    return `${bankName} ending in ${paymentMethod.us_bank_account.last4}`;
  }
  return "Stripe funding method";
}

function amountForPaymentIntent(
  paymentIntent: Stripe.PaymentIntent,
  status: CreditDropshipWalletFundingInput["status"],
): number {
  if (status === "settled" && Number.isSafeInteger(paymentIntent.amount_received) && paymentIntent.amount_received > 0) {
    return paymentIntent.amount_received;
  }
  return paymentIntent.amount;
}

function walletFundingStatusForPaymentIntent(
  paymentIntent: Stripe.PaymentIntent,
): CreditDropshipWalletFundingInput["status"] | null {
  if (paymentIntent.status === "succeeded") return "settled";
  if (paymentIntent.status === "processing") return "pending";
  return null;
}

function amountCentsForPaymentIntentFailure(paymentIntent: Stripe.PaymentIntent): number {
  if (Number.isSafeInteger(paymentIntent.amount) && paymentIntent.amount > 0) {
    return paymentIntent.amount;
  }
  throw new DropshipError(
    "DROPSHIP_STRIPE_WALLET_FUNDING_AMOUNT_INVALID",
    "Stripe wallet funding failure event is missing a valid amount.",
    { providerPaymentIntentId: paymentIntent.id, amount: paymentIntent.amount },
  );
}

function cardFeeMetadata(
  creditCents: number,
  cardFee: DropshipWalletFundingCardFeeRate | null,
): Record<string, string> {
  if (!cardFee) return {};
  return {
    [METADATA_WALLET_CREDIT_CENTS]: String(creditCents),
    [METADATA_CARD_FEE_CENTS]: String(cardFee.feeCents),
    [METADATA_CARD_FEE_BPS]: String(cardFee.feeBps),
  };
}

/**
 * The fee breakdown a PaymentIntent was created with, or null when it carries
 * none: an ACH charge, or a card charge from before the fee existed, which
 * credits the full amount as it always did. A breakdown that does not
 * reconcile with the charged amount is refused rather than guessed at — the
 * credit would be wrong either way, and a human has to look.
 */
function cardFeeFromMetadata(input: {
  metadata: Record<string, string | undefined>;
  rail: RegisterDropshipFundingMethodInput["rail"];
  paymentIntentId: string;
  chargedCents: number;
}): DropshipWalletFundingCardFee | null {
  const keys = [METADATA_WALLET_CREDIT_CENTS, METADATA_CARD_FEE_CENTS, METADATA_CARD_FEE_BPS];
  if (keys.every((key) => input.metadata[key] === undefined || input.metadata[key] === "")) {
    return null;
  }
  const creditCents = parseNonNegativeInteger(input.metadata[METADATA_WALLET_CREDIT_CENTS], METADATA_WALLET_CREDIT_CENTS);
  const feeCents = parseNonNegativeInteger(input.metadata[METADATA_CARD_FEE_CENTS], METADATA_CARD_FEE_CENTS);
  const feeBps = parseNonNegativeInteger(input.metadata[METADATA_CARD_FEE_BPS], METADATA_CARD_FEE_BPS);
  if (input.rail !== "stripe_card" || creditCents + feeCents !== input.chargedCents) {
    throw new DropshipError(
      "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      "Stripe wallet funding fee breakdown does not reconcile with the charged amount.",
      {
        providerPaymentIntentId: input.paymentIntentId,
        rail: input.rail,
        creditCents,
        feeCents,
        feeBps,
        chargedCents: input.chargedCents,
      },
    );
  }
  return { feeCents, feeBps, chargedCents: input.chargedCents };
}

function railFromMetadata(value: unknown): RegisterDropshipFundingMethodInput["rail"] | null {
  if (value === "stripe_card" || value === "stripe_ach" || value === "usdc_base") {
    return value;
  }
  return null;
}

function autoReloadReasonFromMetadata(value: unknown): HandleDropshipAutoReloadInput["reason"] | null {
  if (value === "minimum_balance" || value === "payment_hold") {
    return value;
  }
  return null;
}

function sanitizedPaymentMethodMetadata(input: {
  paymentMethod: Stripe.PaymentMethod;
  setupIntentId: string;
  setupSessionId: string | null;
  providerEventId: string;
  requestedRail: string | null;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    provider: "stripe",
    paymentMethodType: input.paymentMethod.type,
    setupIntentId: input.setupIntentId || null,
    setupSessionId: input.setupSessionId,
    providerEventId: input.providerEventId,
    requestedRail: input.requestedRail,
  };
  if (input.paymentMethod.type === "card" && input.paymentMethod.card) {
    return {
      ...base,
      brand: input.paymentMethod.card.brand,
      last4: input.paymentMethod.card.last4,
      expMonth: input.paymentMethod.card.exp_month,
      expYear: input.paymentMethod.card.exp_year,
    };
  }
  if (input.paymentMethod.type === "us_bank_account" && input.paymentMethod.us_bank_account) {
    return {
      ...base,
      bankName: input.paymentMethod.us_bank_account.bank_name,
      last4: input.paymentMethod.us_bank_account.last4,
      accountType: input.paymentMethod.us_bank_account.account_type,
      // individual | company | null. A company account can return an ACH
      // debit as unauthorized for 2 banking days; a consumer account for about
      // 60. The pending-ACH advance is only offered against the former, so the
      // value is kept exactly as Stripe reports it and read back through
      // fundingMethodAccountHolderType, which treats anything else as unknown.
      [FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY]: input.paymentMethod.us_bank_account.account_holder_type ?? null,
      // The Financial Connections account behind the bank account, when it was
      // linked through the provider's connection flow (null for manual entry
      // and micro-deposits). Its balance is read for the pending-ACH advance.
      [FUNDING_METHOD_FINANCIAL_CONNECTIONS_ACCOUNT_KEY]:
        input.paymentMethod.us_bank_account.financial_connections_account ?? null,
    };
  }
  return base;
}

/**
 * For a bank account, the vendor links it through Financial Connections with
 * the `balances` permission beside the mandatory `payment_method`: a balance
 * read is one of the three facts the pending-ACH advance requires. Cards get
 * no options. The verification method is left to Stripe's default so a bank
 * the connection flow does not support can still be added by micro-deposits
 * (that account simply never qualifies for the advance).
 */
function paymentMethodOptionsForRail(
  rail: DropshipStripeFundingSetupRail,
): Pick<Stripe.Checkout.SessionCreateParams, "payment_method_options"> {
  if (rail !== "stripe_ach") return {};
  return {
    payment_method_options: {
      us_bank_account: {
        financial_connections: { permissions: ["payment_method", "balances"] },
      },
    },
  };
}

/**
 * What a Financial Connections account says about its balance, independent
 * of any wallet currency. Amounts are Stripe's integer minor units keyed by
 * lowercase ISO currency code, passed through as reported.
 */
export function bankBalanceSnapshotFromAccount(
  account: Pick<Stripe.FinancialConnections.Account, "status" | "permissions" | "balance" | "balance_refresh">,
): DropshipBankBalanceSnapshot {
  if (account.status !== "active") {
    return { status: "failed", reason: `account_${account.status}` };
  }
  if (!(account.permissions ?? []).includes("balances")) {
    return { status: "failed", reason: "balances_permission_missing" };
  }
  const balance = account.balance;
  if (balance) {
    if (balance.type !== "cash" || !balance.cash?.available) {
      return { status: "failed", reason: "balance_not_cash" };
    }
    const availableByCurrency: Record<string, number> = {};
    for (const [currency, amount] of Object.entries(balance.cash.available)) {
      if (Number.isSafeInteger(amount)) availableByCurrency[currency.toLowerCase()] = amount;
    }
    if (!Number.isSafeInteger(balance.as_of) || balance.as_of <= 0) {
      return { status: "failed", reason: "balance_as_of_invalid" };
    }
    return { status: "succeeded", availableByCurrency, asOf: new Date(balance.as_of * 1000) };
  }
  const refresh = account.balance_refresh;
  if (refresh?.status === "failed") {
    return { status: "failed", reason: "balance_refresh_failed" };
  }
  return {
    status: "pending",
    nextRefreshAvailableAt: typeof refresh?.next_refresh_available_at === "number"
      ? new Date(refresh.next_refresh_available_at * 1000)
      : null,
  };
}

function parseDisputeStatus(value: unknown): DropshipDisputeStatus | null {
  return typeof value === "string" && (DROPSHIP_DISPUTE_STATUSES as readonly string[]).includes(value)
    ? (value as DropshipDisputeStatus)
    : null;
}

function idFromExpandable(value: string | { id?: string } | null | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) {
    return value.id;
  }
  return null;
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return parsePositiveInteger(value, field);
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new DropshipError(
      "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      "Stripe webhook metadata is missing a required amount.",
      { field },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError(
      "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      "Stripe webhook metadata contains an invalid amount.",
      { field, value },
    );
  }
  return parsed;
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new DropshipError(
      "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      "Stripe webhook metadata is missing required dropship identifiers.",
      { field },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      "Stripe webhook metadata contains an invalid dropship identifier.",
      { field, value },
    );
  }
  return parsed;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
