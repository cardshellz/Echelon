import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { ChannelDefinitionError, ChannelDefinitionService } from "../../application/inventory-channel-definition.service";
import { PostgresChannelDefinitionStore } from "../../infrastructure/inventory-channel-definition.repository";
import { sendError } from "./inventory-product-definition.routes";

export function registerChannelDefinitionRoutes(app: Express,
  service: Pick<ChannelDefinitionService, "review" | "apply" | "progress"> = new ChannelDefinitionService(new PostgresChannelDefinitionStore()),
): void {
  const respond = (res: Parameters<typeof sendError>[0], error: unknown) => {
    if (error instanceof ChannelDefinitionError) {
      if (error.status >= 500) console.error(JSON.stringify({ event: "channel_definition_command_failed", code: error.code }));
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    sendError(res, error);
  };
  app.post("/api/inventory-planning/admin/channel-definitions/review", requirePermission("inventory_planning", "view"), async (req,res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.review(req.body)); } catch (error) { respond(res,error); }
  });
  app.post("/api/inventory-planning/admin/channel-definitions/apply", requirePermission("inventory_planning", "activate"), async (req,res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.apply(req.body,req.session?.user?.id)); } catch (error) { respond(res,error); }
  });
  app.get("/api/inventory-planning/admin/channel-definitions/:channelId/progress", requirePermission("inventory_planning", "view"), async (req,res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress({ channelId: Number(req.params.channelId) })); } catch (error) { respond(res,error); }
  });
}
