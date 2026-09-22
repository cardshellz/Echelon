import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipWalletService } from "../../application/dropship-wallet-service";
import { toDropshipStripeError } from "../../infrastructure/dropship-stripe-error";
import { registerDropshipWalletRoutes } from "../../interfaces/http/dropship-wallet.routes";
import type { StripeDropshipFundingProvider } from "../../infrastructure/dropship-stripe-funding.provider";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, _res: Response, next: NextFunction) => {
    // These routes read only `session.dropship.memberId`. The rest of the real
    // principal is irrelevant here, so the stub asserts the narrow shape rather
    // than fabricating auth fields the assertions never look at.
    req.session = { dropship: { memberId: "member-1" } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const SETUP_SESSION_URL = "/api/dropship/wallet/funding-methods/stripe/setup-session";

describe("dropship wallet routes error responses", () => {
  let server: { url: string; close: () => Promise<void> };
  let setupSessionError: unknown;
  let logged: Array<{ level: string; payload: Record<string, unknown> }>;

  beforeEach(async () => {
    setupSessionError = new Error("not set");
    logged = [];
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((line: unknown) => {
        logged.push({ level, payload: JSON.parse(String(line)) });
      });
    }
    const service = {
      createStripeFundingSetupSessionForMember: async () => {
        throw setupSessionError;
      },
    } as unknown as DropshipWalletService;
    server = await startServer(buildApp(service));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("returns a declined card as 402 with its structured code instead of an opaque 500", async () => {
    setupSessionError = toDropshipStripeError("customers.create", new Stripe.errors.StripeCardError({
      type: "card_error",
      message: "Your card was declined.",
      code: "card_declined",
      decline_code: "generic_decline",
      statusCode: 402,
      requestId: "req_declined",
    }));

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(402);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_STRIPE_CARD_DECLINED",
      message: "Your card was declined.",
      context: { classification: "permanent", stripeRequestId: "req_declined" },
    });
  });

  it("returns a transient Stripe failure as a retryable 5xx so webhook senders retry it", async () => {
    setupSessionError = toDropshipStripeError("createStripeSetupSession", new Stripe.errors.StripeConnectionError({
      type: "api_error",
      message: "socket hang up",
    }));

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("DROPSHIP_STRIPE_UNREACHABLE");
    expect(logged.some((entry) => entry.level === "error"
      && entry.payload.code === "DROPSHIP_STRIPE_UNREACHABLE")).toBe(true);
  });

  it("logs every 4xx wallet failure without escalating it to error level", async () => {
    setupSessionError = new DropshipError(
      "DROPSHIP_WALLET_INVALID_INPUT",
      "Dropship wallet input failed validation.",
      { issues: [] },
    );

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(400);
    const entry = logged.find((candidate) => candidate.payload.code === "DROPSHIP_WALLET_INVALID_INPUT");
    expect(entry?.level).toBe("warn");
    expect(entry?.payload.context).toMatchObject({ httpStatus: 400 });
  });

  it("keeps the generic 500 for an unrecognized failure but records its identity in the log", async () => {
    setupSessionError = new TypeError("relation \"dropship.dropship_funding_methods\" does not exist");

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(500);
    // The response stays deliberately generic: an unrecognized failure has no
    // vendor-safe explanation. The log is where the cause has to be findable.
    expect(response.body.error).toEqual({
      code: "DROPSHIP_WALLET_INTERNAL_ERROR",
      message: "Dropship wallet request failed.",
    });
    const entry = logged.find((candidate) => candidate.payload.code === "DROPSHIP_WALLET_INTERNAL_ERROR");
    expect(entry?.level).toBe("error");
    expect(entry?.payload.context).toMatchObject({
      httpStatus: 500,
      classification: "permanent",
      errorName: "TypeError",
      errorMessage: "relation \"dropship.dropship_funding_methods\" does not exist",
    });
  });
});

describe("dropship wallet routes card fee exposure", () => {
  const now = "2026-09-16T12:00:00.000Z";
  let server: { url: string; close: () => Promise<void> };
  let configureInputs: unknown[];
  let configureError: unknown;
  let walletError: unknown;

  beforeEach(async () => {
    configureInputs = [];
    configureError = null;
    walletError = null;
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const service = {
      getWalletForMember: async () => {
        if (walletError) throw walletError;
        return {
          account: { walletAccountId: 1, vendorId: 10, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active", createdAt: now, updatedAt: now },
          autoReload: null,
          fundingMethods: [],
          recentLedger: [],
          cardFundingFeeBps: 300,
          usdcBaseDepositAddress: "0x1111111111111111111111111111111111111111",
          limits: {
            autoReloadMinTriggerCents: 7_500,
            autoReloadMinAmountCents: 12_500,
            manualFundingMinCents: 2_000,
            manualFundingMaxCents: 400_000,
            defaultPaymentHoldTimeoutMinutes: 1_440,
            holdExpiryWarningMinutes: 90,
            caseTierMinimumCents: 55_000,
            advanceFeeBps: 150,
            advanceCapCents: 75_000,
            tierChangeGraceDays: 21,
          },
        };
      },
      getWalletForVendor: async () => ({
        account: { walletAccountId: 1, vendorId: 10, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active", createdAt: now, updatedAt: now },
        autoReload: null,
        fundingMethods: [],
        recentLedger: [],
        cardFundingFeeBps: 300,
        usdcBaseDepositAddress: null,
        limits: {
          autoReloadMinTriggerCents: 7_500,
          autoReloadMinAmountCents: 12_500,
          manualFundingMinCents: 2_000,
          manualFundingMaxCents: 400_000,
          defaultPaymentHoldTimeoutMinutes: 1_440,
          holdExpiryWarningMinutes: 90,
          caseTierMinimumCents: 55_000,
          advanceFeeBps: 150,
          advanceCapCents: 75_000,
          tierChangeGraceDays: 21,
        },
      }),
      configureAutoReload: async (input: unknown) => {
        configureInputs.push(input);
        if (configureError) throw configureError;
        return {
          autoReloadSettingId: 1, vendorId: 10, fundingMethodId: 10, enabled: true, minimumBalanceCents: 5000,
          maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, createdAt: now, updatedAt: now,
        };
      },
      createStripeWalletFundingSessionForMember: async () => ({
        checkoutUrl: "https://checkout.stripe.test/cs_2", providerSessionId: "cs_2", providerCustomerId: "cus_1",
        amountCents: 10_000, cardFeeCents: 300, chargedCents: 10_300, currency: "USD", expiresAt: null,
      }),
    } as unknown as DropshipWalletService;
    server = await startServer(buildApp(service));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("exposes the card fee rate on the wallet so the page can quote before anything is charged", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.cardFundingFeeBps).toBe(300);
  });

  it("exposes the USDC deposit address so the page can show where to send funds", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.usdcBaseDepositAddress).toBe("0x1111111111111111111111111111111111111111");
    // The vendor's own deposit position (funding design phase 6): nothing offered here.
    expect(response.body.wallet.usdcDeposit).toEqual({
      offered: false, watched: false, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe", address: null,
    });
  });

  it("serves the wallet policy limits so the page stops falling back to a hard-coded table", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    // Field names are the contract the portal's wallet view adapter parses
    // (client/src/lib/dropship-wallet-view-adapter.ts, rawLimitsSchema).
    expect(response.body.wallet.limits).toEqual({
      autoReloadMinTriggerCents: 7_500,
      autoReloadMinAmountCents: 12_500,
      manualFundingMinCents: 2_000,
      manualFundingMaxCents: 400_000,
      defaultPaymentHoldTimeoutMinutes: 1_440,
      holdExpiryWarningMinutes: 90,
      caseTierMinimumCents: 55_000,
      advanceFeeBps: 150,
      advanceCapCents: 75_000,
      tierChangeGraceDays: 21,
      // Served so the wallet page knows whether "link it again" is a real fix.
      bankBalanceReadOffered: false,
    });
  });

  it("serves the listing tiers the vendor is held to, with the raise in grace and its date", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.listingTiers).toEqual({
      pack: { tier: "pack", eligible: true, reason: null, minimumCents: 7_500, shortfallCents: 0, upcoming: null },
      case: {
        tier: "case", eligible: false, reason: "case_tier_balance_below_minimum", minimumCents: 55_000, shortfallCents: 55_000,
        upcoming: { minimumCents: 75_000, policyVersion: 3, enforcesAt: "2026-09-30T12:00:00.000Z", affectsVendor: true },
      },
      generatedAt: "2026-09-16T12:00:00.000Z",
    });
  });

  it("leaves the admin per-vendor wallet serializer unchanged", async () => {
    // Staff read the policy through GET /api/dropship/admin/wallet/policy, so
    // the ops screen's shape does not move when the vendor view gains limits.
    const response = await jsonRequest(`${server.url}/api/dropship/admin/wallet/vendors/10`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.limits).toBeUndefined();
    expect(response.body.wallet.listingTiers).toBeUndefined();
    expect(response.body.wallet.cardFundingFeeBps).toBe(300);
  });

  it("returns the fee and the total alongside the checkout session", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet/funding/stripe/checkout-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fundingMethodId: 10, amountCents: 10_000 }),
    });

    expect(response.status).toBe(200);
    expect(response.body.fundingSession).toMatchObject({ amountCents: 10_000, cardFeeCents: 300, chargedCents: 10_300 });
  });

  it("passes the acknowledged fee rate through to the service", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet/auto-reload`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 300 }),
    });

    expect(response.status).toBe(200);
    expect(configureInputs).toEqual([expect.objectContaining({ vendorId: 10, acknowledgedCardFeeBps: 300 })]);
  });

  it("passes the top-up amount through and leaves the bound to the service when the client sends none (funding design phase 5)", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet/auto-reload`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, fundingMethodId: 10, minimumBalanceCents: 10_000, topUpAmountCents: 25_000, paymentHoldTimeoutMinutes: 1440, acknowledgedCardFeeBps: 300 }),
    });

    expect(response.status).toBe(200);
    expect(configureInputs).toEqual([{
      vendorId: 10, fundingMethodId: 10, enabled: true, minimumBalanceCents: 10_000, topUpAmountCents: 25_000,
      paymentHoldTimeoutMinutes: 1440, acknowledgedCardFeeBps: 300,
    }]);
    // Not defaulted to null here: the service derives the bound only when nothing was sent.
    expect((configureInputs[0] as Record<string, unknown>).maxSingleReloadCents).toBeUndefined();
  });

  it("reports a stale fee acknowledgement as a conflict the vendor resolves by re-reading, not as bad input", async () => {
    configureError = new DropshipError(
      "DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE",
      "The card fee shown has changed.",
      { acknowledgedCardFeeBps: 250, cardFundingFeeBps: 300 },
    );

    const response = await jsonRequest(`${server.url}/api/dropship/wallet/auto-reload`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 250 }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE");
  });

  it("reports a misconfigured fee rate as unavailable so nothing is charged at a rate nobody set", async () => {
    walletError = new DropshipError(
      "DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED",
      "Dropship card funding fee is misconfigured.",
      { env: "DROPSHIP_CARD_FUNDING_FEE_BPS", value: "abc" },
    );

    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED");
  });
});

