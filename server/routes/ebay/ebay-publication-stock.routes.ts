import type { Router } from "express";
import { z } from "zod";
import { ebayPublicationStockResultSchema } from "@shared/types/ebay-publication-stock";
import type { EbayPublicationStockService } from "../../modules/channels/ebay-publication-stock.service";
import { requireAuth, requirePermission } from "../middleware";
import { listingFailure, listingFailureStatus } from "./ebay-listing-errors";
const productIdSchema = z.coerce.number().int().positive().max(2147483647);
export function registerEbayPublicationStockRoutes(router: Router, service: Pick<EbayPublicationStockService, "getReceipt">): void {
    const path = "/api/ebay/listings/products/:productId/publication-readiness";
    router.use(path, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
    const retired = (_req: unknown, res: import("express").Response) => res.status(410).json({ code: "EBAY_PUBLICATION_STOCK_APPLY_RETIRED", definitiveRejected: true,
        error: "Use Publish on the channel listing. Its saved request prepares exact stock mappings automatically; no separate stock inclusion is required." });
    router.get(path, requireAuth, requirePermission("channels", "view"), retired);
    router.post(`${path}/apply`, requireAuth, requirePermission("channels", "edit"), retired);
    router.get(`${path}/commands/:commandKey`, requireAuth, requirePermission("channels", "view"), async (req, res) => {
        try {
            const receipt = await service.getReceipt(productIdSchema.parse(req.params.productId), z.string().uuid().parse(req.params.commandKey));
            if (!receipt) {
                res.status(404).json({ code: "EBAY_PUBLICATION_STOCK_COMMAND_NOT_FOUND", error: "No historical result is saved for this command. Use the listing's saved Publish request to check current work." });
                return;
            }
            res.json(ebayPublicationStockResultSchema.parse(receipt));
        }
        catch (error) {
            res.status(listingFailureStatus(error)).json({ ...listingFailure(error, productIdSchema.safeParse(req.params.productId).data),
                definitiveRejected: error !== null && typeof error === "object" && "definitiveRejected" in error && error.definitiveRejected === true });
        }
    });
}
