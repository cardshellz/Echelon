import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierProgressCommandSchema, supplierProgressSchema } from "@shared/procurement/purchase-pipeline";
import { PurchasePipelineError } from "./purchase-pipeline.service";
import type { PipelineDatabase } from "./purchase-pipeline.repository";
import { SupplierProgressRepository } from "./supplier-progress.repository";

export const pipelineLineIdSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
export function createSupplierProgressService(database: PipelineDatabase, clock: () => Date) {
  const repository = new SupplierProgressRepository(database);
  return {
    async update(lineId: number, raw: unknown, actorId: unknown) {
      if (!Number.isInteger(lineId) || lineId < 1 || lineId > 2_147_483_647) throw new PurchasePipelineError("PIPELINE_LINE_INVALID", "Select an exact purchase line.", 400);
      const parsed = supplierProgressCommandSchema.safeParse(raw);
      if (!parsed.success) throw new PurchasePipelineError("SUPPLIER_PROGRESS_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), 400);
      if (typeof actorId !== "string" || !actorId.trim() || actorId.length > 255) throw new PurchasePipelineError("SUPPLIER_PROGRESS_ACTOR_REQUIRED", "An authenticated operator is required.", 403);
      const command = parsed.data;
      const requestHash = createHash("sha256").update(canonicalJson({ lineId, actorId, expectedRevision: command.expectedRevision, report: command.report })).digest("hex");
      return repository.transaction(async (tx) => {
        const replay = await tx.findReplay(command.idempotencyKey);
        if (replay) {
          if (replay.hash !== requestHash) throw new PurchasePipelineError("SUPPLIER_PROGRESS_IDEMPOTENCY_CONFLICT", "This request key was already used for another progress change.", 409);
          return { ...replay.progress, reused: true };
        }
        const line = await tx.lockLine(lineId);
        if (!line) throw new PurchasePipelineError("PIPELINE_LINE_NOT_FOUND", "The purchase line does not exist.", 404);
        if (line.lineType !== "product" || !["approved", "sent", "acknowledged", "partially_received"].includes(line.purchaseStatus) || ["received", "cancelled", "closed"].includes(line.status)) throw new PurchasePipelineError("SUPPLIER_PROGRESS_LINE_INACTIVE", "Progress can be recorded only for an active committed product purchase.", 409);
        const current = await tx.current(lineId);
        if (current.revision !== command.expectedRevision) throw new PurchasePipelineError("SUPPLIER_PROGRESS_CHANGED", "Supplier progress changed. Reload and review the current report before saving.", 409);
        if (current.revision >= 2_147_483_647) throw new PurchasePipelineError("SUPPLIER_PROGRESS_REVISION_LIMIT", "The progress revision limit has been reached.", 409);
        if (line.cancelled > line.ordered || command.report.startedPieces > line.ordered - line.cancelled) throw new PurchasePipelineError("SUPPLIER_PROGRESS_QUANTITY_EXCEEDED", "Reported progress cannot exceed ordered pieces after cancellations.", 422);
        const at = clock();
        if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new PurchasePipelineError("SUPPLIER_PROGRESS_CLOCK_INVALID", "Progress recording time is invalid.", 500);
        if (new Date(command.report.asOf).getTime() > at.getTime()) throw new PurchasePipelineError("SUPPLIER_PROGRESS_DATE_INVALID", "Supplier progress cannot be reported as of a future time.", 422);
        const next = supplierProgressSchema.parse({ revision: current.revision + 1, report: command.report, recordedBy: actorId, recordedAt: at.toISOString() });
        await tx.save({ lineId, key: command.idempotencyKey, hash: requestHash, before: current.report, next, at });
        return { ...next, reused: false };
      });
    },
  };
}
