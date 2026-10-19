import type { Request, Response } from "express";
import { ZodError } from "zod";
import { EbayBusinessPolicyError } from "@shared/ebay-business-policies";
import { publicationSelectionBusyIssue } from "../../modules/inventory-planning/publication-selection-work";

export function ebayPolicyActor(req: Request): string {
  const request = req as Request & {
    session?: { user?: { id?: unknown; username?: unknown } };
    user?: { username?: unknown };
  };
  const identity =
    request.session?.user?.id ??
    request.session?.user?.username ??
    request.user?.username;
  if (
    (typeof identity !== "string" && typeof identity !== "number") ||
    !String(identity).trim()
  )
    throw new EbayBusinessPolicyError(
      "EBAY_POLICY_ACTOR_REQUIRED",
      "Sign in again before changing eBay policies.",
      401,
    );
  return `user:${String(identity).trim()}`;
}

export function sendEbayPolicyError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res
      .status(400)
      .json({
        code: "EBAY_POLICY_INVALID_REQUEST",
        error:
          "Invalid eBay policy request. Policy IDs must be nonempty strings; use null to inherit.",
        details: error.issues,
      });
    return;
  }
  if (error instanceof EbayBusinessPolicyError) {
    res
      .status(error.statusCode)
      .json({
        code: error.code,
        error: error.message,
        message: error.message,
        context: error.context,
        policySource: error.context.policySource,
      });
    return;
  }
  const busy = publicationSelectionBusyIssue(error);
  if (busy) {
    res.status(409).json({ ...busy, error: busy.message });
    return;
  }
  console.error("[eBay business policies]", error);
  res
    .status(500)
    .json({
      code: "EBAY_POLICY_SAVE_FAILED",
      error:
        "Echelon could not complete this policy request. Retry after refreshing the current selections.",
    });
}
