import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { DropshipError } from "../../domain/errors";
import { fundingMethodAccountHolderType } from "../../domain/funding-method";
import { FUNDING_METHOD_REMOVAL_REFUSAL_CODES } from "../../domain/funding-method-removal";
import { STRIPE_BANK_BALANCE_PERMISSION_ENV, makeDropshipWalletLogger, type DropshipWalletService } from "../../application/dropship-wallet-service";
import { httpStatusForDropshipStripeErrorCode } from "../../infrastructure/dropship-stripe-error";
import { createDropshipWalletServiceFromEnv } from "../../infrastructure/dropship-wallet.factory";
import { createDropshipListingTierServiceFromEnv } from "../../infrastructure/dropship-listing-tier.factory";
import type { DropshipListingTierService, DropshipVendorListingTierView } from "../../application/dropship-listing-tier-service";
import type { DropshipListingTierStatus } from "../../domain/listing-tiers";
import {
  createStripeDropshipFundingProviderFromEnv,
  type StripeDropshipFundingProvider,
} from "../../infrastructure/dropship-stripe-funding.provider";
import { requireDropshipAuth, requireDropshipSensitiveActionProof } from "./dropship-auth.routes";
import { createDropshipUsdcDepositServiceFromEnv } from "../../infrastructure/dropship-usdc-deposit.factory";
import type {
  DropshipUsdcCustodyReport,
  DropshipUsdcDepositAddressRecord,
  DropshipUsdcDepositService,
  DropshipUsdcOffering,
} from "../../application/dropship-usdc-deposit-service";

/** What the wallet routes need from the USDC deposit service (funding design phase 6). */
type UsdcDepositRouteService = Pick<
  DropshipUsdcDepositService,
  "offering" | "verificationAddress" | "getDepositAddress" | "assignDepositAddressForMember" | "runCustodyCheck"
>;

/**
 * Wallet route failures are logged here rather than at each call site so every
 * response the vendor sees has a matching structured line in the server log.
 */
const walletRouteLogger = makeDropshipWalletLogger();

