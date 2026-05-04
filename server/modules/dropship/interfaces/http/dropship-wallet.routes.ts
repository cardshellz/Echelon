import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { DropshipError } from "../../domain/errors";
import type { DropshipWalletService } from "../../application/dropship-wallet-service";
import { createDropshipWalletServiceFromEnv } from "../../infrastructure/dropship-wallet.factory";
import {
  createStripeDropshipFundingProviderFromEnv,
  type StripeDropshipFundingProvider,
} from "../../infrastructure/dropship-stripe-funding.provider";
import { requireDropshipAuth, requireDropshipSensitiveActionProof } from "./dropship-auth.routes";

export function registerDropshipWalletRoutes(
  app: Express,
  service: DropshipWalletService = createDropshipWalletServiceFromEnv(),
  stripeFundingProvider: StripeDropshipFundingProvider = createStripeDropshipFundingProviderFromEnv(),
): void {
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
          await service.registerFundingMethod(event.fundingMethod);
        } else if (event.kind === "wallet_funding_recorded") {
          const fundingMethod = await service.registerFundingMethod(event.fundingMethod);
          await service.creditFunding({
            ...event.fundingCredit,
            fundingMethodId: fundingMethod.fundingMethod.fundingMethodId,
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
      return res.json({ wallet: serializeWalletOverview(wallet) });
    } catch (error) {
      return sendDropshipWalletError(res, error);
    }
  });

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
          maxSingleReloadCents: req.body?.maxSingleReloadCents ?? null,
          paymentHoldTimeoutMinutes: req.body?.paymentHoldTimeoutMinutes,
        });
        return res.json({ autoReload: setting });
      } catch (error) {
        return sendDropshipWalletError(res, error);
      }
    },
  );

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

function serializeWalletOverview(wallet: Awaited<ReturnType<DropshipWalletService["getWalletForVendor"]>>) {
  return {
    account: wallet.account,
    autoReload: wallet.autoReload,
    fundingMethods: wallet.fundingMethods.map((method) => ({
      fundingMethodId: method.fundingMethodId,
      rail: method.rail,
      status: method.status,
      displayLabel: method.displayLabel,
      isDefault: method.isDefault,
      createdAt: method.createdAt,
      updatedAt: method.updatedAt,
    })),
    recentLedger: wallet.recentLedger,
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
    return res.status(statusForDropshipWalletError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipWalletRoutes] Unexpected wallet error:", error);
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
  if (code === "DROPSHIP_WALLET_IDEMPOTENCY_CONFLICT") {
    return 409;
  }
  if (code === "DROPSHIP_WALLET_INSUFFICIENT_FUNDS") {
    return 402;
  }
  if (code === "DROPSHIP_FUNDING_METHOD_NOT_FOUND" || code === "DROPSHIP_WALLET_ACCOUNT_NOT_FOUND") {
    return 404;
  }
  if (
    code === "DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE"
    || code === "DROPSHIP_FUNDING_METHOD_NOT_ACTIVE"
    || code === "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_REQUIRED"
  ) {
    return 409;
  }
  if (
    code === "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED"
    || code === "DROPSHIP_STRIPE_SECRET_NOT_CONFIGURED"
    || code === "DROPSHIP_STRIPE_WEBHOOK_SECRET_NOT_CONFIGURED"
  ) {
    return 503;
  }
  if (code === "DROPSHIP_STRIPE_SETUP_SESSION_URL_MISSING") {
    return 502;
  }
  if (code === "DROPSHIP_STRIPE_FUNDING_SESSION_URL_MISSING") {
    return 502;
  }
  return 400;
}
