import type { ListingIntentPropagationService } from "../application/listing-intent-propagation.service";
import type { Express, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../routes/middleware";
import { requireDropshipAuth } from "../../dropship/interfaces/http/dropship-auth.routes";
import { listingIntentPropagationRepository as repository } from "../../../listing-intent-propagation.composition";

const id = z.coerce.number().int().positive().max(2_147_483_647);
const deliveryId = z.string().regex(/^[1-9][0-9]{0,18}$/);
async function respond(
  res: Response,
  work: () => Promise<unknown>,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await work());
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        code: "LISTING_INTENT_INPUT_INVALID",
        message: "Use a valid channel, store and saved change.",
      });
      return;
    }
    console.error(JSON.stringify({ event: "listing_intent_status_failed" }));
    res.status(500).json({
      code: "LISTING_INTENT_STATUS_UNAVAILABLE",
      message: "Saved listing changes could not be loaded. Try again.",
    });
  }
}
/** Delivered means handed to a saved operation, not synchronized at a provider. */
export function registerListingIntentPropagationRoutes(
  app: Express,
  service: Pick<ListingIntentPropagationService, "requestRetry">,
): void {
  app.get(
    "/api/channels/:channelId/listing-intent-changes",
    requirePermission("channels", "view"),
    (req, res) =>
      respond(res, () =>
        repository.list(
          { channelId: id.parse(req.params.channelId) },
          z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .default(100)
            .parse(req.query.limit),
          z.coerce
            .number()
            .int()
            .min(0)
            .max(1_000_000)
            .default(0)
            .parse(req.query.offset),
        ),
      ),
  );
  app.post(
    "/api/channels/:channelId/listing-intent-changes/:deliveryId/retry",
    requirePermission("channels", "edit"),
    (req, res) =>
      respond(res, async () => ({
        retried: await service.requestRetry({
          id: deliveryId.parse(req.params.deliveryId),
          channelId: id.parse(req.params.channelId),
          actor:
            "user:" +
            String(
              req.session.user?.id || req.session.user?.username || "unknown",
            ),
        }),
      })),
  );
  const base =
    "/api/dropship/listings/stores/:storeConnectionId/listing-intent-changes";
  app.get(base, requireDropshipAuth, (req, res) =>
    respond(res, async () => {
      const storeConnectionId = id.parse(req.params.storeConnectionId);
      const vendorId = await repository.vendorForMemberStore(
        req.session.dropship!.memberId,
        storeConnectionId,
      );
      if (!vendorId) {
        res.status(404);
        return {
          code: "LISTING_INTENT_STORE_NOT_FOUND",
          message: "Store connection not found.",
        };
      }
      return repository.list(
        { vendorId, storeConnectionId },
        z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(100)
          .parse(req.query.limit),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .default(0)
          .parse(req.query.offset),
      );
    }),
  );
  app.post(base + "/:deliveryId/retry", requireDropshipAuth, (req, res) =>
    respond(res, async () => {
      const storeConnectionId = id.parse(req.params.storeConnectionId);
      const memberId = req.session.dropship!.memberId;
      const vendorId = await repository.vendorForMemberStore(
        memberId,
        storeConnectionId,
      );
      if (!vendorId) {
        res.status(404);
        return {
          code: "LISTING_INTENT_STORE_NOT_FOUND",
          message: "Store connection not found.",
        };
      }
      return {
        retried: await service.requestRetry({
          id: deliveryId.parse(req.params.deliveryId),
          vendorId,
          storeConnectionId,
          actor: "member:" + memberId,
        }),
      };
    }),
  );
}
