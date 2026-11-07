import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { ChannelDefinitionError } from "../../application/inventory-channel-definition.service";
import { ChannelRuleService } from "../../application/inventory-channel-rule.service";
import { InventoryCutoverManifestError } from "../../domain/inventory-cutover-manifest";
import { PostgresChannelRuleStore } from "../../infrastructure/inventory-channel-rule.repository";
import { sendError } from "./inventory-product-definition.routes";

/** One saved product or SKU rule: review exactly its effect, then apply only it. */
export function registerChannelRuleDefinitionRoutes(app: Express,
  service: Pick<ChannelRuleService, "review" | "apply" | "progress"> = new ChannelRuleService(new PostgresChannelRuleStore()),
): void {
  const respond = (res: Parameters<typeof sendError>[0], error: unknown) => {
    if (error instanceof ChannelDefinitionError) {
      if (error.status >= 500) console.error(JSON.stringify({ level: "error", event: "channel_rule_command_failed", error_code: error.code }));
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    // Promotion re-checks the reviewed head. Under the fence nothing else can move
    // it, so this is a definite rejection (rolled back), not an unknown outcome.
    if (error instanceof InventoryCutoverManifestError && error.code === "CUTOVER_REVIEWED_HEAD_CHANGED") {
      res.status(409).json({ error: { code: "CHANNEL_RULE_REVIEW_STALE", message: "This rule changed while applying. Nothing was applied; check the change again." } });
      return;
    }
    sendError(res, error);
  };
  app.post("/api/inventory-planning/admin/channel-rule-definitions/review", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.review(req.body)); } catch (error) { respond(res, error); }
  });
  app.post("/api/inventory-planning/admin/channel-rule-definitions/apply", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.apply(req.body, req.session?.user?.id)); } catch (error) { respond(res, error); }
  });
  app.get("/api/inventory-planning/admin/channel-rule-definitions/progress", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress(req.query.scopeKey)); } catch (error) { respond(res, error); }
  });
}
