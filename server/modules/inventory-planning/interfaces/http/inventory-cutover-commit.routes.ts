import type { Express, RequestHandler, Response } from "express";
import { commitInventoryCutoverRequestSchema, previewInventoryCutoverRequestSchema, inventoryCutoverReviewSchema, inventoryCutoverCommitResultSchema } from "@shared/types/inventory-cutover-commit";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryCutoverCommitError, InventoryCutoverCommitService } from "../../application/inventory-cutover-commit.service";
import { PostgresInventoryCutoverCommitRepository } from "../../infrastructure/inventory-cutover-commit.repository";
import { InventoryCutoverManifestError } from "../../domain/inventory-cutover-manifest";
import { CutoverReconstructionError } from "../../infrastructure/inventory-cutover-reconstruction.repository";
import { InventoryAvailabilityActivationRepositoryError } from "../../infrastructure/inventory-availability-activation.repository";

const noStore: RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };

export function registerInventoryCutoverCommitRoutes(app: Express,
  service: Pick<InventoryCutoverCommitService, "preview" | "commit"> = new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository()),
): void {
  app.post("/api/inventory-planning/admin/cutover/review", noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = previewInventoryCutoverRequestSchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError("CUTOVER_REVIEW_REQUEST_INVALID", "A valid activation run is required; query filters and actor overrides are not accepted.", 400);
      return res.json(inventoryCutoverReviewSchema.parse(await service.preview(request.data, req.session?.user?.id)));
    }
    catch (error) { return sendInventoryCutoverError(res, error); }
  });
  app.post("/api/inventory-planning/admin/cutover/commit", noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = commitInventoryCutoverRequestSchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError("CUTOVER_COMMIT_REQUEST_INVALID", "A valid reviewed cutover command is required; query filters and actor overrides are not accepted.", 400);
      const result = inventoryCutoverCommitResultSchema.parse(await service.commit(request.data, req.session?.user?.id));
      return res.status(result.alreadyApplied ? 200 : 201).json(result);
    } catch (error) { return sendInventoryCutoverError(res, error); }
  });
}

export function sendInventoryCutoverError(res: Response, error: unknown): Response {
  if (error instanceof InventoryCutoverCommitError && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message, context: error.context } });
  }
  const manifestConflict = error instanceof InventoryCutoverManifestError && [
    "CUTOVER_DRY_RUN_BLOCKED", "CUTOVER_SNAPSHOT_COVERAGE_INVALID", "CUTOVER_DEFINITION_MISSING",
    "CUTOVER_DEFINITION_AMBIGUOUS", "CUTOVER_SNAPSHOT_IDENTITY_CHANGED", "CUTOVER_ROOT_MODEL_CHANGED", "CUTOVER_REVIEWED_HEAD_CHANGED",
  ].includes(error.code);
  const reconstructionConflict = error instanceof CutoverReconstructionError && [
    "CUTOVER_RECONSTRUCTION_REPLAY_CONFLICT", "CUTOVER_RECONSTRUCTION_EVIDENCE_CHANGED", "CUTOVER_RECONSTRUCTION_BLOCKED", "CUTOVER_FRESH_DEMAND_IMPACT_CHANGED",
  ].includes(error.code);
  const activationConflict = error instanceof InventoryAvailabilityActivationRepositoryError && [
    "ACTIVATION_DRY_RUN_NOT_FOUND", "ACTIVATION_DRY_RUN_NOT_READY", "ACTIVATION_PUBLICATION_TARGET_CHANGED", "ACTIVATION_TRANSFORMATION_MODEL_CHANGED",
    "ACTIVATION_SOURCE_BINDING_CHANGED", "ACTIVATION_VARIANT_MAPPING_CHANGED", "ACTIVATION_CHANNEL_POLICY_CHANGED",
    "ACTIVATION_LOCATION_POLICY_CHANGED", "ACTIVATION_SAFETY_POLICY_CHANGED", "ACTIVATION_SHADOW_EVIDENCE_MISSING", "ACTIVATION_SELECTION_AMBIGUOUS",
  ].includes(error.code);
  if (manifestConflict || reconstructionConflict || activationConflict) {
    return res.status(409).json({ error: { code: error.code, message: "Reviewed cutover evidence is no longer usable. Refresh the complete review before retrying." } });
  }
  if (error instanceof CutoverReconstructionError && ["CUTOVER_VARIANT_CENSUS_LIMIT_EXCEEDED", "CUTOVER_CLAIM_TARGET_LIMIT_EXCEEDED"].includes(error.code)) {
    return res.status(422).json({ error: { code: error.code, message: "The complete evidence set exceeds the safe cutover bound. No partial activation is permitted." } });
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  if (["40001", "40P01", "55P03", "57014", "INVENTORY_PUBLICATION_TARGET_BUSY", "QUANTITY_PUBLICATION_DRAIN_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY"].includes(code ?? "")) {
    return res.status(409).json({ error: { code: "CUTOVER_CONCURRENT_CHANGE", message: "Another inventory operation was in flight. Retry the complete command with the same key; stale review evidence must be refreshed." } });
  }
  console.error(JSON.stringify({ event: "inventory_cutover_command_failed", code: code && /^[A-Z0-9_]{1,100}$/.test(code) ? code : "UNKNOWN",
    errorType: error instanceof Error ? error.name : "UnknownError" }));
  return res.status(500).json({ error: { code: "CUTOVER_COMMAND_FAILED", message: "The cutover command failed. No success is being reported; check the durable run status before retrying with the same key." } });
}
