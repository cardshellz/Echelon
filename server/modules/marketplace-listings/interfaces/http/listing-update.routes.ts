import type { Express, Request } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import type { ListingUpdateService } from "../../application/listing-update.service";
import { ListingPublicationError } from "../../domain/listing-publication";
import { sendError } from "./listing-publication.routes";

export function registerListingUpdateRoutes(app: Express): void {
  const actor = (request: Request) =>
    z.string().min(1).max(200).parse(request.session?.user?.id);
  function route(
    method: "get" | "post",
    path: string,
    edit: boolean,
    action: (
      service: ListingUpdateService,
      id: number,
      request: Request,
    ) => Promise<unknown>,
  ) {
    app[method](
      `/api/channels/:id/listing-updates${path}`,
      requirePermission("channels", edit ? "edit" : "view"),
      async (request, response) => {
        try {
          const id = z.coerce
            .number()
            .int()
            .positive()
            .max(2_147_483_647)
            .parse(request.params.id);
          const service: ListingUpdateService | undefined =
            app.locals.services?.listingUpdates;
          if (!service)
            throw new ListingPublicationError(
              "LISTING_UPDATES_UNAVAILABLE",
              "Listing edits are unavailable",
              503,
            );
          response.json(await action(service, id, request));
        } catch (error) {
          sendError(response, error);
        }
      },
    );
  }
  route("get", "", false, (service, id) => service.list(id));
  route("get", "/item", false, (service, id, request) =>
    service.context(id, request.query.sku),
  );
  route("get", "/requirements", false, (service, id, request) =>
    service.requirements(id, request.query.productType),
  );
  route("post", "/review", true, (service, id, request) =>
    service.review(id, request.body, actor(request)),
  );
  route("post", "/:updateId/submit", true, (service, id, request) =>
    service.submit(id, request.params.updateId, request.body, actor(request)),
  );
  route("post", "/:updateId/status", true, (service, id, request) =>
    service.refresh(id, request.params.updateId, actor(request)),
  );
}
