import type { Express, Response } from "express";
import { DropshipError } from "../../domain/errors";
import type { DropshipWalletService } from "../../application/dropship-wallet-service";
import { createDropshipWalletServiceFromEnv } from "../../infrastructure/dropship-wallet.factory";
import { requireDropshipAuth, requireDropshipSensitiveActionProof } from "./dropship-auth.routes";

export function registerDropshipWalletRoutes(
  app: Express,
  service: DropshipWalletService = createDropshipWalletServiceFromEnv(),
): void {
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
  return 400;
}
