import type { Express, Request } from "express";
import { z } from "zod";
import { listingLifecycleSkuSchema } from "@shared/types/channel-listing-lifecycle";
import { requirePermission } from "../../../../routes/middleware";
import type { ListingLifecycleService } from "../../application/listing-lifecycle.service";
import { ListingPublicationError } from "../../domain/listing-publication";
import { sendError } from "./listing-publication.routes";

const lookupSchema = z
  .object({ skus: z.array(listingLifecycleSkuSchema).max(250) })
  .strict();
const statusSchema = z.object({ sku: listingLifecycleSkuSchema }).strict();

export function registerListingLifecycleRoutes(app: Express): void {
  function route(
    path: string,
    edit: boolean,
    action: (
      service: ListingLifecycleService,
      id: number,
      request: Request,
    ) => Promise<unknown>,
  ): void {
    app.post(
      `/api/channels/:id/listing-lifecycle${path}`,
      requirePermission("channels", edit ? "edit" : "view"),
      async (request, response) => {
        try {
          const id = z.coerce
            .number()
            .int()
            .positive()
            .max(2_147_483_647)
            .parse(request.params.id);
          const service: ListingLifecycleService | undefined =
            app.locals.services?.listingLifecycle;
          if (!service)
            throw new ListingPublicationError(
              "LISTING_LIFECYCLE_UNAVAILABLE",
              "Listing actions are unavailable. Retry shortly.",
              503,
            );
          response.json(await action(service, id, request));
        } catch (error) {
          sendError(response, error);
        }
      },
    );
  }
  route("/lookup", false, (service, id, request) =>
    service.list(id, lookupSchema.parse(request.body).skus),
  );
  route("/history", false, (service, id, request) =>
    service.history(id, request.body),
  );
  route("/members", false, (service, id, request) => service.memberHistory(id, request.body));
  route("/presence", false, (service, id, request) =>
    service.refreshPresence(id, lookupSchema.parse(request.body).skus),
  );
  route("", true, (service, id, request) =>
    service.request(
      id,
      request.body,
      z.string().trim().min(1).max(100).parse(request.session?.user?.id),
    ),
  );
  // Checking may retry a failed retirement, so it requires edit permission too.
  route("/status", true, (service, id, request) =>
    service.refresh(id, statusSchema.parse(request.body).sku),
  );
}
