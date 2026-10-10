import type { Router } from "express";
import { z } from "zod";
import {
  ebayListingMappingApplySchema,
  ebayListingMappingResultSchema,
  ebayListingMappingReviewSchema,
} from "@shared/types/ebay-listing-mapping";
import type { EbayListingMappingService } from "../../modules/channels/ebay-listing-mapping.service";
import { hasPermission } from "../../modules/identity";
import { requireAuth, requirePermission } from "../middleware";
import { listingFailure, listingFailureStatus } from "./ebay-listing-errors";

const productIdSchema = z.coerce.number().int().positive().max(2147483647);

/** Reading a review never applies a mapping or resumes a provider write. */
export function registerEbayListingMappingRoutes(
  router: Router,
  service: Pick<EbayListingMappingService, "diagnose" | "apply" | "getReceipt">,
  channelId: number,
): void {
  const productPath = "/api/ebay/listings/products/:productId";
  router.use(productPath, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get(`${productPath}/mapping-review`, requireAuth, requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = productIdSchema.parse(req.params.productId);
      const review = await service.diagnose(productId, channelId);
      const allowedToApply = await hasPermission(req.session.user!.id, "channels", "edit");
      res.json(ebayListingMappingReviewSchema.parse({
        ...review,
        allowedToApply,
        requiredPermission: allowedToApply ? null : "channels:edit",
        canApply: review.canApply && allowedToApply,
      }));
    } catch (error) {
      res.status(listingFailureStatus(error)).json(listingFailure(error));
    }
  });
  router.post(`${productPath}/mapping-review`, requireAuth, requirePermission("channels", "edit"), async (req, res) => {
    try {
      const productId = productIdSchema.parse(req.params.productId);
      const command = ebayListingMappingApplySchema.parse(req.body);
      const result = await service.apply(productId, channelId, String(req.session.user!.id), command);
      // The transaction saves a durable sync job. It does not prove that eBay
      // has applied the eventual listing update.
      res.status(202).json(ebayListingMappingResultSchema.parse(result));
    } catch (error) {
      res.status(listingFailureStatus(error)).json(listingFailure(error));
    }
  });
  router.get(`${productPath}/mapping-repairs/:commandKey`, requireAuth, requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = productIdSchema.parse(req.params.productId);
      const commandKey = z.string().uuid().parse(req.params.commandKey);
      const result = await service.getReceipt(productId, channelId, commandKey);
      if (result === null) {
        res.status(404).json({ code: "EBAY_MAPPING_REPAIR_NOT_FOUND", error: "No saved repair was found for this request. Retry the same confirmation to find or save its result." });
        return;
      }
      res.json(ebayListingMappingResultSchema.parse(result));
    } catch (error) {
      res.status(listingFailureStatus(error)).json(listingFailure(error));
    }
  });
}
