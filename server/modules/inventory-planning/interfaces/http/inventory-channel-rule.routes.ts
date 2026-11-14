import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { ChannelDefinitionError } from "../../application/inventory-channel-definition.service";
import { ChannelRuleService } from "../../application/inventory-channel-rule.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { InventoryCutoverManifestError } from "../../domain/inventory-cutover-manifest";
import { PostgresChannelRuleStore } from "../../infrastructure/inventory-channel-rule.repository";
import { sendError } from "./inventory-product-definition.routes";

/** One product or SKU rule: review a saved change and apply only it, or set a rule so it takes effect in one step. */
export function registerChannelRuleDefinitionRoutes(app: Express,
  service: Pick<ChannelRuleService, "review" | "apply" | "set" | "copy" | "progress"> = new ChannelRuleService(new PostgresChannelRuleStore()),
): void {
  const respond = (res: Parameters<typeof sendError>[0], error: unknown) => {
    if (error instanceof ChannelDefinitionError) {
      if (error.status >= 500) console.error(JSON.stringify({ level: "error", event: "channel_rule_command_failed", error_code: error.code }));
      res.status(error.status).json({ error: { code: error.code, message: error.message,
        ...(error.details.length > 0 ? { details: [...error.details] } : {}) } });
      return;
    }
    // Set runs the draft writer, which reports a moved head or an unusable SKU with its own typed error.
    if (error instanceof InventoryAvailabilityMasterDataError) {
      if (error.status >= 500) console.error(JSON.stringify({ level: "error", event: "channel_rule_command_failed", error_code: error.code }));
      res.status(error.status).json({ error: { code: error.code, message: error.message,
        ...(error.details.length > 0 ? { details: [...error.details] } : {}) } });
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
  // Set both saves and applies, so it needs both permissions the two separate steps need.
  app.post("/api/inventory-planning/admin/channel-rule-definitions/set", requirePermission("inventory_planning", "edit"),
    requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.set(req.body, req.session?.user?.id)); } catch (error) { respond(res, error); }
  });
  // Copy writes and applies a whole channel's rules, so it needs the same two permissions as set.
  app.post("/api/inventory-planning/admin/channel-rule-definitions/copy", requirePermission("inventory_planning", "edit"),
    requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.copy(req.body, req.session?.user?.id)); } catch (error) { respond(res, error); }
  });
  app.get("/api/inventory-planning/admin/channel-rule-definitions/progress", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress(req.query.scopeKey)); } catch (error) { respond(res, error); }
  });
}
