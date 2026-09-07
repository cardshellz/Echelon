import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { ChannelIdentityError } from "./channel-identity.domain";
import type { ChannelIdentityRepairService } from "./channel-identity-repair.service";

export function registerChannelIdentityRepairRoutes(app: Express, service: Pick<ChannelIdentityRepairService, "preview" | "apply" | "recover">): void {
  const channelId = (req: Request) => z.coerce.number().int().positive().safe().parse(req.params.channelId);
  const actor = (req: Request): string => {
    const id = req.session?.user?.id;
    if (!id) throw new FinancialCommandError("Authenticated operator required", 401, "CHANNEL_IDENTITY_ACTOR_REQUIRED");
    return `user:${id}`;
  };
  const handle = (work: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await work(req, res); }
    catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ code: "CHANNEL_IDENTITY_REQUEST_INVALID", error: "Invalid identity repair request" }); return; }
      if (error instanceof ChannelIdentityError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
      if (error instanceof FinancialCommandError) { res.status(error.statusCode).json({ code: error.code, error: error.message }); return; }
      console.error(JSON.stringify({ action: "channel_identity.command", outcome: "failed", error_code: "CHANNEL_IDENTITY_COMMAND_FAILED" }));
      res.status(500).json({ code: "CHANNEL_IDENTITY_COMMAND_FAILED", error: "Identity command failed; retry with the same idempotency key" });
    }
  };
  app.post("/api/channels/:channelId/identity-repair/preview", requirePermission("channels", "edit"), handle(async (req, res) => {
    const body = z.object({ feedIds: z.array(z.number().int().positive().safe()).min(1).max(25) }).strict().parse(req.body);
    res.json(await service.preview(channelId(req), body.feedIds));
  }));
  app.post("/api/channels/:channelId/identity-repair/apply", requirePermission("channels", "edit"), handle(async (req, res) => {
    const body = z.object({ feedId: z.number().int().positive().safe(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    const idempotencyKey = z.string().trim().min(1).max(200).parse(req.header("Idempotency-Key"));
    const result = await service.apply({ ...body, channelId: channelId(req), actor: actor(req), idempotencyKey });
    res.status(result.httpStatus).json({ commandId: result.commandId, replayed: result.replayed, body: result.body });
  }));
  app.post("/api/channels/:channelId/identity-repair/recover", requirePermission("channels", "edit"), handle(async (req, res) => {
    const body = z.object({ applyCommandId: z.number().int().positive().safe() }).strict().parse(req.body);
    const idempotencyKey = z.string().trim().min(1).max(200).parse(req.header("Idempotency-Key"));
    const result = await service.recover({ ...body, channelId: channelId(req), actor: actor(req), idempotencyKey });
    res.status(result.httpStatus).json({ commandId: result.commandId, replayed: result.replayed, body: result.body });
  }));
}
