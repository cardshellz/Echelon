import type { Router } from "express";
import { z } from "zod";
import { ebayPublicationStockApplySchema, ebayPublicationStockReviewSchema, ebayPublicationStockResultSchema } from "@shared/types/ebay-publication-stock";
import type { EbayPublicationStockService } from "../../modules/channels/ebay-publication-stock.service";
import { hasPermission } from "../../modules/identity";
import { requireAuth, requirePermission } from "../middleware";
import { listingFailure, listingFailureStatus } from "./ebay-listing-errors";

const productIdSchema = z.coerce.number().int().positive().max(2_147_483_647);
export function registerEbayPublicationStockRoutes(router: Router,
  service: Pick<EbayPublicationStockService, "review" | "apply" | "getReceipt">): void {
  const path = "/api/ebay/listings/products/:productId/publication-readiness";
  router.use(path, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get(path, requireAuth, requirePermission("channels", "view"), async (req, res) => {
    try {
      const review = await service.review(productIdSchema.parse(req.params.productId));
      const channel = await hasPermission(req.session.user!.id, "channels", "edit");
      const inventory = await hasPermission(req.session.user!.id, "inventory_planning", "activate");
      const allowedToApply = channel && inventory;
      res.json(ebayPublicationStockReviewSchema.parse({ ...review, canApply: review.canApply && allowedToApply, allowedToApply,
        requiredPermission: allowedToApply ? null : !channel ? "channels:edit" : "inventory_planning:activate" }));
    } catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error, productIdSchema.safeParse(req.params.productId).data)); }
  });
  router.post(`${path}/apply`, requireAuth, requirePermission("channels", "edit"), requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const result = await service.apply(productIdSchema.parse(req.params.productId), String(req.session.user!.id), ebayPublicationStockApplySchema.parse(req.body));
      res.status(202).json(ebayPublicationStockResultSchema.parse(result));
    } catch (error) {
      res.status(listingFailureStatus(error)).json({ ...listingFailure(error, productIdSchema.safeParse(req.params.productId).data),
        definitiveRejected: error !== null && typeof error === "object" && "definitiveRejected" in error && error.definitiveRejected === true });
    }
  });
  router.get(`${path}/commands/:commandKey`, requireAuth, requirePermission("channels", "view"), async (req, res) => {
    try {
      const receipt = await service.getReceipt(productIdSchema.parse(req.params.productId), z.string().uuid().parse(req.params.commandKey));
      if (!receipt) { res.status(404).json({ code: "EBAY_PUBLICATION_STOCK_COMMAND_NOT_FOUND", error: "No saved result is visible yet. Retry the same request to check or save its outcome." }); return; }
      res.json(ebayPublicationStockResultSchema.parse(receipt));
    } catch (error) {
      res.status(listingFailureStatus(error)).json({ ...listingFailure(error, productIdSchema.safeParse(req.params.productId).data),
        definitiveRejected: error !== null && typeof error === "object" && "definitiveRejected" in error && error.definitiveRejected === true });
    }
  });
}
