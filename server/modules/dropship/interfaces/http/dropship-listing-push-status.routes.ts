import type { Express, Response } from "express";
import type { DropshipListingPushStatusService } from "../../application/dropship-listing-push-status-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingPushStatusServiceFromEnv } from "../../infrastructure/dropship-listing-push-status.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

/** The vendor portal polls this after queueing a push until the job is finished. */
export function registerDropshipListingPushStatusRoutes(
  app: Express,
  service: DropshipListingPushStatusService = createDropshipListingPushStatusServiceFromEnv(),
): void {
  app.get("/api/dropship/listing-push-jobs/:jobId", requireDropshipAuth, async (req, res) => {
    try {
      const job = await service.getForMember(req.session.dropship!.memberId, Number(req.params.jobId));
      // Private and changing: never served from a shared cache.
      res.set("Cache-Control", "private, no-store");
      return res.json({ job });
    } catch (error) {
      return sendDropshipListingPushStatusError(res, error);
    }
  });
}

export function statusForListingPushStatusError(code: string): number {
  switch (code) {
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_LISTING_PUSH_JOB_INVALID":
      return 400;
    case "DROPSHIP_LISTING_PUSH_JOB_NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}

function sendDropshipListingPushStatusError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    const status = statusForListingPushStatusError(error.code);
    if (status !== 500) {
      // The context stays server-side: it can name rows and ids the vendor is not shown.
      return res.status(status).json({ error: { code: error.code, message: error.message } });
    }
  }
  console.error("[DropshipListingPushStatusRoutes] Unexpected listing push status error:", error);
  return res.status(500).json({
    error: { code: "DROPSHIP_LISTING_PUSH_STATUS_INTERNAL_ERROR", message: "Listing push status request failed." },
  });
}
