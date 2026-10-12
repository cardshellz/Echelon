import type { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../middleware";
import { ebayProductExclusionRequestSchema, ebayProductExclusionResultSchema } from "@shared/types/ebay-listing-exclusion";
import type { EbayListingExclusionService } from "../../modules/channels/ebay-listing-exclusion";
import { listingFailure, listingFailureStatus } from "./ebay-listing-errors";

const productIdSchema = z.coerce.number().int().positive().max(2_147_483_647);

export function registerEbayListingExclusionRoutes(router: Router, service: EbayListingExclusionService): void {
  router.put("/api/ebay/product-exclusion/:productId", requireAuth, requirePermission("channels", "edit"), async (req: Request, res: Response) => {
    try {
      const productId = productIdSchema.parse(req.params.productId);
      // The client creates and retains this key before sending. A server-created
      // replacement cannot recover a lost response to this physical listing action.
      const input = ebayProductExclusionRequestSchema.parse(req.body);
      const result = await service.set(productId, input, String(req.session.user!.id));
      res.json(ebayProductExclusionResultSchema.parse(result));
    } catch (error) {
      const jobId = error instanceof Error && "jobId" in error && typeof error.jobId === "string" ? error.jobId : undefined;
      const failure = listingFailure(error, Number(req.params.productId), jobId);
      res.status(listingFailureStatus(error)).json({ ...failure, ...(jobId ? { jobId } : {}) });
    }
  });
  router.get("/api/ebay/product-exclusion/:productId/commands/:commandKey", requireAuth, requirePermission("channels", "view"), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await service.get(productIdSchema.parse(req.params.productId), z.string().uuid().parse(req.params.commandKey));
      res.json(ebayProductExclusionResultSchema.parse(result));
    } catch (error) {
      res.status(listingFailureStatus(error)).json(listingFailure(error, Number(req.params.productId)));
    }
  });
}
