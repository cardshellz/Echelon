import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import type { WalmartChannelService } from "./walmart-channel.service";
import type { WalmartOrderPollService } from "./walmart-order-poll.service";
import { WalmartApiError } from "./walmart-client";
import type { ChannelCatalogDirectory } from "../../channel-catalog.routes";
import { sendCatalogError } from "../../channel-catalog.routes";
import { ChannelIdentityError } from "../../channel-identity.domain";
import { walmartMappingSchema } from "@shared/types/walmart-channel";

export function registerWalmartChannelRoutes(app: Express): void {
  const catalog = async (channelId: number) => {
    const directory: ChannelCatalogDirectory | undefined = app.locals.services?.channelCatalog;
    if (!directory) throw new WalmartApiError("WALMART_UNAVAILABLE", "Channel catalog is unavailable", true);
    return directory.forChannel(channelId);
  };
  const route = (method: "get" | "post", suffix: string, edit: boolean,
    action: (service: WalmartChannelService, worker: WalmartOrderPollService, req: Request, channelId: number) => Promise<unknown>) => {
    app[method](`/api/channels/:id/walmart${suffix}`, requirePermission("channels", edit ? "edit" : "view"), async (req, res) => {
      try {
        const channelId = z.coerce.number().int().positive().max(2_147_483_647).parse(req.params.id);
        const service: WalmartChannelService | undefined = app.locals.services?.walmart;
        const worker: WalmartOrderPollService | undefined = app.locals.services?.walmartOrderPoll;
        if (!service || !worker) throw new WalmartApiError("WALMART_UNAVAILABLE", "Walmart integration is unavailable", true);
        res.json(await action(service, worker, req, channelId));
      } catch (error) { sendError(res, error); }
    });
  };
  route("get", "", false, (service, _worker, _req, id) => service.status(id));
  route("post", "/verify", true, (service, _worker, req) => service.preview(req.body));
  route("post", "/connect", true, (service, _worker, req, id) => service.connect(id, req.body, actor(req)));
  route("post", "/control", true, (service, _worker, req, id) => service.control(id, req.body, actor(req)));
  route("post", "/poll", true, (_service, worker, _req, id) => worker.poll(id));
  route("get", "/mappings", false, (service, _worker, _req, id) => service.repository.mappings(id));
  route("get", "/exceptions", false, (service, _worker, _req, id) => service.repository.exceptions(id));
  // Compatibility aliases for an open pre-upgrade browser; mapping still goes
  // through the shared channel identity owner and current provider evidence.
  route("get", "/catalog", false, async (_service, _worker, req, id) => (await catalog(id)).searchVariants(req.query.q));
  route("post", "/mappings", true, async (service, _worker, req, id) => {
    const mapping = walmartMappingSchema.parse(req.body);
    await (await catalog(id)).link(id, { mappings: [mapping] }, actor(req));
    return service.repository.status(id);
  });
}
function actor(req: Request): string {
  return z.string().min(1).parse(req.session?.user?.id);
}
function sendError(res: Response, error: unknown): void {
  if (error instanceof ChannelIdentityError) return sendCatalogError(res, error);
  // Never log request bodies, Zod inputs, database parameters, or provider payloads:
  // account verification and connection requests contain credentials.
  const known = error instanceof WalmartApiError;
  const conflict = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
  const code = known ? error.code : error instanceof z.ZodError ? "WALMART_INPUT_INVALID" : conflict ? "WALMART_ACCOUNT_CONFLICT" : "WALMART_OPERATION_FAILED";
  console.error(JSON.stringify({ code, operation: "walmart_channel_request" }));
  res.status(known ? error.retryable ? 503 : 409 : error instanceof z.ZodError ? 400 : conflict ? 409 : 500)
    .json({ code, error: known ? error.message : conflict ? "This Walmart account or SKU is already connected" : "Walmart operation could not be completed; review the connection and retry" });
}
