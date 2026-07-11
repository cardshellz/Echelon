import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { carrierProtectionValidationError, type DropshipCarrierProtectionService } from "../../application/dropship-carrier-protection-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipCarrierProtectionServiceFromEnv } from "../../infrastructure/dropship-carrier-protection.factory";

export function registerDropshipAdminCarrierProtectionRoutes(
  app: Express,
  service: DropshipCarrierProtectionService = createDropshipCarrierProtectionServiceFromEnv(),
): void {
  app.get("/api/dropship/admin/carrier-protection", requirePermission("dropship", "view"), async (_req, res) => {
    try { return res.json({ config: await service.getOverview() }); }
    catch (error) { return sendError(res, error); }
  });

  app.post("/api/dropship/admin/carrier-protection/policies", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      const result = await service.createPolicy({ ...req.body, idempotencyKey: idempotency(req), actor: adminActor(req) });
      return res.status(result.idempotentReplay ? 200 : 201).json({ policy: result.record, idempotentReplay: result.idempotentReplay });
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/dropship/admin/carrier-protection/policies/:policyId/retire", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      const result = await service.retirePolicy({ policyId: Number(req.params.policyId), idempotencyKey: idempotency(req), actor: adminActor(req) });
      return res.json({ policy: result.record, idempotentReplay: result.idempotentReplay });
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/dropship/admin/carrier-protection/policies/:policyId/activate", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      const result = await service.activatePolicy({ policyId: Number(req.params.policyId), idempotencyKey: idempotency(req), actor: adminActor(req) });
      return res.json({ policy: result.record, idempotentReplay: result.idempotentReplay });
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/dropship/admin/carrier-protection/assignments", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      const result = await service.createAssignment({ ...req.body, idempotencyKey: idempotency(req), actor: adminActor(req) });
      return res.status(result.idempotentReplay ? 200 : 201).json({ assignment: result.record, idempotentReplay: result.idempotentReplay });
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/dropship/admin/carrier-protection/assignments/:assignmentId/deactivate", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      const result = await service.deactivateAssignment({ assignmentId: Number(req.params.assignmentId), idempotencyKey: idempotency(req), actor: adminActor(req) });
      return res.json({ assignment: result.record, idempotentReplay: result.idempotentReplay });
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/dropship/admin/carrier-protection/resolve", requirePermission("dropship", "view"), async (req, res) => {
    try { return res.json({ match: await service.resolvePolicy(req.body) }); }
    catch (error) { return sendError(res, error); }
  });
}

function idempotency(req: Request): string {
  const key = req.body?.idempotencyKey ?? req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  if (typeof key !== "string" || !key.trim()) throw new DropshipError("DROPSHIP_IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required.");
  return key;
}

function adminActor(req: Request): { actorType: "admin"; actorId?: string } {
  const user = req.session.user as { id?: string } | undefined;
  return { actorType: "admin", actorId: user?.id };
}

function sendError(res: Response, error: unknown): Response {
  const validation = carrierProtectionValidationError(error);
  if (validation) return sendError(res, validation);
  if (error instanceof DropshipError) {
    const status = error.code.includes("NOT_FOUND") ? 404 : error.code.includes("CONFLICT") || error.code.includes("ASSIGNED") || error.code.includes("NOT_ACTIVE") ? 409 : 400;
    return res.status(status).json({ error: { code: error.code, message: error.message, context: error.context } });
  }
  console.error("[DropshipCarrierProtectionRoutes] Unexpected error:", error);
  return res.status(500).json({ error: { code: "DROPSHIP_CARRIER_PROTECTION_INTERNAL_ERROR", message: "Carrier-protection request failed." } });
}
