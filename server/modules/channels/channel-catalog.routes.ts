import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import type { ChannelCatalogService } from "./channel-catalog.service";
import { ChannelIdentityError } from "./channel-identity.domain";
import { ChannelProviderError } from "./channel-provider.error";

export interface ChannelCatalogDirectory {
  forChannel(channelId: number): Promise<ChannelCatalogService>;
}
export function registerChannelCatalogRoutes(app: Express): void {
  const route = (method: "get" | "post", suffix: string, edit: boolean,
    action: (service: ChannelCatalogService, id: number, req: Request) => Promise<unknown>) => {
    app[method](`/api/channels/:id/catalog${suffix}`, requirePermission("channels", edit ? "edit" : "view"), async (req, res) => {
      try {
        const id = z.coerce.number().int().positive().max(2_147_483_647).parse(req.params.id);
        const directory: ChannelCatalogDirectory | undefined = app.locals.services?.channelCatalog;
        if (!directory) throw new ChannelIdentityError("CHANNEL_CATALOG_UNAVAILABLE", "Channel catalog is unavailable", "transient");
        res.json(await action(await directory.forChannel(id), id, req));
      } catch (error) { sendCatalogError(res, error); }
    });
  };
  route("get", "", false, (service, id, req) => service.list(id, req.query));
  route("get", "/variants", false, (service, _id, req) => service.searchVariants(req.query.q));
  route("post", "/mappings", true, (service, id, req) => service.link(id, req.body, z.string().min(1).parse(req.session?.user?.id)));
}
export function sendCatalogError(res: Response, error: unknown): void {
  const known = error instanceof ChannelIdentityError;
  // Provider errors expose only their pre-sanitized application message.
  const providerError = error instanceof ChannelProviderError;
  const code = known || providerError ? String(error.code) : error instanceof z.ZodError ? "CHANNEL_CATALOG_INPUT_INVALID" : "CHANNEL_CATALOG_FAILED";
  console.error(JSON.stringify({ code, operation: "channel_catalog" }));
  res.status(error instanceof z.ZodError ? 400 : known ? error.failureClass === "transient" ? 503 : 409 : providerError ? error.retryable ? 503 : 409 : 500)
    .json({ code, error: known || providerError ? error.message : "The channel catalog operation could not be completed" });
}
