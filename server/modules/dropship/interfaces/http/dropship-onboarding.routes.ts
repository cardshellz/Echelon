import type { Express, Response } from "express";
import { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipVendorProvisioningServiceFromEnv } from "../../infrastructure/dropship-vendor-provisioning.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipOnboardingRoutes(
  app: Express,
  service: DropshipVendorProvisioningService = createDropshipVendorProvisioningServiceFromEnv(),
): void {
  app.get("/api/dropship/onboarding/state", requireDropshipAuth, async (req, res) => {
    try {
      const state = await service.getOnboardingState(req.session.dropship!.memberId);
      return res.json(state);
    } catch (error) {
      return sendDropshipOnboardingError(res, error);
    }
  });
}

function sendDropshipOnboardingError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipOnboardingError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipOnboarding] Unexpected onboarding error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_ONBOARDING_INTERNAL_ERROR",
      message: "Dropship onboarding request failed.",
    },
  });
}

function statusForDropshipOnboardingError(code: string): number {
  if (code === "DROPSHIP_ENTITLEMENT_REQUIRED") {
    return 403;
  }
  return 500;
}
