import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { AppError, ValidationError } from "@shared/errors";
import { releasePickingAssignmentRequestSchema } from "@shared/types/picking-assignment-release";
import type { Order } from "@shared/schema";
import { requireAuth, requirePermission } from "../../routes/middleware";
import { broadcastOrdersUpdated } from "../../websocket";
import type { ReleasePickingAssignmentCommand } from "./picking-assignment-release.service";

interface AssignmentReleaseService {
  releaseOrder(id: number, command: Omit<ReleasePickingAssignmentCommand, "orderId">): Promise<Order>;
}

const orderIdSchema = z.string().regex(/^[1-9]\d*$/).transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647));

export function registerPickingAssignmentReleaseRoutes(app: Express, service: AssignmentReleaseService): void {
  const release: RequestHandler = async (req, res) => {
    try {
      const id = orderIdSchema.safeParse(req.params.id);
      const body = releasePickingAssignmentRequestSchema.safeParse(req.body ?? {});
      if (!id.success || !body.success) throw new ValidationError("Invalid picking assignment release request.");
      const userId = req.session.user?.id;
      if (!userId) return void res.status(401).json({ error: "Sign in to release a picking assignment." });
      const order = await service.releaseOrder(id.data, {
        ...body.data, userId,
        deviceType: req.get("x-device-type"), sessionId: req.sessionID,
      });
      broadcastOrdersUpdated();
      res.json(order);
    } catch (error) {
      const operational = error instanceof AppError && error.isOperational;
      console.error(JSON.stringify({
        event: "picking_assignment_release_failed", orderId: req.params.id,
        actorId: req.session.user?.id,
        code: operational ? error.code : "PICKING_RELEASE_FAILED",
        message: error instanceof Error ? error.message : "Unknown release failure",
      }));
      res.status(operational ? error.statusCode : 500).json({
        code: operational ? error.code : "PICKING_RELEASE_FAILED",
        error: operational ? error.message : "Could not release the picking assignment. Refresh the queue before retrying.",
        context: operational ? error.context : undefined,
      });
    }
  };
  app.post("/api/picking/orders/:id/release", requireAuth, release);
  // Compatibility URL only: no hold removal, progress reset or alternate writer.
  app.post("/api/orders/:id/force-release", requireAuth, requirePermission("picking", "release_any"), release);
}