type UsdcRouteService = NonNullable<Parameters<typeof registerDropshipWalletRoutes>[4]>;

/** A deployment with no USDC key: nothing offered, nothing watched, no address to hand out. */
function fakeUsdcDepositService(overrides: Partial<UsdcRouteService> = {}): UsdcRouteService {
  return {
    offering: () => ({ offered: false, watched: false, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe" as const, keyFingerprint: null }),
    verificationAddress: () => null,
    getDepositAddress: async () => null,
    assignDepositAddressForMember: async () => {
      throw new DropshipError("DROPSHIP_USDC_DEPOSITS_NOT_OFFERED", "USDC deposits are not offered: no account key is configured.", { classification: "permanent" });
    },
    runCustodyCheck: async () => ({
      outcome: "not_configured" as const,
      checkedAt: new Date("2026-09-21T10:00:00.000Z"),
      chainId: 8453,
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      addresses: [],
      totals: { expectedAtomicUnits: "0", onChainAtomicUnits: "0", unrecordedAtomicUnits: "0", reviewCount: 0, unreadCount: 0 },
    }),
    ...overrides,
  };
}

function buildApp(service: DropshipWalletService, usdcDepositService: UsdcRouteService = fakeUsdcDepositService()): express.Express {
  const app = express();
  app.use(express.json());
  registerDropshipWalletRoutes(app, service, {} as StripeDropshipFundingProvider, { resolveForVendor: fakeListingTierView }, usdcDepositService);
  return app;
}

/** The tier standing the vendor view composes in; pinned so the serializer's shape is asserted, not the rules. */
async function fakeListingTierView(vendorId: number) {
  const generatedAt = new Date("2026-09-16T12:00:00.000Z");
  const enforcesAt = new Date("2026-09-30T12:00:00.000Z");
  return {
    vendorId,
    minimums: {
      pack: { tier: "pack" as const, minimumCents: 7_500, version: 2, upcoming: null },
      case: { tier: "case" as const, minimumCents: 55_000, version: 2, upcoming: { minimumCents: 75_000, version: 3, enforcesAt } },
    },
    eligibility: {
      pack: { tier: "pack" as const, eligible: true, reason: null, minimumCents: 7_500, shortfallCents: 0, upcoming: null },
      case: {
        tier: "case" as const, eligible: false, reason: "case_tier_balance_below_minimum" as const, minimumCents: 55_000, shortfallCents: 55_000,
        upcoming: { minimumCents: 75_000, version: 3, enforcesAt, affectsVendor: true },
      },
    },
    funding: { minimumBalanceCents: 7_500, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD" },
    generatedAt,
  };
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

describe("dropship wallet routes advance and bank balance (funding design phase 3)", () => {
  const now = "2026-09-20T12:00:00.000Z";
  const advance = {
    policy: { feeBps: 100, capCents: 50_000, capSource: "policy" },
    sources: [{ fundingMethodId: 100, pendingCents: 40_000, accountHolderType: "company", balanceVerified: true, priorPullSettled: true, eligible: true, reasons: [] }],
    eligiblePendingCents: 40_000,
    allowanceCents: 40_000,
    exposureCents: 0,
    headroomCents: 40_000,
    reasons: [],
  };
  let server: { url: string; close: () => Promise<void> };
  let calls: Array<{ method: string; input: unknown }>;
  let webhookEvent: unknown;
  let verifyError: unknown;
  let registrationReplayed: boolean;

  beforeEach(async () => {
    calls = [];
    webhookEvent = null;
    verifyError = null;
    registrationReplayed = false;
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const wallet = {
      account: { walletAccountId: 1, vendorId: 10, availableBalanceCents: 0, pendingBalanceCents: 40_000, currency: "USD", status: "active", createdAt: now, updatedAt: now },
      autoReload: null,
      fundingMethods: [],
      recentLedger: [],
      cardFundingFeeBps: 300,
      usdcBaseDepositAddress: null,
      limits: {
        autoReloadMinTriggerCents: 7_500, autoReloadMinAmountCents: 12_500, manualFundingMinCents: 2_000, manualFundingMaxCents: 400_000,
        defaultPaymentHoldTimeoutMinutes: 1_440, holdExpiryWarningMinutes: 90, caseTierMinimumCents: 55_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14,
      },
      advance,
    };
    const service = {
      getWalletForMember: async () => wallet,
      getWalletForVendor: async () => wallet,
      registerFundingMethod: async (input: { vendorId: number; rail: string }) => {
        calls.push({ method: "registerFundingMethod", input });
        return { fundingMethod: { fundingMethodId: 100, vendorId: input.vendorId, rail: input.rail }, idempotentReplay: registrationReplayed };
      },
      creditFunding: async (input: unknown) => {
        calls.push({ method: "creditFunding", input });
        return {};
      },
      verifyBankBalanceForFundingMethod: async (input: unknown) => {
        calls.push({ method: "verifyBankBalanceForFundingMethod", input });
        if (verifyError) throw verifyError;
        return { outcome: "recorded" };
      },
      recordBankBalanceRefresh: async (input: unknown) => {
        calls.push({ method: "recordBankBalanceRefresh", input });
        return { outcome: "recorded" };
      },
      recordWalletFundingReversal: async (input: unknown) => {
        calls.push({ method: "recordWalletFundingReversal", input });
        return { outcome: "reversed" };
      },
      recordWalletFundingDisputeOutcome: async (input: unknown) => {
        calls.push({ method: "recordWalletFundingDisputeOutcome", input });
        return { outcome: "reinstated" };
      },
    } as unknown as DropshipWalletService;
    const provider = {
      parseWebhookEvent: async () => webhookEvent,
    } as unknown as StripeDropshipFundingProvider;
    const app = express();
    app.use(express.json());
    // The real app captures the raw body for signature checks; the fake provider ignores it.
    app.use((req, _res, next) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from("{}");
      next();
    });
    registerDropshipWalletRoutes(app, service, provider, { resolveForVendor: fakeListingTierView }, fakeUsdcDepositService());
    server = await startServer(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("serves the vendor's advance position exactly as the service assessed it", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.advance).toEqual(advance);
  });

  async function postWebhook() {
    return jsonRequest(`${server.url}/api/webhooks/dropship/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "sig" },
      body: "{}",
    });
  }

  it("reads the balance behind a bank account right after it is registered, and never for a card", async () => {
    webhookEvent = { kind: "funding_method_setup_completed", providerEventId: "evt_1", eventType: "setup_intent.succeeded", fundingMethod: { vendorId: 10, rail: "stripe_ach" } };
    expect((await postWebhook()).status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual(["registerFundingMethod", "verifyBankBalanceForFundingMethod"]);
    expect(calls[1].input).toEqual({ vendorId: 10, fundingMethodId: 100, source: "link", providerEventId: "evt_1" });

    calls = [];
    webhookEvent = { kind: "funding_method_setup_completed", providerEventId: "evt_2", eventType: "setup_intent.succeeded", fundingMethod: { vendorId: 10, rail: "stripe_card" } };
    expect((await postWebhook()).status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual(["registerFundingMethod"]);

    // A replayed setup event, or a later transfer from the same account, registers nothing new and reads nothing.
    calls = [];
    registrationReplayed = true;
    webhookEvent = { kind: "wallet_funding_recorded", providerEventId: "evt_4", eventType: "payment_intent.processing", fundingMethod: { vendorId: 10, rail: "stripe_ach" }, fundingCredit: { amountCents: 5_000 } };
    expect((await postWebhook()).status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual(["registerFundingMethod", "creditFunding"]);
  });

  it("acknowledges the webhook even when the balance read throws: the registration is the durable work", async () => {
    verifyError = new Error("stripe unreachable");
    webhookEvent = { kind: "funding_method_setup_completed", providerEventId: "evt_3", eventType: "setup_intent.succeeded", fundingMethod: { vendorId: 10, rail: "stripe_ach" } };

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ received: true, action: "funding_method_setup_completed" });
  });

  it("records a refreshed balance the provider reports", async () => {
    const snapshot = { status: "succeeded", availableByCurrency: { usd: 90_000 }, asOf: now };
    webhookEvent = { kind: "bank_balance_refreshed", providerEventId: "evt_r1", eventType: "financial_connections.account.refreshed_balance", providerAccountId: "fca_1", snapshot };

    expect((await postWebhook()).status).toBe(200);
    expect(calls).toEqual([{ method: "recordBankBalanceRefresh", input: { providerAccountId: "fca_1", snapshot, providerEventId: "evt_r1" } }]);
  });

  it("hands a dispute to the wallet as a reversal, and a closed dispute as its outcome (funding design phase 4)", async () => {
    const reversal = {
      provider: "stripe", providerEventId: "evt_dp_1", providerDisputeId: "dp_1", providerPaymentIntentId: "pi_1",
      amountCents: 5_000, currency: "USD", status: "needs_response", reason: "fraudulent", fundsWithdrawn: true,
    };
    webhookEvent = { kind: "wallet_funding_disputed", providerEventId: "evt_dp_1", eventType: "charge.dispute.created", reversal };
    const disputed = await postWebhook();
    expect(disputed.status).toBe(200);
    expect(disputed.body).toEqual({ received: true, eventType: "charge.dispute.created", action: "wallet_funding_disputed" });
    expect(calls).toEqual([{ method: "recordWalletFundingReversal", input: reversal }]);

    calls = [];
    const outcome = {
      provider: "stripe", providerEventId: "evt_dp_2", providerDisputeId: "dp_1", providerPaymentIntentId: "pi_1",
      amountCents: 5_000, currency: "USD", status: "won", fundsReinstated: true,
    };
    webhookEvent = { kind: "wallet_funding_dispute_closed", providerEventId: "evt_dp_2", eventType: "charge.dispute.closed", outcome };
    const closed = await postWebhook();
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ received: true, eventType: "charge.dispute.closed", action: "wallet_funding_dispute_closed" });
    expect(calls).toEqual([{ method: "recordWalletFundingDisputeOutcome", input: outcome }]);
  });
});

describe("dropship wallet routes USDC deposits (funding design phase 6)", () => {
  const now = new Date("2026-09-21T10:00:00.000Z");
  const wallet = {
    account: { walletAccountId: 1, vendorId: 10, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active", createdAt: now, updatedAt: now },
    autoReload: null,
    fundingMethods: [],
    recentLedger: [],
    cardFundingFeeBps: 300,
    usdcBaseDepositAddress: null,
    limits: {
      autoReloadMinTriggerCents: 7_500, autoReloadMinAmountCents: 12_500, manualFundingMinCents: 2_000, manualFundingMaxCents: 400_000,
      defaultPaymentHoldTimeoutMinutes: 1_440, holdExpiryWarningMinutes: 90, caseTierMinimumCents: 55_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14,
    },
    advance: null,
  };
  const address = {
    depositAddressId: 7, vendorId: 10, chainId: 8453, keyFingerprint: "3bf95407", derivationIndex: 0,
    address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", checksumAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", assignedAt: now,
  };
  const offering = { offered: true, watched: true, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe" as const, keyFingerprint: "3bf95407" };
  let server: { url: string; close: () => Promise<void> };
  let assigned: string[];
  let created: boolean;

  beforeEach(async () => {
    assigned = [];
    created = true;
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const service = { getWalletForMember: async () => wallet } as unknown as DropshipWalletService;
    server = await startServer(buildApp(service, fakeUsdcDepositService({
      offering: () => offering,
      verificationAddress: () => address.checksumAddress,
      getDepositAddress: async (vendorId) => (vendorId === 10 ? address : null),
      assignDepositAddressForMember: async (memberId) => {
        assigned.push(memberId);
        return { address, created };
      },
      runCustodyCheck: async () => ({
        outcome: "checked" as const,
        checkedAt: now,
        chainId: 8453,
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        addresses: [{ depositAddressId: 7, vendorId: 10, address: address.address, checksumAddress: address.checksumAddress, expectedAtomicUnits: "25123456", onChainAtomicUnits: "25123456", creditedCents: 2_512, observationCount: 1, status: "holding" as const, unrecordedAtomicUnits: "0" }],
        totals: { expectedAtomicUnits: "25123456", onChainAtomicUnits: "25123456", unrecordedAtomicUnits: "0", reviewCount: 0, unreadCount: 0 },
      }),
    })));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("composes the vendor's own deposit address and the watcher's timing into the wallet view without assigning anything", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);
    expect(response.status).toBe(200);
    expect(response.body.wallet.usdcDeposit).toEqual({
      offered: true, watched: true, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe",
      address: { address: address.address, checksumAddress: address.checksumAddress, assignedAt: "2026-09-21T10:00:00.000Z" },
    });
    expect(assigned).toEqual([]);
  });

  it("hands the signed-in member their address: 201 the first time, 200 every time after", async () => {
    const first = await jsonRequest(`${server.url}/api/dropship/wallet/usdc/deposit-address`, { method: "POST" });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      created: true,
      usdcDeposit: expect.objectContaining({ offered: true, address: expect.objectContaining({ checksumAddress: address.checksumAddress }) }),
    });
    created = false;
    const again = await jsonRequest(`${server.url}/api/dropship/wallet/usdc/deposit-address`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(assigned).toEqual(["member-1", "member-1"]);
  });

  it("answers 503 with the structured code when USDC deposits are not offered", async () => {
    const bare = await startServer(buildApp({ getWalletForMember: async () => wallet } as unknown as DropshipWalletService));
    try {
      const response = await jsonRequest(`${bare.url}/api/dropship/wallet/usdc/deposit-address`, { method: "POST" });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("DROPSHIP_USDC_DEPOSITS_NOT_OFFERED");
    } finally {
      await bare.close();
    }
  });

  it("serves the custody report to staff with the key fingerprint and the index-0 verification address", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/admin/wallet/usdc/custody`);
    expect(response.status).toBe(200);
    expect(response.body.custody).toEqual({
      outcome: "checked",
      checkedAt: "2026-09-21T10:00:00.000Z",
      chainId: 8453,
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      offered: true,
      watched: true,
      keyFingerprint: "3bf95407",
      verificationAddress: address.checksumAddress,
      addresses: [expect.objectContaining({ vendorId: 10, status: "holding", onChainAtomicUnits: "25123456", creditedCents: 2_512 })],
      totals: { expectedAtomicUnits: "25123456", onChainAtomicUnits: "25123456", unrecordedAtomicUnits: "0", reviewCount: 0, unreadCount: 0 },
    });
  });

  it("maps the node's failures to 502 and a missing observation to 404", async () => {
    const failing = await startServer(buildApp({ getWalletForMember: async () => wallet } as unknown as DropshipWalletService, fakeUsdcDepositService({
      runCustodyCheck: async () => { throw new DropshipError("DROPSHIP_USDC_RPC_TRANSPORT_FAILED", "The node could not be reached.", { classification: "transient" }); },
      assignDepositAddressForMember: async () => { throw new DropshipError("DROPSHIP_USDC_LEDGER_ENTRY_NOT_FOUND", "missing", { classification: "permanent" }); },
    })));
    try {
      expect((await jsonRequest(`${failing.url}/api/dropship/admin/wallet/usdc/custody`)).status).toBe(502);
      expect((await jsonRequest(`${failing.url}/api/dropship/wallet/usdc/deposit-address`, { method: "POST" })).status).toBe(404);
    } finally {
      await failing.close();
    }
  });
});

describe("dropship wallet routes funding method removal", () => {
  const REMOVE_URL = "/api/dropship/wallet/funding-methods";
  let server: { url: string; close: () => Promise<void> };
  let removeFundingMethodForMember: ReturnType<typeof vi.fn>;
  const archivedMethod = {
    fundingMethodId: 30,
    vendorId: 7,
    rail: "stripe_ach",
    status: "archived",
    providerCustomerId: "cus_1",
    providerPaymentMethodId: "pm_bank",
    usdcWalletAddress: null,
    displayLabel: "Chase ending in 5990",
    isDefault: false,
    metadata: { accountHolderType: "company", archivedByMemberId: "member-1", providerDetach: { outcome: "detached", errorCode: null, recordedAt: "2026-09-22T01:00:00.000Z" } },
    createdAt: new Date("2026-09-20T12:00:00.000Z"),
    updatedAt: new Date("2026-09-22T01:00:00.000Z"),
  };

  beforeEach(async () => {
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    removeFundingMethodForMember = vi.fn();
    const service = { removeFundingMethodForMember } as unknown as DropshipWalletService;
    server = await startServer(buildApp(service));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("archives the method for the signed-in member and reports the provider outcome", async () => {
    removeFundingMethodForMember.mockResolvedValue({ fundingMethod: archivedMethod, idempotentReplay: false, providerDetach: "detached" });

    const response = await jsonRequest(`${server.url}${REMOVE_URL}/30`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      fundingMethod: {
        fundingMethodId: 30,
        rail: "stripe_ach",
        status: "archived",
        displayLabel: "Chase ending in 5990",
        isDefault: false,
        usdcWalletAddress: null,
        accountHolderType: "company",
        createdAt: "2026-09-20T12:00:00.000Z",
        updatedAt: "2026-09-22T01:00:00.000Z",
      },
      idempotentReplay: false,
      providerDetach: "detached",
    });
    expect(removeFundingMethodForMember).toHaveBeenCalledWith("member-1", { fundingMethodId: 30 });
  });

  it("returns each removal refusal as 409 with its structured code", async () => {
    for (const code of [
      "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE",
      "DROPSHIP_FUNDING_METHOD_HAS_PENDING_FUNDING",
      "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD",
    ]) {
      removeFundingMethodForMember.mockRejectedValueOnce(new DropshipError(code, "Refused.", { vendorId: 7, fundingMethodId: 30, classification: "permanent" }));
      const response = await jsonRequest(`${server.url}${REMOVE_URL}/30`, { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(response.body.error).toMatchObject({ code, context: { classification: "permanent" } });
    }
  });

  it("returns 404 for a method that is not on the wallet and 400 for an id that is not a positive whole number", async () => {
    removeFundingMethodForMember.mockRejectedValueOnce(new DropshipError("DROPSHIP_FUNDING_METHOD_NOT_FOUND", "Not found.", { vendorId: 7, fundingMethodId: 31 }));
    expect((await jsonRequest(`${server.url}${REMOVE_URL}/31`, { method: "DELETE" })).status).toBe(404);

    const bad = await jsonRequest(`${server.url}${REMOVE_URL}/abc`, { method: "DELETE" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("DROPSHIP_WALLET_INVALID_PATH_PARAMETER");
    expect(removeFundingMethodForMember).toHaveBeenCalledTimes(1);
  });
});
