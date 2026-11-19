import type { Express, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../routes/middleware";
import type { ChannelSyncBatchService } from "../application/channel-sync-batch.service";
import { ChannelSyncBatchError } from "../domain/channel-sync-batch";
import {
  channelSyncBatchSchema,
  channelSyncBatchesSchema,
  startChannelSyncBatchSchema,
} from "@shared/types/channel-sync-batch";

const id = z.coerce.number().int().positive().max(2_147_483_647);
const offsetSchema = z.coerce.number().int().min(0).max(1_000_000).default(0);
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ChannelSyncBatchError(
      "SYNC_BATCH_INPUT_INVALID",
      "Use a valid channel and request key.",
      400,
    );
  return result.data;
}
async function respond(
  res: Response,
  work: () => Promise<unknown>,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await work());
  } catch (error) {
    if (error instanceof ChannelSyncBatchError) {
      res
        .status(error.status)
        .json({ code: error.code, message: error.message });
    } else {
      // Invalid output is unavailable server evidence, not an operator input error.
      console.error(
        JSON.stringify({
          event: "channel_sync_batch_request_failed",
          code: "SYNC_BATCH_UNAVAILABLE",
        }),
      );
      res.status(503).json({
        code: "SYNC_BATCH_UNAVAILABLE",
        message:
          "Sync status could not be confirmed. Refresh saved status before submitting another request.",
      });
    }
  }
}
export function registerChannelSyncBatchRoutes(
  app: Express,
  service: Pick<ChannelSyncBatchService, "start" | "list" | "get">,
): void {
  const path = "/api/channels/:channelId/sync-batches";
  app.get(path, requirePermission("channels", "view"), (req, res) =>
    respond(res, async () =>
      channelSyncBatchesSchema.parse(
        await service.list(
          input(id, req.params.channelId),
          input(offsetSchema, req.query.offset),
        ),
      ),
    ),
  );
  app.get(
    path + "/:batchId",
    requirePermission("channels", "view"),
    (req, res) =>
      respond(res, async () =>
        channelSyncBatchSchema.parse(
          await service.get(
            input(id, req.params.channelId),
            input(z.string().uuid(), req.params.batchId),
          ),
        ),
      ),
  );
  app.post(path, requirePermission("channels", "edit"), (req, res) =>
    respond(res, async () => {
      const userId = req.session.user?.id;
      if (!userId)
        throw new ChannelSyncBatchError(
          "SYNC_ACTOR_REQUIRED",
          "Sign in before requesting sync.",
          401,
        );
      const batch = await service.start(
        input(id, req.params.channelId),
        "user:" + String(userId),
        input(startChannelSyncBatchSchema, req.body),
      );
      const result = channelSyncBatchSchema.parse(batch);
      res.status(202);
      return result;
    }),
  );
}
