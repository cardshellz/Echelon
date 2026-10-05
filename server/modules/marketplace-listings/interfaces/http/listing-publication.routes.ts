import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { ListingPublicationError } from "../../domain/listing-publication";
import type { ListingPublicationService } from "../../application/listing-publication.service";
import { ChannelProviderError } from "../../../channels/channel-provider.error";

export function registerListingPublicationRoutes(app: Express): void {
  function route(
    method: "get" | "put" | "post",
    suffix: string,
    edit: boolean,
    action: (
      service: ListingPublicationService,
      channelId: number,
      request: Request,
    ) => Promise<unknown>,
  ): void {
    app[method](
      `/api/channels/:id/listing-publications${suffix}`,
      requirePermission("channels", edit ? "edit" : "view"),
      async (request, response) => {
        try {
          const channelId = z.coerce
            .number()
            .int()
            .positive()
            .max(2_147_483_647)
            .parse(request.params.id);
          const service: ListingPublicationService | undefined =
            app.locals.services?.listingPublication;
          if (!service)
            throw new ListingPublicationError(
              "LISTING_PUBLICATION_UNAVAILABLE",
              "Listing publication is unavailable",
              503,
            );
          response.json(await action(service, channelId, request));
        } catch (error) {
          sendError(response, error);
        }
      },
    );
  }
  const actor = (request: Request): string =>
    z.string().min(1).max(200).parse(request.session?.user?.id);
  route("get", "", false, (service, id) => service.workspace(id));
  route("get", "/catalog", false, (service, id, request) =>
    service.catalog(id, request.query),
  );
  route("put", "/draft", true, (service, id, request) =>
    service.saveDraft(id, request.body, actor(request)),
  );
  route("put", "/pricing", true, (service, id, request) =>
    service.savePricing(id, request.body, actor(request)),
  );
  route("get", "/taxonomy", false, (service, id) => service.taxonomy(id));
  route("get", "/requirements", false, (service, id, request) =>
    service.requirements(id, request.query),
  );
  route("post", "/review", true, (service, id, request) =>
    service.review(id, request.body, actor(request)),
  );
  route("post", "/operations", true, (service, id, request) =>
    service.submit(id, request.body, actor(request)),
  );
  route("get", "/operations", false, (service, id) => service.operations(id));
  route(
    "get",
    "/operations/:operationId/retry-items",
    true,
    (service, id, request) =>
      service.retryItems(id, request.params.operationId),
  );
  route(
    "post",
    "/operations/:operationId/reconcile",
    true,
    (service, id, request) =>
      service.reconcile(id, request.params.operationId, actor(request)),
  );
}

export function sendError(response: Response, error: unknown): void {
  const known =
    error instanceof ListingPublicationError ||
    error instanceof ChannelProviderError;
  const invalid = error instanceof z.ZodError;
  const code = known
    ? error.code
    : invalid
      ? "LISTING_INPUT_INVALID"
      : "LISTING_PUBLICATION_FAILED";
  console.error(
    JSON.stringify({ operation: "listing_publication_http", code }),
  );
  response
    .status(
      error instanceof ListingPublicationError
        ? error.status
        : invalid
          ? 400
          : error instanceof ChannelProviderError
            ? error.retryable
              ? 503
              : 409
            : 500,
    )
    .json({
      code,
      error: known
        ? error.message
        : invalid
          ? "Check the selected items and listing fields"
          : "Listing publication could not be completed",
    });
}