export function registerDropshipWalletRoutes(
  app: Express,
  service: DropshipWalletService = createDropshipWalletServiceFromEnv(),
  stripeFundingProvider: StripeDropshipFundingProvider = createStripeDropshipFundingProviderFromEnv(),
  listingTierService: Pick<DropshipListingTierService, "resolveForVendor"> = createDropshipListingTierServiceFromEnv(),
  usdcDepositService: UsdcDepositRouteService = createDropshipUsdcDepositServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/wallet/vendors/:vendorId",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const wallet = await service.getWalletForVendor(
          parsePositiveInteger(req.params.vendorId, "vendorId"),
          { ledgerLimit: parseLedgerLimit(req.query.ledgerLimit) },
        );
        return res.json({ wallet: serializeWalletOverview(wallet) });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/wallet/manual-credit",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.creditManualFunding({
          vendorId: req.body?.vendorId,
          amountCents: req.body?.amountCents,
          currency: req.body?.currency ?? "USD",
          reason: req.body?.reason,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json({
          account: result.account,
          ledgerEntry: result.ledgerEntry,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/wallet/usdc/confirmed-credit",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.creditConfirmedUsdcFunding({
          vendorId: req.body?.vendorId,
          fundingMethodId: req.body?.fundingMethodId,
          amountCents: req.body?.amountCents,
          currency: req.body?.currency ?? "USD",
          amountAtomicUnits: req.body?.amountAtomicUnits,
          chainId: req.body?.chainId ?? 8453,
          transactionHash: req.body?.transactionHash,
          fromAddress: req.body?.fromAddress ?? null,
          toAddress: req.body?.toAddress,
          confirmations: req.body?.confirmations,
          observedAt: req.body?.observedAt,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json({
          account: result.account,
          ledgerEntry: result.ledgerEntry,
          usdcLedgerEntry: result.usdcLedgerEntry,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  for (const path of ["/api/webhooks/dropship/stripe", "/api/webhooks/stripe-dropship"]) {
    app.post(path, async (req, res) => {
      try {
        const rawBody = (req as Request & { rawBody?: unknown }).rawBody;
        if (!Buffer.isBuffer(rawBody)) {
          return res.status(400).json({
            error: {
              code: "DROPSHIP_STRIPE_WEBHOOK_RAW_BODY_MISSING",
              message: "Stripe webhook raw body was not captured.",
            },
          });
        }
        const signature = req.get("stripe-signature");
        if (!signature) {
          return res.status(400).json({
            error: {
              code: "DROPSHIP_STRIPE_WEBHOOK_SIGNATURE_MISSING",
              message: "Stripe webhook signature is required.",
            },
          });
        }

        const event = await stripeFundingProvider.parseWebhookEvent({
          rawBody,
          signature,
        });
        if (event.kind === "funding_method_setup_completed") {
          const registered = await service.registerFundingMethod(event.fundingMethod);
          await verifyBankBalanceSafely(service, registered, event.providerEventId);
        } else if (event.kind === "wallet_funding_recorded") {
          const fundingMethod = await service.registerFundingMethod(event.fundingMethod);
          await service.creditFunding({
            ...event.fundingCredit,
            fundingMethodId: fundingMethod.fundingMethod.fundingMethodId,
          });
          await verifyBankBalanceSafely(service, fundingMethod, event.providerEventId);
        } else if (event.kind === "wallet_funding_failed") {
          await service.recordWalletFundingFailure(event.failure);
        } else if (event.kind === "wallet_funding_disputed") {
          await service.recordWalletFundingReversal(event.reversal);
        } else if (event.kind === "wallet_funding_dispute_closed") {
          await service.recordWalletFundingDisputeOutcome(event.outcome);
        } else if (event.kind === "bank_balance_refreshed") {
          await service.recordBankBalanceRefresh({
            providerAccountId: event.providerAccountId,
            snapshot: event.snapshot,
            providerEventId: event.providerEventId,
          });
        }
        return res.json({
          received: true,
          eventType: event.eventType,
          action: event.kind,
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    });
  }

  app.get("/api/dropship/wallet", requireDropshipAuth, async (req, res) => {
    try {
      const wallet = await service.getWalletForMember(req.session.dropship!.memberId, {
        ledgerLimit: parseLedgerLimit(req.query.limit),
      });
      // The tiers are read after the wallet so both describe the same vendor
      // as this request resolved them; the route composes, it does not decide.
      const listingTiers = await listingTierService.resolveForVendor(wallet.account.vendorId);
      // The vendor's own USDC deposit address, if they asked for one. A read
      // never assigns; the POST below does.
      const usdcDepositAddress = await usdcDepositService.getDepositAddress(wallet.account.vendorId);
      return res.json({
        wallet: serializeVendorWalletView(wallet, listingTiers, serializeUsdcDeposit(usdcDepositService.offering(), usdcDepositAddress)),
      });
    } catch (error) {
      return sendDropshipWalletError(res, error);
    }
  });

  // The vendor's own USDC deposit address (funding design phase 6): assigned
  // the first time they ask, the same one every time after.
  app.post("/api/dropship/wallet/usdc/deposit-address", requireDropshipAuth, async (req, res) => {
    try {
      const result = await usdcDepositService.assignDepositAddressForMember(req.session.dropship!.memberId);
      return res.status(result.created ? 201 : 200).json({
        usdcDeposit: serializeUsdcDeposit(usdcDepositService.offering(), result.address),
        created: result.created,
      });
    } catch (error) {
      return sendDropshipWalletError(res, error);
    }
  });

  // Custody: every deposit address against its on-chain balance, plus the
  // key's index-0 address for the operator's one-time verification.
  app.get(
    "/api/dropship/admin/wallet/usdc/custody",
    requirePermission("dropship", "manage_operations"),
    async (_req, res) => {
      try {
        const report = await usdcDepositService.runCustodyCheck();
        return res.json({
          custody: serializeUsdcCustodyReport(report, usdcDepositService.offering(), usdcDepositService.verificationAddress()),
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/wallet/auto-reload",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("add_funding_method"),
    async (req, res) => {
      try {
        const wallet = await service.getWalletForMember(req.session.dropship!.memberId, { ledgerLimit: 1 });
        const setting = await service.configureAutoReload({
          vendorId: wallet.account.vendorId,
          fundingMethodId: req.body?.fundingMethodId ?? null,
          enabled: req.body?.enabled,
          minimumBalanceCents: req.body?.minimumBalanceCents,
          // Left out by clients that keep one number: the service derives the bound.
          maxSingleReloadCents: req.body?.maxSingleReloadCents,
          topUpAmountCents: req.body?.topUpAmountCents,
          paymentHoldTimeoutMinutes: req.body?.paymentHoldTimeoutMinutes,
          acknowledgedCardFeeBps: req.body?.acknowledgedCardFeeBps,
        });
        return res.json({ autoReload: setting });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  // The vendor's choice between spending rewards first on each order and
  // saving them (funding design phase 7). A preference, not a money movement,
  // so no proof of a sensitive action is asked for.
  app.put("/api/dropship/wallet/rewards/preference", requireDropshipAuth, async (req, res) => {
    try {
      const setting = await service.setRewardsSpendPreferenceForMember(req.session.dropship!.memberId, {
        spendRewardsFirst: req.body?.spendRewardsFirst,
      });
      return res.json({ autoReload: setting });
    } catch (error) {
      return sendDropshipWalletError(res, error);
    }
  });

  app.post(
    "/api/dropship/wallet/funding-methods/stripe/setup-session",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("add_funding_method"),
    async (req, res) => {
      try {
        const { successUrl, cancelUrl } = buildFundingSetupReturnUrls(req, req.body?.returnTo);
        const session = await service.createStripeFundingSetupSessionForMember(
          req.session.dropship!.memberId,
          {
            rail: req.body?.rail,
            successUrl,
            cancelUrl,
          },
        );
        return res.json({
          setupSession: {
            checkoutUrl: session.checkoutUrl,
            providerSessionId: session.providerSessionId,
            expiresAt: session.expiresAt,
          },
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/wallet/funding-methods/usdc-base",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("add_funding_method"),
    async (req, res) => {
      try {
        const result = await service.registerUsdcBaseFundingMethodForMember(
          req.session.dropship!.memberId,
          {
            walletAddress: req.body?.walletAddress,
            displayLabel: req.body?.displayLabel ?? null,
            isDefault: req.body?.isDefault ?? false,
          },
        );
        return res.status(result.idempotentReplay ? 200 : 201).json({
          fundingMethod: serializeFundingMethod(result.fundingMethod),
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  app.delete(
    "/api/dropship/wallet/funding-methods/:fundingMethodId",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("remove_funding_method"),
    async (req, res) => {
      try {
        const result = await service.removeFundingMethodForMember(
          req.session.dropship!.memberId,
          { fundingMethodId: parsePositiveInteger(req.params.fundingMethodId, "fundingMethodId") },
        );
        return res.json({
          fundingMethod: serializeFundingMethod(result.fundingMethod),
          idempotentReplay: result.idempotentReplay,
          providerDetach: result.providerDetach,
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/wallet/funding/stripe/checkout-session",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("wallet_funding_high_value"),
    async (req, res) => {
      try {
        const { successUrl, cancelUrl } = buildWalletFundingReturnUrls(req, req.body?.returnTo);
        const session = await service.createStripeWalletFundingSessionForMember(
          req.session.dropship!.memberId,
          {
            fundingMethodId: req.body?.fundingMethodId,
            amountCents: req.body?.amountCents,
            successUrl,
            cancelUrl,
          },
        );
        return res.json({
          fundingSession: {
            checkoutUrl: session.checkoutUrl,
            providerSessionId: session.providerSessionId,
            amountCents: session.amountCents,
            cardFeeCents: session.cardFeeCents,
            chargedCents: session.chargedCents,
            currency: session.currency,
            expiresAt: session.expiresAt,
          },
        });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );
}

function parseLedgerLimit(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_WALLET_INVALID_PATH_PARAMETER",
      `${key} must be a positive integer.`,
      { key, value },
    );
  }
  return parsed;
}

/**
 * The admin per-vendor view. Deliberately unchanged: the ops screen reads this
 * shape today and the wallet policy is served to staff through
 * `GET /api/dropship/admin/wallet/policy` instead.
 */
function serializeWalletOverview(wallet: Awaited<ReturnType<DropshipWalletService["getWalletForVendor"]>>) {
  return {
    account: wallet.account,
    autoReload: wallet.autoReload,
    fundingMethods: wallet.fundingMethods.map(serializeFundingMethod),
    recentLedger: wallet.recentLedger,
    cardFundingFeeBps: wallet.cardFundingFeeBps,
    usdcBaseDepositAddress: wallet.usdcBaseDepositAddress,
    // The pending-ACH advance position, exactly as the domain assessed it:
    // integer cents, booleans and reason codes; nothing here is a date.
    advance: wallet.advance,
  };
}

/**
 * A bank account just linked: read its balance for the pending-ACH advance.
 * Only a registration that created the method reads (a replayed event, or a
 * later transfer from the same account, registers nothing new), so each bank
 * account is read once at link time. The registration is the webhook's
 * durable work and has committed; this read is best-effort and must not turn
 * the acknowledgement into a 5xx (Stripe would only replay an event whose
 * work is done). The service logs every outcome; an unexpected throw is
 * logged here and the account stays "balance not verified" until a later
 * reading.
 */
async function verifyBankBalanceSafely(
  service: DropshipWalletService,
  registered: { fundingMethod: { vendorId: number; fundingMethodId: number; rail: string }; idempotentReplay: boolean },
  providerEventId: string,
): Promise<void> {
  const fundingMethod = registered.fundingMethod;
  if (fundingMethod.rail !== "stripe_ach" || registered.idempotentReplay) return;
  try {
    await service.verifyBankBalanceForFundingMethod({
      vendorId: fundingMethod.vendorId,
      fundingMethodId: fundingMethod.fundingMethodId,
      source: "link",
      providerEventId,
    });
  } catch (error) {
    walletRouteLogger.warn({
      code: "DROPSHIP_BANK_BALANCE_VERIFICATION_UNHANDLED",
      message: "Dropship bank balance verification threw after the funding method was registered; the account stays unverified.",
      context: {
        vendorId: fundingMethod.vendorId,
        fundingMethodId: fundingMethod.fundingMethodId,
        providerEventId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * The vendor view: the admin shape plus the wallet policy limits in force.
 *
 * `limits` is the contract the portal's wallet view adapter reads
 * (client/src/lib/dropship-wallet-view-adapter.ts, `rawLimitsSchema`); until it
 * was served the page fell back to a hard-coded table that env overrides and
 * staff edits were invisible to. Field names are passed through exactly as the
 * service resolves them — no renaming here.
 */
function serializeVendorWalletView(
  wallet: Awaited<ReturnType<DropshipWalletService["getWalletForVendor"]>>,
  listingTiers: DropshipVendorListingTierView,
  usdcDeposit: SerializedUsdcDeposit,
) {
  return {
    ...serializeWalletOverview(wallet),
    listingTiers: serializeListingTiers(listingTiers),
    usdcDeposit,
    // The soonest rewards points expire unless used (funding design phase 7):
    // integer cents (one point per cent) and an ISO instant, or null.
    rewardsNextExpiry: wallet.rewardsNextExpiry
      ? { expiresAt: wallet.rewardsNextExpiry.expiresAt.toISOString(), cents: wallet.rewardsNextExpiry.cents }
      : null,
    limits: {
      autoReloadMinTriggerCents: wallet.limits.autoReloadMinTriggerCents,
      caseTierMinimumCents: wallet.limits.caseTierMinimumCents,
      autoReloadMinAmountCents: wallet.limits.autoReloadMinAmountCents,
      manualFundingMinCents: wallet.limits.manualFundingMinCents,
      manualFundingMaxCents: wallet.limits.manualFundingMaxCents,
      // A card deposit's own minimum (funding design phase 7); bank deposits keep manualFundingMinCents.
      cardFundingMinCents: wallet.limits.cardFundingMinCents,
      defaultPaymentHoldTimeoutMinutes: wallet.limits.defaultPaymentHoldTimeoutMinutes,
      holdExpiryWarningMinutes: wallet.limits.holdExpiryWarningMinutes,
      advanceFeeBps: wallet.limits.advanceFeeBps,
      advanceCapCents: wallet.limits.advanceCapCents,
      tierChangeGraceDays: wallet.limits.tierChangeGraceDays,
      // What a settled transfer earns into the spend-only rewards balance, per
      // rail (funding design phase 7).
      rewardsRateBankBps: wallet.limits.rewardsRateBankBps,
      rewardsRateUsdcBps: wallet.limits.rewardsRateUsdcBps,
      rewardsRateCardBps: wallet.limits.rewardsRateCardBps,
      // Days until unused points expire, or null for never (funding design phase 7).
      rewardsExpiryDays: wallet.limits.rewardsExpiryDays,
      // Whether linking a bank account reads its balance at all. False means no
      // account can become advance-eligible, however many times it is relinked,
      // so the vendor must be told that rather than told to try again.
      bankBalanceReadOffered: process.env[STRIPE_BANK_BALANCE_PERMISSION_ENV] === "true",
    },
  };
}

/**
 * What is on sale and what it takes, per tier: the minimum enforced now, the
 * shortfall as things stand, and a raise still in its grace period with the
 * date it lands. Money stays integer cents; dates are ISO strings.
 */
type SerializedUsdcDeposit = ReturnType<typeof serializeUsdcDeposit>;

/**
 * The vendor's USDC deposit position (funding design phase 6): whether the
 * rail is offered and watched, the timing the watcher enforces, and the
 * address they were handed, or null until they ask for one. Field names are
 * the contract the portal's wallet view adapter parses.
 */
function serializeUsdcDeposit(offering: DropshipUsdcOffering, address: DropshipUsdcDepositAddressRecord | null) {
  return {
    offered: offering.offered,
    watched: offering.watched,
    chainId: offering.chainId,
    tokenAddress: offering.tokenAddress,
    minConfirmations: offering.minConfirmations,
    settleTag: offering.settleTag,
    address: address
      ? { address: address.address, checksumAddress: address.checksumAddress, assignedAt: address.assignedAt.toISOString() }
      : null,
  };
}

function serializeUsdcCustodyReport(report: DropshipUsdcCustodyReport, offering: DropshipUsdcOffering, verificationAddress: string | null) {
  return {
    outcome: report.outcome,
    checkedAt: report.checkedAt.toISOString(),
    chainId: report.chainId,
    tokenAddress: report.tokenAddress,
    offered: offering.offered,
    watched: offering.watched,
    keyFingerprint: offering.keyFingerprint,
    verificationAddress,
    addresses: report.addresses,
    totals: report.totals,
  };
}

function serializeListingTiers(view: DropshipVendorListingTierView) {
  const serializeTier = (status: DropshipListingTierStatus) => ({
    tier: status.tier,
    eligible: status.eligible,
    reason: status.reason,
    policyMinimumCents: status.policyMinimumCents,
    minimumCents: status.minimumCents,
    alreadyOn: status.alreadyOn,
    reserveShortfallCents: status.reserveShortfallCents,
    balanceShortfallCents: status.balanceShortfallCents,
    upcoming: status.upcoming
      ? {
          minimumCents: status.upcoming.minimumCents,
          policyVersion: status.upcoming.version,
          enforcesAt: status.upcoming.enforcesAt.toISOString(),
          affectsVendor: status.upcoming.affectsVendor,
        }
      : null,
  });
  return {
    pack: serializeTier(view.eligibility.pack),
    case: serializeTier(view.eligibility.case),
    generatedAt: view.generatedAt.toISOString(),
  };
}

function serializeFundingMethod(
  method: Awaited<ReturnType<DropshipWalletService["getWalletForVendor"]>>["fundingMethods"][number],
) {
  return {
    fundingMethodId: method.fundingMethodId,
    rail: method.rail,
    status: method.status,
    displayLabel: method.displayLabel,
    isDefault: method.isDefault,
    usdcWalletAddress: method.rail === "usdc_base" ? method.usdcWalletAddress : null,
    // Bank accounts only; null for every other rail and for bank accounts
    // linked before the holder type was recorded (migration 0683).
    accountHolderType: method.rail === "stripe_ach" ? fundingMethodAccountHolderType(method.metadata) : null,
    createdAt: method.createdAt,
    updatedAt: method.updatedAt,
  };
}

function buildFundingSetupReturnUrls(req: Request, rawReturnTo: unknown): {
  successUrl: string;
  cancelUrl: string;
} {
  return buildStripeReturnUrls(req, rawReturnTo, "funding_setup");
}

function buildWalletFundingReturnUrls(req: Request, rawReturnTo: unknown): {
  successUrl: string;
  cancelUrl: string;
} {
  return buildStripeReturnUrls(req, rawReturnTo, "wallet_funding");
}

function buildStripeReturnUrls(req: Request, rawReturnTo: unknown, statusParam: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const returnPath = parsePortalReturnPath(rawReturnTo);
  const baseUrl = parsePortalBaseUrl(req);
  const successUrl = new URL(returnPath, baseUrl);
  successUrl.searchParams.set(statusParam, "success");
  const cancelUrl = new URL(returnPath, baseUrl);
  cancelUrl.searchParams.set(statusParam, "cancelled");
  return {
    successUrl: successUrl.toString(),
    cancelUrl: cancelUrl.toString(),
  };
}

function parsePortalReturnPath(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "/wallet";
  }
  if (typeof value !== "string") {
    throw new DropshipError(
      "DROPSHIP_FUNDING_RETURN_PATH_INVALID",
      "Funding setup return path must be a relative portal path.",
    );
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > 500
    || !trimmed.startsWith("/")
    || trimmed.startsWith("//")
    || trimmed.includes("\\")
    || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    throw new DropshipError(
      "DROPSHIP_FUNDING_RETURN_PATH_INVALID",
      "Funding setup return path must be a relative portal path.",
    );
  }
  return trimmed;
}

function parsePortalBaseUrl(req: Request): string {
  const configured = process.env.DROPSHIP_PORTAL_URL || process.env.VENDOR_PORTAL_URL;
  const rawBaseUrl = configured?.trim() || `${req.protocol}://${req.get("host")}`;
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new DropshipError(
      "DROPSHIP_FUNDING_PORTAL_URL_INVALID",
      "Funding setup portal URL must be an absolute URL.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DropshipError(
      "DROPSHIP_FUNDING_PORTAL_URL_INVALID",
      "Funding setup portal URL must use http or https.",
    );
  }
  return url.toString();
}

function sendDropshipWalletError(res: Response, error: unknown) {
  if (error instanceof DropshipError) {
    const status = statusForDropshipWalletError(error.code);
    // 5xx needs a human or a retry; 4xx is the caller's own input. Both are
    // recorded: wallet routes are vendor-initiated and low volume, and an
    // unexplained funding failure has to be traceable after the fact.
    const event = {
      code: error.code,
      message: error.message,
      context: { ...error.context, httpStatus: status },
    };
    if (status >= 500) {
      walletRouteLogger.error(event);
    } else {
      walletRouteLogger.warn(event);
    }
    return res.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  // Unrecognized failure: the response cannot say anything useful, so the log
  // has to carry everything needed to identify it.
  walletRouteLogger.error({
    code: "DROPSHIP_WALLET_INTERNAL_ERROR",
    message: "Dropship wallet request failed with an unrecognized error.",
    context: {
      httpStatus: 500,
      classification: "permanent",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
    },
  });
  return res.status(500).json({
    error: {
      code: "DROPSHIP_WALLET_INTERNAL_ERROR",
      message: "Dropship wallet request failed.",
    },
  });
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_WALLET_INVALID_INPUT",
      "Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function adminActor(req: Request): { actorType: "admin"; actorId?: string } {
  const user = req.session.user as { id?: unknown } | undefined;
  return {
    actorType: "admin",
    ...(typeof user?.id === "string" && user.id.trim() ? { actorId: user.id.trim() } : {}),
  };
}

function statusForDropshipWalletError(code: string): number {
  // Stripe-derived failures own their own status so the classification and the
  // status stay in one place: 5xx means retryable, 4xx means terminal.
  const stripeStatus = httpStatusForDropshipStripeErrorCode(code);
  if (stripeStatus !== null) {
    return stripeStatus;
  }
  if (code === "DROPSHIP_WALLET_IDEMPOTENCY_CONFLICT") {
    return 409;
  }
  if (code === "DROPSHIP_WALLET_INSUFFICIENT_FUNDS") {
    return 402;
  }
  if (
    code === "DROPSHIP_FUNDING_METHOD_NOT_FOUND"
    || code === "DROPSHIP_WALLET_ACCOUNT_NOT_FOUND"
    || code === "DROPSHIP_USDC_LEDGER_ENTRY_NOT_FOUND"
  ) {
    return 404;
  }
  if (
    code === "DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE"
    || code === "DROPSHIP_FUNDING_METHOD_NOT_ACTIVE"
    || code === "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_REQUIRED"
    || code === "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_RAIL_UNSUPPORTED"
    // Refusing to disable the backstop is a state conflict, not bad input.
    || code === "DROPSHIP_AUTO_RELOAD_REQUIRED_WHILE_ACTIVE"
    // The fee on screen is out of date: the vendor re-reads, then retries.
    || code === "DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE"
    // A removal refused for a role the method still holds, or a top-up still
    // in flight on it: the wallet's state, not the caller's input.
    || (FUNDING_METHOD_REMOVAL_REFUSAL_CODES as readonly string[]).includes(code)
    || code === "DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH"
    || code === "DROPSHIP_USDC_TRANSACTION_CONFLICT"
    || code === "DROPSHIP_USDC_DEPOSIT_ADDRESS_CONFLICT"
    || code === "DROPSHIP_USDC_WALLET_LEDGER_MISSING"
  ) {
    return 409;
  }
  if (
    code === "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED"
    || code === "DROPSHIP_STRIPE_SECRET_NOT_CONFIGURED"
    || code === "DROPSHIP_STRIPE_WEBHOOK_SECRET_NOT_CONFIGURED"
    || code === "DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED"
    // USDC deposits (funding design phase 6): not offered, or misconfigured, is
    // the deployment's state, not the caller's fault.
    || code === "DROPSHIP_USDC_DEPOSITS_NOT_OFFERED"
    || code === "DROPSHIP_USDC_CHAIN_NOT_CONFIGURED"
    || code === "DROPSHIP_USDC_DEPOSIT_ADDRESS_MISCONFIGURED"
    || code === "DROPSHIP_USDC_XPUB_MISCONFIGURED"
    || code === "DROPSHIP_USDC_RPC_MISCONFIGURED"
    || code === "DROPSHIP_USDC_WATCHER_MISCONFIGURED"
  ) {
    return 503;
  }
  if (
    // The node, not this service, failed or answered nonsense.
    code === "DROPSHIP_USDC_RPC_TRANSPORT_FAILED"
    || code === "DROPSHIP_USDC_RPC_REJECTED"
    || code === "DROPSHIP_USDC_RPC_RESPONSE_INVALID"
  ) {
    return 502;
  }
  if (code === "DROPSHIP_STRIPE_SETUP_SESSION_URL_MISSING") {
    return 502;
  }
  if (code === "DROPSHIP_STRIPE_FUNDING_SESSION_URL_MISSING") {
    return 502;
  }
  return 400;
}
